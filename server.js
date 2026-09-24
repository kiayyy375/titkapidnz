const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

app.disable("x-powered-by");
app.use(express.json());

/* =========================================================
 * CONFIG
 * ========================================================= */

const PORT = Number(process.env.PORT || 3000);

const MAX_UPLOAD_MB = Number(
  process.env.MAX_UPLOAD_MB || 500
);

const RESULT_TTL_MINUTES = Number(
  process.env.RESULT_TTL_MINUTES || 10
);

const MAX_CONCURRENT_ENCODES = Number(
  process.env.MAX_CONCURRENT_ENCODES || 1
);

const FFMPEG_TIMEOUT_MINUTES = Number(
  process.env.FFMPEG_TIMEOUT_MINUTES || 15
);

const WORK_DIR =
  process.env.WORK_DIR ||
  "/tmp/danzclean-tiktok";

const INPUT_DIR = path.join(
  WORK_DIR,
  "input"
);

const OUTPUT_DIR = path.join(
  WORK_DIR,
  "output"
);

/* =========================================================
 * DIRECTORIES
 * ========================================================= */

fs.mkdirSync(INPUT_DIR, {
  recursive: true
});

fs.mkdirSync(OUTPUT_DIR, {
  recursive: true
});

/* =========================================================
 * STATE
 * ========================================================= */

let activeEncodes = 0;

/* =========================================================
 * ALLOWED EXTENSIONS
 * ========================================================= */

const allowedExt = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi"
]);

/* =========================================================
 * MULTER
 * ========================================================= */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, INPUT_DIR);
  },

  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();

    const ext =
      path.extname(
        file.originalname || ""
      ).toLowerCase() || ".mp4";

    cb(
      null,
      `${id}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize:
      MAX_UPLOAD_MB * 1024 * 1024
  },

  fileFilter: (
    _req,
    file,
    cb
  ) => {
    const ext =
      path.extname(
        file.originalname || ""
      ).toLowerCase();

    if (!allowedExt.has(ext)) {
      return cb(
        new Error(
          `Unsupported file type: ${
            ext || "unknown"
          }`
        )
      );
    }

    cb(null, true);
  }
});

/* =========================================================
 * BASE URL
 * ========================================================= */

function getBaseUrl(req) {
  const forwardedProto =
    req.get("x-forwarded-proto");

  const protocol = forwardedProto
    ? forwardedProto
        .split(",")[0]
        .trim()
    : req.protocol;

  return `${protocol}://${req.get("host")}`;
}

/* =========================================================
 * RUN COMMAND
 * ========================================================= */

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const timeoutMs =
        Number(
          options.timeoutMs ||
          FFMPEG_TIMEOUT_MINUTES *
            60 *
            1000
        );

      const child = spawn(
        command,
        args,
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer =
        setTimeout(() => {
          timedOut = true;

          console.error(
            `[PROCESS] ${command} timeout`
          );

          try {
            child.kill("SIGKILL");
          } catch {}
        }, timeoutMs);

      child.stdout.on(
        "data",
        (data) => {
          stdout +=
            data.toString();
        }
      );

      child.stderr.on(
        "data",
        (data) => {
          const chunk =
            data.toString();

          stderr += chunk;

          /*
           * Tetap tampilkan progress FFmpeg
           * di Railway log.
           */
          process.stdout.write(
            chunk
          );
        }
      );

      child.on(
        "error",
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );

      child.on(
        "close",
        (code, signal) => {
          clearTimeout(timer);

          if (code === 0) {
            return resolve({
              stdout,
              stderr,
              code,
              signal: null,
              timedOut: false
            });
          }

          const error =
            new Error(
              timedOut
                ? "FFmpeg timeout"
                : signal
                  ? `FFmpeg terminated by signal ${signal}`
                  : `FFmpeg exited with code ${code}`
            );

          error.code =
            code;

          error.signal =
            signal;

          error.stderr =
            stderr;

          error.stdout =
            stdout;

          error.timedOut =
            timedOut;

          reject(error);
        }
      );
    }
  );
}

/* =========================================================
 * X264 PARAMETERS
 *
 * Mengikuti parameter yang terlihat dari MediaInfo Forge.
 *
 * Sengaja TIDAK memasukkan:
 *   direct=1
 *   ip-ratio=1.40
 *   chroma-qp-offset=-2
 *
 * Karena x264 sudah menghasilkan nilai tersebut secara default.
 *
 * threads=4 + lookahead-threads=1:
 * untuk mencegah Railway memakai puluhan thread.
 * ========================================================= */

const X264_PARAMS = [
  "ref=1",
  "bframes=2",
  "b-pyramid=0",
  "b-adapt=1",
  "b-bias=0",

  "weightb=1",
  "weightp=2",

  "open-gop=0",

  "keyint=30",
  "min-keyint=15",
  "scenecut=40",

  "intra-refresh=0",

  "rc-lookahead=40",
  "mbtree=1",

  "qcomp=0.60",

  "qpmin=0",
  "qpmax=69",
  "qpstep=4",

  "vbv-maxrate=300000",
  "vbv-bufsize=300000",

  "crf-max=0.0",

  "nal-hrd=none",
  "filler=0",

  "aq-mode=1",
  "aq-strength=1.0",

  "me=hex",
  "subme=7",
  "me-range=16",
  "chroma-me=1",

  "trellis=1",
  "8x8dct=1",
  "fast-pskip=1",

  /*
   * Batas resource Railway
   */
  "threads=4",
  "lookahead-threads=1"
].join(":");

/* =========================================================
 * ROOT
 * ========================================================= */

app.get(
  "/",
  (_req, res) => {
    res.json({
      name:
        "DanzClean TikTok Forge API",

      version:
        "1.4",

      status:
        "online",

      encoding: {
        codec: "H.264",
        profile: "High",
        level: "5.2",
        fps: "passthrough",
        audioTracks: 2,
        audioCodec: "AAC",
        audioBitrate: "325k",
        audioSampleRate: "48000",
        audioChannels: 2,

        x264Threads: 4,
        lookaheadThreads: 1
      },

      usage: {
        method: "POST",
        endpoint:
          "/api/encode",
        field:
          "video"
      }
    });
  }
);

/* =========================================================
 * HEALTH
 * ========================================================= */

app.get(
  "/api/health",
  async (_req, res) => {
    try {
      const result =
        await runCommand(
          "ffmpeg",
          [
            "-version"
          ],
          {
            timeoutMs: 30000
          }
        );

      res.json({
        ok: true,

        ffmpeg:
          result.stdout
            .split("\n")[0],

        activeEncodes,

        maxConcurrentEncodes:
          MAX_CONCURRENT_ENCODES,

        workDir:
          WORK_DIR
      });

    } catch (error) {
      res.status(503).json({
        ok: false,

        error:
          "FFmpeg unavailable",

        detail:
          error.message
      });
    }
  }
);

/* =========================================================
 * ENCODE
 *
 * POST /api/encode
 *
 * multipart/form-data
 * field: video
 *
 * Upload -> encode -> response download URL
 * ========================================================= */

app.post(
  "/api/encode",
  upload.single("video"),

  async (req, res) => {

    /*
     * Cek file
     */
    if (!req.file) {
      return res.status(400).json({
        ok: false,

        error:
          'Missing video file. Use multipart/form-data field "video".'
      });
    }

    /*
     * Jangan menerima encode terlalu banyak
     * bersamaan di Railway.
     */
    if (
      activeEncodes >=
      MAX_CONCURRENT_ENCODES
    ) {
      try {
        await fsp.unlink(
          req.file.path
        );
      } catch {}

      return res.status(429).json({
        ok: false,

        error:
          "Encoder is busy. Try again later.",

        activeEncodes,

        maxConcurrentEncodes:
          MAX_CONCURRENT_ENCODES
      });
    }

    activeEncodes++;

    const inputPath =
      req.file.path;

    const id =
      path
        .basename(
          req.file.filename
        )
        .split(".")[0];

    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    try {

      console.log(
        "========================================"
      );

      console.log(
        "[ENCODE] New request"
      );

      console.log(
        `[ENCODE] File: ${req.file.originalname}`
      );

      console.log(
        `[ENCODE] Input: ${inputPath}`
      );

      console.log(
        `[ENCODE] Output: ${outputPath}`
      );

      console.log(
        `[ENCODE] Active: ${activeEncodes}/${MAX_CONCURRENT_ENCODES}`
      );

      /*
       * =====================================================
       * FFMPEG
       * =====================================================
       */

      const args = [
        "-hide_banner",
        "-y",

        /*
         * INPUT
         */
        "-i",
        inputPath,

        /*
         * ===================================================
         * VIDEO
         * ===================================================
         */

        "-map",
        "0:v:0",

        /*
         * ===================================================
         * AUDIO
         *
         * Audio pertama dibuat menjadi 2 track.
         *
         * 0:a:0 -> audio 1
         * 0:a:0 -> audio 2
         * ===================================================
         */

        "-map",
        "0:a:0?",

        "-map",
        "0:a:0?",

        /*
         * ===================================================
         * VIDEO ENCODER
         * ===================================================
         */

        "-c:v",
        "libx264",

        "-profile:v",
        "high",

        "-level:v",
        "5.2",

        "-pix_fmt",
        "yuv420p",

        "-tag:v",
        "avc1",

        /*
         * MediaInfo target menggunakan
         * parameter encoder yang dekat dengan
         * preset medium.
         */
        "-preset",
        "medium",

        "-crf",
        "22",

        /*
         * x264 options
         */
        "-x264-params",
        X264_PARAMS,

        /*
         * PENTING:
         * Paksa thread video.
         *
         * Ini sebagai pengaman tambahan karena
         * log sebelumnya menunjukkan:
         *
         * threads=72
         */
        "-threads:v",
        "4",

        /*
         * Pertahankan FPS input.
         */
        "-fps_mode",
        "passthrough",

        /*
         * ===================================================
         * AUDIO
         * ===================================================
         *
         * Dua audio track.
         */
        "-c:a",
        "aac",

        "-b:a",
        "325k",

        "-ar",
        "48000",

        "-ac",
        "2",

        /*
         * Metadata audio.
         */
        "-metadata:s:a:0",
        "title=Stereo",

        "-metadata:s:a:1",
        "title=Stereo",

        /*
         * ===================================================
         * MP4
         * ===================================================
         */

        "-movflags",
        "+faststart",

        /*
         * Output
         */
        outputPath
      ];

      console.log(
        "[ENCODE] FFmpeg starting..."
      );

      /*
       * Jalankan FFmpeg
       */
      const result =
        await runCommand(
          "ffmpeg",
          args
        );

      /*
       * Pastikan output benar-benar ada
       */
      const stat =
        await fsp.stat(
          outputPath
        );

      if (
        !stat.isFile() ||
        stat.size <= 0
      ) {
        throw new Error(
          "FFmpeg finished but output file is empty."
        );
      }

      /*
       * Download URL
       */
      const downloadUrl =
        `${getBaseUrl(req)}/api/encode/download/${id}`;

      console.log(
        `[ENCODE] Finished successfully`
      );

      console.log(
        `[ENCODE] Output size: ${stat.size} bytes`
      );

      console.log(
        `[ENCODE] Download: ${downloadUrl}`
      );

      /*
       * ===================================================
       * CLEANUP
       * ===================================================
       */

      setTimeout(
        async () => {

          try {
            await fsp.unlink(
              inputPath
            );

            console.log(
              `[CLEANUP] Deleted input: ${inputPath}`
            );
          } catch {}

          try {
            await fsp.unlink(
              outputPath
            );

            console.log(
              `[CLEANUP] Deleted output: ${outputPath}`
            );
          } catch {}

        },

        RESULT_TTL_MINUTES *
          60 *
          1000
      );

      /*
       * ===================================================
       * RESPONSE
       * ===================================================
       */

      return res.json({
        ok: true,

        filename:
          `${path.parse(req.file.originalname).name}-danzclean-forge.mp4`,

        sizeBytes:
          stat.size,

        sizeMB:
          Number(
            (
              stat.size /
              1024 /
              1024
            ).toFixed(2)
          ),

        download:
          downloadUrl,

        expiresInMinutes:
          RESULT_TTL_MINUTES
      });

    } catch (error) {

      /*
       * ===================================================
       * ERROR CLEANUP
       * ===================================================
       */

      try {
        await fsp.unlink(
          inputPath
        );
      } catch {}

      try {
        await fsp.unlink(
          outputPath
        );
      } catch {}

      /*
       * ===================================================
       * ERROR DETAIL
       * ===================================================
       */

      let detail =
        error.stderr ||
        error.message ||
        "Unknown error";

      /*
       * Potong log supaya response tidak
       * terlalu besar.
       */
      detail =
        detail.slice(-8000);

      console.error(
        "========================================"
      );

      console.error(
        "[FFMPEG ERROR]"
      );

      console.error(
        `message: ${error.message}`
      );

      console.error(
        `code: ${error.code ?? "null"}`
      );

      console.error(
        `signal: ${error.signal ?? "null"}`
      );

      console.error(
        `timeout: ${error.timedOut ? "yes" : "no"}`
      );

      console.error(
        detail
      );

      console.error(
        "========================================"
      );

      return res.status(500).json({
        ok: false,

        error:
          "FFmpeg encode failed",

        message:
          error.message,

        code:
          error.code ?? null,

        signal:
          error.signal ?? null,

        timeout:
          Boolean(
            error.timedOut
          ),

        detail
      });

    } finally {

      activeEncodes--;

      console.log(
        `[ENCODE] Active after request: ${activeEncodes}`
      );
    }
  }
);

/* =========================================================
 * DOWNLOAD
 * ========================================================= */

app.get(
  "/api/encode/download/:id",
  async (req, res) => {

    /*
     * basename mencegah
     * path traversal.
     */
    const id =
      path.basename(
        req.params.id
      );

    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    try {

      await fsp.access(
        outputPath,
        fs.constants.R_OK
      );

      return res.download(
        outputPath,
        `danzclean-forge-${id}.mp4`
      );

    } catch {

      return res.status(404).json({
        ok: false,

        error:
          "Result not found or expired"
      });
    }
  }
);

/* =========================================================
 * OPTIONAL: LIST OUTPUT
 * ========================================================= */

app.get(
  "/api/status",
  (_req, res) => {
    res.json({
      ok: true,

      activeEncodes,

      maxConcurrentEncodes:
        MAX_CONCURRENT_ENCODES,

      resultTtlMinutes:
        RESULT_TTL_MINUTES,

      ffmpegTimeoutMinutes:
        FFMPEG_TIMEOUT_MINUTES
    });
  }
);

/* =========================================================
 * MULTER / GENERAL ERROR
 * ========================================================= */

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {

    if (
      err instanceof
      multer.MulterError
    ) {

      if (
        err.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(413).json({
          ok: false,

          error:
            `File too large. Maximum is ${MAX_UPLOAD_MB} MB.`
        });
      }

      return res.status(400).json({
        ok: false,

        error:
          err.message
      });
    }

    if (err) {

      return res.status(400).json({
        ok: false,

        error:
          err.message
      });
    }

    return res.status(500).json({
      ok: false,

      error:
        "Internal server error"
    });
  }
);

/* =========================================================
 * 404
 * ========================================================= */

app.use(
  (_req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Route not found"
    });
  }
);

/* =========================================================
 * START SERVER
 * ========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "DanzClean TikTok Forge API"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Max upload: ${MAX_UPLOAD_MB} MB`
    );

    console.log(
      `Result TTL: ${RESULT_TTL_MINUTES} minutes`
    );

    console.log(
      `Max concurrent encodes: ${MAX_CONCURRENT_ENCODES}`
    );

    console.log(
      `FFmpeg timeout: ${FFMPEG_TIMEOUT_MINUTES} minutes`
    );

    console.log(
      "x264 threads: 4"
    );

    console.log(
      "x264 lookahead threads: 1"
    );

    console.log(
      "========================================"
    );
  }
);

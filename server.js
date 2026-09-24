const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const RESULT_TTL_MINUTES = Number(process.env.RESULT_TTL_MINUTES || 10);
const WORK_DIR = process.env.WORK_DIR || "/tmp/danzclean-tiktok";

const INPUT_DIR = path.join(WORK_DIR, "input");
const OUTPUT_DIR = path.join(WORK_DIR, "output");

fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const allowedExt = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, INPUT_DIR);
  },

  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext =
      path.extname(file.originalname || "").toLowerCase() || ".mp4";

    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024
  },

  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    if (!allowedExt.has(ext)) {
      return cb(
        new Error(
          `Unsupported file type: ${ext || "unknown"}`
        )
      );
    }

    cb(null, true);
  }
});

function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");

  const protocol = (
    forwardedProto
      ? forwardedProto.split(",")[0].trim()
      : req.protocol
  );

  return `${protocol}://${req.get("host")}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        return resolve({
          stdout,
          stderr
        });
      }

      const error = new Error(
        signal
          ? `FFmpeg terminated by signal ${signal}`
          : `FFmpeg exited with code ${code}`
      );

      error.code = code;
      error.signal = signal;
      error.stderr = stderr;

      reject(error);
    });
  });
}

/*
 * Forge-style x264 parameters
 * berdasarkan MediaInfo hasil Vague Forge
 */
const X264_PARAMS = [
  "ref=1",
  "bframes=2",
  "b-pyramid=0",
  "b-adapt=1",
  "b-bias=0",
  "direct=1",
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
  "ip-ratio=1.40",
  "aq-mode=1",
  "aq-strength=1.0",
  "me=hex",
  "subme=7",
  "me-range=16",
  "chroma-me=1",
  "trellis=1",
  "8x8dct=1",
  "fast-pskip=1",
  "chroma-qp-offset=-2",

  // Biar lebih aman untuk Railway
  "threads=4",
  "lookahead-threads=1"
].join(":");


/*
 * ROOT
 */
app.get("/", (_req, res) => {
  res.json({
    name: "DanzClean TikTok Forge API",
    version: "1.2",
    status: "online",

    usage: {
      method: "POST",
      endpoint: "/api/encode",
      field: "video"
    }
  });
});


/*
 * HEALTH CHECK
 */
app.get("/api/health", async (_req, res) => {
  try {
    const result = await runCommand("ffmpeg", [
      "-version"
    ]);

    res.json({
      ok: true,
      ffmpeg: result.stdout.split("\n")[0]
    });

  } catch (error) {
    res.status(503).json({
      ok: false,
      error: "FFmpeg unavailable",
      detail: error.message
    });
  }
});


/*
 * UPLOAD → ENCODE → RETURN DOWNLOAD LINK
 *
 * Tidak perlu:
 * - mode
 * - polling
 * - job ID dari sisi client
 */
app.post(
  "/api/encode",
  upload.single("video"),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error:
          'Missing video file. Use multipart/form-data field "video".'
      });
    }

    const inputPath = req.file.path;

    const id = path
      .basename(req.file.filename)
      .split(".")[0];

    const outputPath = path.join(
      OUTPUT_DIR,
      `${id}.mp4`
    );

    /*
     * Hanya audio pertama:
     *
     * 0:a:0?
     *
     * Karena file contoh kamu memiliki 2 audio,
     * dan audio kedua menghasilkan:
     *
     * "Invalid data found when processing input"
     */
    const args = [
      "-hide_banner",
      "-y",

      "-i",
      inputPath,

      /*
       * VIDEO
       */
      "-map",
      "0:v:0",

      /*
       * AUDIO PERTAMA SAJA
       */
      "-map",
      "0:a:0?",

      /*
       * H.264
       */
      "-c:v",
      "libx264",

      "-profile:v",
      "high",

      "-level:v",
      "5.2",

      "-pix_fmt",
      "yuv420p",

      "-preset",
      "medium",

      "-crf",
      "22",

      "-x264-params",
      X264_PARAMS,

      /*
       * Jangan memaksa FPS tertentu.
       * Pertahankan FPS input.
       */
      "-fps_mode",
      "passthrough",

      /*
       * AUDIO
       *
       * Copy audio pertama supaya tidak
       * re-encode dan lebih dekat ke Forge.
       */
      "-c:a",
      "copy",

      /*
       * MP4
       */
      "-movflags",
      "+faststart",

      outputPath
    ];

    try {

      console.log(
        `[ENCODE] Starting: ${req.file.originalname}`
      );

      console.log(
        `[ENCODE] Input: ${inputPath}`
      );

      console.log(
        `[ENCODE] Output: ${outputPath}`
      );

      const result = await runCommand(
        "ffmpeg",
        args
      );

      const stat = await fsp.stat(
        outputPath
      );

      const downloadUrl =
        `${getBaseUrl(req)}/api/encode/download/${id}`;

      console.log(
        `[ENCODE] Finished: ${req.file.originalname}`
      );

      console.log(
        `[ENCODE] Output size: ${stat.size} bytes`
      );

      /*
       * Auto delete setelah TTL
       */
      setTimeout(async () => {

        try {
          await fsp.unlink(inputPath);
          console.log(
            `[CLEANUP] Deleted input: ${inputPath}`
          );
        } catch {}

        try {
          await fsp.unlink(outputPath);
          console.log(
            `[CLEANUP] Deleted output: ${outputPath}`
          );
        } catch {}

      }, RESULT_TTL_MINUTES * 60 * 1000);


      /*
       * RETURN LINK
       */
      return res.json({
        ok: true,

        filename:
          `${path.parse(req.file.originalname).name}-danzclean-forge.mp4`,

        sizeBytes:
          stat.size,

        download:
          downloadUrl
      });


    } catch (error) {

      /*
       * Cleanup kalau gagal
       */
      try {
        await fsp.unlink(inputPath);
      } catch {}

      try {
        await fsp.unlink(outputPath);
      } catch {}


      /*
       * Ambil error FFmpeg
       */
      const detail =
        error.stderr
          ? error.stderr.slice(-5000)
          : error.message;


      console.error(
        "[FFMPEG ERROR]"
      );

      console.error(
        detail
      );


      return res.status(500).json({
        ok: false,

        error:
          "FFmpeg encode failed",

        detail:
          detail
      });
    }
  }
);


/*
 * DOWNLOAD RESULT
 */
app.get(
  "/api/encode/download/:id",
  async (req, res) => {

    /*
     * basename mencegah path traversal
     */
    const id =
      path.basename(req.params.id);

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


/*
 * MULTER / GENERAL ERROR
 */
app.use(
  (err, _req, res, _next) => {

    if (
      err instanceof multer.MulterError
    ) {

      if (
        err.code === "LIMIT_FILE_SIZE"
      ) {

        return res.status(413).json({
          ok: false,

          error:
            `File too large. Maximum is ${MAX_UPLOAD_MB} MB.`
        });
      }

      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }


    if (err) {

      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }


    return res.status(500).json({
      ok: false,
      error:
        "Internal server error"
    });
  }
);


/*
 * START SERVER
 */
app.listen(
  PORT,
  () => {

    console.log(
      `DanzClean TikTok Forge API running on port ${PORT}`
    );

    console.log(
      `Max upload: ${MAX_UPLOAD_MB} MB`
    );

    console.log(
      `Result TTL: ${RESULT_TTL_MINUTES} minutes`
    );
  }
);

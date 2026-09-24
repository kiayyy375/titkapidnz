const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

app.disable("x-powered-by");


// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const MAX_UPLOAD_MB =
  Number(process.env.MAX_UPLOAD_MB || 500);

const RESULT_TTL_MINUTES =
  Number(process.env.RESULT_TTL_MINUTES || 10);

const WORK_DIR =
  process.env.WORK_DIR ||
  "/tmp/danzclean-tiktok";

const INPUT_DIR =
  path.join(WORK_DIR, "input");

const OUTPUT_DIR =
  path.join(WORK_DIR, "output");


// ============================================================
// PREPARE DIRECTORIES
// ============================================================

fs.mkdirSync(INPUT_DIR, {
  recursive: true
});

fs.mkdirSync(OUTPUT_DIR, {
  recursive: true
});


// ============================================================
// ALLOWED VIDEO EXTENSIONS
// ============================================================

const allowedExt = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi"
]);


// ============================================================
// MULTER STORAGE
// ============================================================

const storage = multer.diskStorage({

  destination: (_req, _file, cb) => {
    cb(null, INPUT_DIR);
  },

  filename: (_req, file, cb) => {

    const id =
      crypto.randomUUID();

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


// ============================================================
// MULTER UPLOAD
// ============================================================

const upload = multer({

  storage,

  limits: {
    fileSize:
      MAX_UPLOAD_MB * 1024 * 1024
  },

  fileFilter: (_req, file, cb) => {

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


// ============================================================
// BASE URL
// ============================================================

function getBaseUrl(req) {

  const forwardedProto =
    req.get("x-forwarded-proto");

  const protocol =
    (
      forwardedProto
        ? forwardedProto
            .split(",")[0]
            .trim()
        : req.protocol
    );

  return `${protocol}://${req.get("host")}`;
}


// ============================================================
// RUN COMMAND
// ============================================================

function runCommand(
  command,
  args
) {

  return new Promise(
    (resolve, reject) => {

      const child =
        spawn(
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

          stderr +=
            data.toString();

        }
      );


      child.on(
        "error",
        (error) => {

          reject(error);

        }
      );


      child.on(
        "close",
        (code, signal) => {

          if (code === 0) {

            return resolve({
              stdout,
              stderr
            });

          }


          const error =
            new Error(
              signal
                ? `FFmpeg terminated by signal ${signal}`
                : `FFmpeg exited with code ${code}`
            );


          error.code =
            code;

          error.signal =
            signal;

          error.stderr =
            stderr;


          reject(error);

        }
      );

    }
  );

}


// ============================================================
// X264 PARAMETERS
//
// Berdasarkan MediaInfo hasil Vague Forge:
//
// ref=1
// bframes=2
// b-pyramid=0
// b-adapt=1
// keyint=30
// min-keyint=15
// scenecut=40
// rc-lookahead=40
// rc=crf
// crf=22
// qcomp=0.60
// aq=1:1.00
// me=hex
// subme=7
//
// CHROMA QP OFFSET SENGAJA TIDAK DITULIS.
// Pada test sebelumnya, memasukkan -2 menghasilkan
// MediaInfo -4. Kita biarkan x264 memakai default-nya.
// ============================================================

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

  "fast-pskip=1"

].join(":");


// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (_req, res) => {

    res.json({

      name:
        "DanzClean TikTok Forge API",

      version:
        "1.3",

      status:
        "online",

      usage: {

        method:
          "POST",

        endpoint:
          "/api/encode",

        field:
          "video"

      }

    });

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  async (_req, res) => {

    try {

      const result =
        await runCommand(
          "ffmpeg",
          ["-version"]
        );


      res.json({

        ok:
          true,

        ffmpeg:
          result.stdout
            .split("\n")[0]

      });

    }
    catch (error) {

      res.status(503).json({

        ok:
          false,

        error:
          "FFmpeg unavailable",

        detail:
          error.message

      });

    }

  }
);


// ============================================================
// UPLOAD → FFMPEG → DOWNLOAD LINK
//
// Tidak perlu mode.
// Tidak perlu polling.
// Tidak perlu kirim job ID.
// ============================================================

app.post(
  "/api/encode",

  upload.single("video"),

  async (req, res) => {

    // --------------------------------------------------------
    // CHECK FILE
    // --------------------------------------------------------

    if (!req.file) {

      return res.status(400).json({

        ok:
          false,

        error:
          'Missing video file. Use multipart/form-data field "video".'

      });

    }


    // --------------------------------------------------------
    // PATHS
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // FFMPEG
    // --------------------------------------------------------

    const args = [

      "-hide_banner",

      "-y",

      "-i",
      inputPath,


      // ======================================================
      // VIDEO
      // ======================================================

      "-map",
      "0:v:0",


      // ======================================================
      // AUDIO
      //
      // Ambil audio pertama dua kali.
      //
      // Tujuannya mendekati hasil Vague yang memiliki
      // dua audio AAC 325 kbps.
      //
      // Kalau input tidak memiliki audio, tanda ? membuat
      // proses tetap bisa berjalan tanpa audio.
      // ======================================================

      "-map",
      "0:a:0?",

      "-map",
      "0:a:0?",


      // ======================================================
      // VIDEO ENCODER
      // ======================================================

      "-c:v",
      "libx264",

      "-profile:v",
      "high",

      "-level:v",
      "5.2",

      "-tag:v",
      "avc1",

      "-pix_fmt",
      "yuv420p",

      "-preset",
      "medium",

      "-crf",
      "22",

      "-x264-params",
      X264_PARAMS,


      // ======================================================
      // FRAME RATE
      //
      // Tidak memaksa 60 FPS.
      // FPS input dipertahankan.
      // ======================================================

      "-fps_mode",
      "passthrough",


      // ======================================================
      // AUDIO
      //
      // Vague sample:
      // AAC LC
      // 325 kbps
      // 48 kHz
      // 2 channel
      // ======================================================

      "-c:a",
      "aac",

      "-b:a",
      "325k",

      "-ar",
      "48000",

      "-ac",
      "2",


      // ======================================================
      // AUDIO METADATA
      // ======================================================

      "-metadata:s:a:0",
      "title=Stereo",

      "-metadata:s:a:1",
      "title=Stereo",


      // ======================================================
      // MP4
      // ======================================================

      "-movflags",
      "+faststart",


      outputPath

    ];


    // --------------------------------------------------------
    // START ENCODE
    // --------------------------------------------------------

    try {

      console.log(
        "=========================================="
      );

      console.log(
        "[DANZCLEAN] Encode started"
      );

      console.log(
        "[DANZCLEAN] Input:",
        req.file.originalname
      );

      console.log(
        "[DANZCLEAN] Size:",
        req.file.size,
        "bytes"
      );


      const result =
        await runCommand(
          "ffmpeg",
          args
        );


      // ------------------------------------------------------
      // CHECK OUTPUT
      // ------------------------------------------------------

      const stat =
        await fsp.stat(
          outputPath
        );


      // ------------------------------------------------------
      // DOWNLOAD URL
      // ------------------------------------------------------

      const downloadUrl =
        `${getBaseUrl(req)}/api/encode/download/${id}`;


      console.log(
        "[DANZCLEAN] Encode finished"
      );

      console.log(
        "[DANZCLEAN] Output:",
        stat.size,
        "bytes"
      );

      console.log(
        "[DANZCLEAN] Download:",
        downloadUrl
      );


      // ------------------------------------------------------
      // AUTO DELETE
      // ------------------------------------------------------

      setTimeout(
        async () => {

          try {

            await fsp.unlink(
              inputPath
            );

            console.log(
              "[CLEANUP] Input deleted"
            );

          }
          catch {}


          try {

            await fsp.unlink(
              outputPath
            );

            console.log(
              "[CLEANUP] Output deleted"
            );

          }
          catch {}

        },

        RESULT_TTL_MINUTES *
        60 *
        1000
      );


      // ------------------------------------------------------
      // RESPONSE
      // ------------------------------------------------------

      return res.json({

        ok:
          true,

        filename:
          `${path.parse(
            req.file.originalname
          ).name}-danzclean-forge.mp4`,

        sizeBytes:
          stat.size,

        download:
          downloadUrl

      });

    }
    catch (error) {

      // ------------------------------------------------------
      // DELETE FAILED FILES
      // ------------------------------------------------------

      try {

        await fsp.unlink(
          inputPath
        );

      }
      catch {}


      try {

        await fsp.unlink(
          outputPath
        );

      }
      catch {}


      // ------------------------------------------------------
      // FFMPEG ERROR
      // ------------------------------------------------------

      const detail =
        error.stderr
          ? error.stderr.slice(-5000)
          : error.message;


      console.error(
        "=========================================="
      );

      console.error(
        "[DANZCLEAN] FFMPEG ERROR"
      );

      console.error(
        detail
      );


      return res.status(500).json({

        ok:
          false,

        error:
          "FFmpeg encode failed",

        detail:
          detail

      });

    }

  }
);


// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  "/api/encode/download/:id",

  async (req, res) => {

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

    }
    catch {

      return res.status(404).json({

        ok:
          false,

        error:
          "Result not found or expired"

      });

    }

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (err, _req, res, _next) => {

    // --------------------------------------------------------
    // FILE TOO LARGE
    // --------------------------------------------------------

    if (
      err instanceof multer.MulterError
    ) {

      if (
        err.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res.status(413).json({

          ok:
            false,

          error:
            `File too large. Maximum is ${MAX_UPLOAD_MB} MB.`

        });

      }


      return res.status(400).json({

        ok:
          false,

        error:
          err.message

      });

    }


    // --------------------------------------------------------
    // OTHER ERROR
    // --------------------------------------------------------

    if (err) {

      return res.status(400).json({

        ok:
          false,

        error:
          err.message

      });

    }


    return res.status(500).json({

      ok:
        false,

      error:
        "Internal server error"

    });

  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      "=========================================="
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
      "=========================================="
    );

  }
);

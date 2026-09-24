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
// DIRECTORIES
// ============================================================

fs.mkdirSync(INPUT_DIR, {
  recursive: true
});

fs.mkdirSync(OUTPUT_DIR, {
  recursive: true
});


// ============================================================
// ALLOWED FILES
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
// MULTER
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
// COMMAND RUNNER
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
        data => {

          stdout +=
            data.toString();

        }
      );


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();

        }
      );


      child.on(
        "error",
        error => {

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
// Disesuaikan dengan MediaInfo Vague Forge.
//
// direct dan ip-ratio TIDAK dipaksa karena x264 sudah
// menggunakan:
// direct=1
// ip_ratio=1.40
//
// chroma_qp_offset juga dibiarkan default agar hasil log
// tetap -2 seperti target Vague.
// ============================================================

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
        "1.4",

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
// ENCODE
// ============================================================

app.post(
  "/api/encode",

  upload.single("video"),

  async (req, res) => {

    // --------------------------------------------------------
    // CHECK UPLOAD
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
    // FILE PATH
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


    // ========================================================
    // FFMPEG COMMAND
    // ========================================================

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
      // AUDIO #1
      // ======================================================

      "-map",
      "0:a:0?",


      // ======================================================
      // AUDIO #2
      //
      // Menggunakan audio pertama sebagai sumber track kedua.
      // ======================================================

      "-map",
      "0:a:0?",


      // ======================================================
      // VIDEO ENCODING
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
      // FPS
      // ======================================================

      "-fps_mode",
      "passthrough",


      // ======================================================
      // AUDIO
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


    // ========================================================
    // START
    // ========================================================

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
        "[DANZCLEAN] Input size:",
        req.file.size,
        "bytes"
      );


      const result =
        await runCommand(
          "ffmpeg",
          args
        );


      // ------------------------------------------------------
      // OUTPUT CHECK
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
        "[DANZCLEAN] Encode completed"
      );

      console.log(
        "[DANZCLEAN] Output size:",
        stat.size,
        "bytes"
      );


      // ------------------------------------------------------
      // AUTO CLEANUP
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
      // CLEAN FAILED FILE
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
      // ERROR DETAIL
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
      "DanzClean TikTok Forge API v1.4"
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

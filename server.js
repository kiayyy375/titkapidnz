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
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));

const WORK_DIR = process.env.WORK_DIR || "/tmp/danzclean-tiktok";
const INPUT_DIR = path.join(WORK_DIR, "input");
const OUTPUT_DIR = path.join(WORK_DIR, "output");

const jobs = new Map();
const queue = [];
let activeJobs = 0;

fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const allowedExt = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INPUT_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname || "").toLowerCase() || ".mp4";
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!allowedExt.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext || "unknown"}`));
    }
    cb(null, true);
  }
});

function publicBase(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function getJob(id) {
  return jobs.get(id);
}

function jobResponse(req, job) {
  const base = publicBase(req);
  return {
    id: job.id,
    status: job.status,
    originalName: job.originalName,
    mode: job.mode,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    input: {
      sizeBytes: job.inputSizeBytes
    },
    output: job.outputSizeBytes ? {
      sizeBytes: job.outputSizeBytes,
      downloadUrl: `${base}/api/encode/${job.id}/download`
    } : null,
    urls: {
      status: `${base}/api/encode/${job.id}`,
      download: `${base}/api/encode/${job.id}/download`
    }
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${command} exited with code ${code}`);
      err.code = code;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function encodeJob(job) {
  job.status = "processing";
  job.startedAt = new Date().toISOString();

  const outputPath = path.join(OUTPUT_DIR, `${job.id}.mp4`);

  // Forge-style target based on the MediaInfo sample provided:
  // H.264 High, CRF 22, keyint 30 / min-keyint 15, lookahead 40,
  // ref 1, bframes 2, subme 7, me=hex, AQ 1:1.00.
  const x264Params = [
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
    "chroma-qp-offset=-2"
  ].join(":");

  const args = [
    "-hide_banner",
    "-y",
    "-i", job.inputPath,

    "-map", "0:v:0",
    "-map", "0:a?",

    "-c:v", "libx264",
    "-profile:v", "high",
    "-level:v", "5.2",
    "-pix_fmt", "yuv420p",
    "-crf", "22",
    "-x264-params", x264Params,

    // Keep the source frame rate unless the source is VFR.
    "-fps_mode", "passthrough",

    // AAC 325 kbps / stereo / 48 kHz matches the provided Forge sample.
    "-c:a", "aac",
    "-b:a", "325k",
    "-ar", "48000",
    "-ac", "2",

    "-movflags", "+faststart",
    outputPath
  ];

  try {
    const result = await runCommand("ffmpeg", args);
    const stat = await fsp.stat(outputPath);

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.outputPath = outputPath;
    job.outputSizeBytes = stat.size;

    setTimeout(async () => {
      try {
        if (job.outputPath) await fsp.unlink(job.outputPath);
      } catch {}
      try {
        await fsp.unlink(job.inputPath);
      } catch {}
      jobs.delete(job.id);
    }, RESULT_TTL_MINUTES * 60 * 1000);

    job.ffmpegTail = result.stderr.slice(-1500);
  } catch (err) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = err.message;
    job.ffmpegTail = String(err.stderr || "").slice(-3000);

    try { await fsp.unlink(job.inputPath); } catch {}
    try { await fsp.unlink(outputPath); } catch {}

    setTimeout(() => jobs.delete(job.id), 5 * 60 * 1000);
  }
}

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift();
    activeJobs++;

    encodeJob(job)
      .catch(() => {})
      .finally(() => {
        activeJobs--;
        pumpQueue();
      });
  }
}

app.get("/", (_req, res) => {
  res.json({
    name: "DanzClean TikTok Forge API",
    version: "1.0.0",
    status: "online"
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    const { stdout } = await runCommand("ffmpeg", ["-version"]);
    res.json({
      ok: true,
      ffmpeg: stdout.split("\n")[0],
      activeJobs,
      queuedJobs: queue.length
    });
  } catch {
    res.status(503).json({ ok: false, error: "FFmpeg unavailable" });
  }
});

app.post("/api/encode", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'Missing file. Use multipart/form-data with field name "video".'
    });
  }

  const requestedMode = String(req.body?.mode || "forge").toLowerCase();
  if (!["forge"].includes(requestedMode)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      error: `Unsupported mode "${requestedMode}". Available mode: forge`
    });
  }

  const id = path.basename(req.file.filename).split(".")[0];

  const job = {
    id,
    status: "queued",
    mode: "forge",
    originalName: req.file.originalname,
    inputPath: req.file.path,
    inputSizeBytes: req.file.size,
    createdAt: new Date().toISOString()
  };

  jobs.set(id, job);
  queue.push(job);
  pumpQueue();

  res.status(202).json(jobResponse(req, job));
});

app.get("/api/encode/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found or expired." });

  res.json(jobResponse(req, job));
});

app.get("/api/encode/:id/download", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found or expired." });

  if (job.status !== "completed" || !job.outputPath) {
    return res.status(409).json({
      error: "File is not ready yet.",
      status: job.status,
      statusUrl: `${publicBase(req)}/api/encode/${job.id}`
    });
  }

  try {
    await fsp.access(job.outputPath, fs.constants.R_OK);
    res.download(job.outputPath, `${path.parse(job.originalName).name}-danzclean-forge.mp4`);
  } catch {
    res.status(404).json({ error: "Output file has expired." });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `File too large. Maximum is ${MAX_UPLOAD_MB} MB.`
      });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`DanzClean TikTok Forge API listening on :${PORT}`);
});

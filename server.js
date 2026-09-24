const express=require("express");
const multer=require("multer");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const crypto=require("crypto");
const {spawn}=require("child_process");

const app=express();
app.disable("x-powered-by");

const PORT=Number(process.env.PORT||3000);
const MAX_UPLOAD_MB=Number(process.env.MAX_UPLOAD_MB||500);
const RESULT_TTL_MINUTES=Number(process.env.RESULT_TTL_MINUTES||10);
const WORK_DIR=process.env.WORK_DIR||"/tmp/danzclean-tiktok";
const INPUT_DIR=path.join(WORK_DIR,"input");
const OUTPUT_DIR=path.join(WORK_DIR,"output");

fs.mkdirSync(INPUT_DIR,{recursive:true});
fs.mkdirSync(OUTPUT_DIR,{recursive:true});

const allowedExt=new Set([".mp4",".mov",".mkv",".webm",".m4v",".avi"]);
const storage=multer.diskStorage({
  destination:(_req,_file,cb)=>cb(null,INPUT_DIR),
  filename:(_req,file,cb)=>{
    const id=crypto.randomUUID();
    const ext=path.extname(file.originalname||"").toLowerCase()||".mp4";
    cb(null,`${id}${ext}`);
  }
});
const upload=multer({
  storage,
  limits:{fileSize:MAX_UPLOAD_MB*1024*1024},
  fileFilter:(_req,file,cb)=>{
    const ext=path.extname(file.originalname||"").toLowerCase();
    allowedExt.has(ext)?cb(null,true):cb(new Error(`Unsupported file type: ${ext||"unknown"}`));
  }
});

function run(command,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(command,args,{stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    p.stdout.on("data",d=>stdout+=d.toString());
    p.stderr.on("data",d=>stderr+=d.toString());
    p.on("error",reject);
    p.on("close",code=>{
      if(code===0) resolve({stdout,stderr});
      else { const e=new Error(`FFmpeg exited with code ${code}`); e.stderr=stderr; reject(e); }
    });
  });
}
function baseUrl(req){
  const proto=(req.get("x-forwarded-proto")||req.protocol).split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}
function cleanupLater(input,output){
  setTimeout(async()=>{
    try{await fsp.unlink(input);}catch{}
    try{await fsp.unlink(output);}catch{}
  },RESULT_TTL_MINUTES*60*1000);
}

/* Parameters observed in the supplied Forge MediaInfo sample. */
const X264_PARAMS=[
"ref=1","bframes=2","b-pyramid=0","b-adapt=1","b-bias=0",
"direct=1","weightb=1","weightp=2","open-gop=0",
"keyint=30","min-keyint=15","scenecut=40","intra-refresh=0",
"rc-lookahead=40","mbtree=1","qcomp=0.60","qpmin=0","qpmax=69",
"qpstep=4","vbv-maxrate=300000","vbv-bufsize=300000","crf-max=0.0",
"nal-hrd=none","filler=0","ip-ratio=1.40","aq-mode=1","aq-strength=1.0",
"me=hex","subme=7","me-range=16","chroma-me=1","trellis=1",
"8x8dct=1","fast-pskip=1","chroma-qp-offset=-2"
].join(":");

app.get("/",(_req,res)=>res.json({
  name:"DanzClean TikTok Forge API",
  status:"online",
  usage:"POST /api/encode with multipart field 'video'"
}));

app.get("/api/health",async(_req,res)=>{
  try{
    const {stdout}=await run("ffmpeg",["-version"]);
    res.json({ok:true,ffmpeg:stdout.split("\n")[0]});
  }catch{
    res.status(503).json({ok:false,error:"FFmpeg unavailable"});
  }
});

/* One request: upload -> encode -> return direct download URL. */
app.post("/api/encode",upload.single("video"),async(req,res)=>{
  if(!req.file) return res.status(400).json({
    ok:false,error:'Missing video file. Use multipart/form-data field "video".'
  });

  const inputPath=req.file.path;
  const id=path.basename(req.file.filename).split(".")[0];
  const outputPath=path.join(OUTPUT_DIR,`${id}.mp4`);

  const args=[
    "-hide_banner","-y","-i",inputPath,
    "-map","0:v:0","-map","0:a?",
    "-c:v","libx264",
    "-profile:v","high",
    "-level:v","5.2",
    "-pix_fmt","yuv420p",
    "-crf","22",
    "-x264-params",X264_PARAMS,
    "-fps_mode","passthrough",
    "-c:a","aac",
    "-b:a","325k",
    "-ar","48000",
    "-ac","2",
    "-movflags","+faststart",
    outputPath
  ];

  try{
    console.log(`[ENCODE] ${req.file.originalname}`);
    await run("ffmpeg",args);
    const stat=await fsp.stat(outputPath);
    const download=`${baseUrl(req)}/api/encode/download/${id}`;
    cleanupLater(inputPath,outputPath);

    res.json({
      ok:true,
      filename:`${path.parse(req.file.originalname).name}-danzclean-forge.mp4`,
      sizeBytes:stat.size,
      download
    });
  }catch(e){
    try{await fsp.unlink(inputPath);}catch{}
    try{await fsp.unlink(outputPath);}catch{}
    res.status(500).json({
      ok:false,
      error:"FFmpeg encode failed",
      detail:e.message
    });
  }
});

app.get("/api/encode/download/:id",async(req,res)=>{
  const id=path.basename(req.params.id);
  const outputPath=path.join(OUTPUT_DIR,`${id}.mp4`);
  try{
    await fsp.access(outputPath,fs.constants.R_OK);
    res.download(outputPath,`danzclean-forge-${id}.mp4`);
  }catch{
    res.status(404).json({ok:false,error:"Result not found or expired"});
  }
});

app.use((err,_req,res,_next)=>{
  if(err instanceof multer.MulterError && err.code==="LIMIT_FILE_SIZE")
    return res.status(413).json({ok:false,error:`File too large. Maximum is ${MAX_UPLOAD_MB} MB.`});
  if(err) return res.status(400).json({ok:false,error:err.message});
  res.status(500).json({ok:false,error:"Internal server error"});
});

app.listen(PORT,()=>console.log(`DanzClean TikTok Forge API listening on :${PORT}`));

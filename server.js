
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(os.tmpdir(), "hwa-uploads");
const FRAME_DIR = path.join(os.tmpdir(), "hwa-frames");
const OUTPUT_DIR = path.join(os.tmpdir(), "hwa-output");

for (const dir of [UPLOAD_DIR, FRAME_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/outputs", express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || ".mp4");
    cb(null, `${randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new Error("Video ဖိုင်ကိုသာ Upload လုပ်နိုင်ပါတယ်။"));
    }
    cb(null, true);
  }
});

function safeFilePath(filename, directory = UPLOAD_DIR) {
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename)
  ) {
    throw new Error("Invalid filename");
  }

  const filePath = path.join(directory, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error("File not found");
  }

  return filePath;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function getVideoInfo(filePath) {
  const { stdout } = await execFileAsync(
    ffprobeStatic.path,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=width,height,duration,avg_frame_rate:format=duration",
      "-of", "json",
      filePath
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];

  if (!stream) {
    throw new Error("Video stream မတွေ့ပါ။");
  }

  return {
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    duration: Number(stream.duration || data.format?.duration || 0),
    frameRate: stream.avg_frame_rate || "unknown"
  };
}

async function detectScenes(filePath, duration) {
  const filter = "select='gt(scene,0.35)',showinfo";

  const { stderr } = await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner",
      "-threads", "1",
      "-i", filePath,
      "-vf", filter,
      "-an",
      "-f", "null",
      "-"
    ],
    { maxBuffer: 50 * 1024 * 1024 }
  );

  const timestamps = [];
  const regex = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let match;

  while ((match = regex.exec(stderr)) !== null) {
    const timestamp = Number(match[1]);

    if (
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp < duration
    ) {
      timestamps.push(timestamp);
    }
  }

  return [...new Set(timestamps)].sort((a, b) => a - b);
}

async function createSceneFrames(filePath, sceneTimes, filename) {
  const frames = [];
  const safeBase = path.parse(filename).name;

  // RAM နည်းသော Server အတွက် Frame 100 ခုသာထုတ်မည်
  const selectedTimes = sceneTimes.slice(0, 100);

  for (let i = 0; i < selectedTimes.length; i++) {
    const timestamp = selectedTimes[i];
    const frameName = `${safeBase}-scene-${i + 1}.jpg`;
    const framePath = path.join(FRAME_DIR, frameName);

    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-threads", "1",
        "-ss", String(timestamp),
        "-i", filePath,
        "-frames:v", "1",
        "-vf", "scale=480:-1",
        "-q:v", "5",
        "-y",
        framePath
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );

    frames.push({
      scene: i + 1,
      time: timestamp,
      frame: frameName
    });
  }

  return frames;
}

function makeScenes(sceneTimes, duration) {
  const boundaries = [0, ...sceneTimes, duration];
  const scenes = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    scenes.push({
      scene: i + 1,
      start: boundaries[i],
      end: boundaries[i + 1],
      duration: boundaries[i + 1] - boundaries[i]
    });
  }

  return scenes;
}

function buildEditingPlan(scenes, videoDuration) {
  const plannedScenes = scenes.map((scene, index) => {
    const duration = scene.end - scene.start;

    // လက်ရှိမှာ အရေးကြီးဇာတ်ကွက် မဖြတ်ပါ။
    // AI ဇာတ်လမ်းသုံးသပ်မှု မချိတ်ရသေးပါ။
    return {
      scene: index + 1,
      start: Number(scene.start.toFixed(3)),
      end: Number(scene.end.toFixed(3)),
      originalDuration: Number(duration.toFixed(3)),
      speed: 1,
      keep: true,
      reason: "မူရင်းဇာတ်ကွက်ကို ထိန်းသိမ်းထားသည်"
    };
  });

  return {
    videoDuration,
    sceneCount: plannedScenes.length,
    scenes: plannedScenes,
    note: "AI ဇာတ်လမ်းသုံးသပ်မှုနှင့် မြန်မာအသံ မချိတ်ရသေးပါ။"
  };
}

// Scene တစ်ခုချင်းစီကို Render လုပ်ပြီး နောက်မှ ပေါင်းမည်။
async function renderVideo(filePath, plan, outputPath) {
  if (!plan || !Array.isArray(plan.scenes)) {
    throw new Error("Editing plan မရှိပါ။");
  }

  const scenes = plan.scenes.filter(scene =>
    scene.keep !== false &&
    Number(scene.end) > Number(scene.start)
  );

  if (!scenes.length) {
    throw new Error("Render လုပ်ရန် Scene မရှိပါ။");
  }

  const tempDir = path.join(
    OUTPUT_DIR,
    `temp-${randomUUID()}`
  );

  fs.mkdirSync(tempDir, { recursive: true });

  const parts = [];

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      const start = safeNumber(scene.start);
      const end = safeNumber(scene.end);
      const speed = clamp(safeNumber(scene.speed, 1), 0.5, 2);

      if (end <= start) continue;

      const partPath = path.join(tempDir, `part-${i}.mp4`);

      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-threads", "1",
        "-filter_threads", "1",
        "-ss", String(start),
        "-i", filePath,
        "-t", String(end - start),
        "-vf",
        `setpts=(PTS-STARTPTS)/${speed},scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-threads", "1",
        "-crf", "28",
        "-an",
        "-y",
        partPath
      ];

      await execFileAsync(ffmpegPath, args, {
        maxBuffer: 10 * 1024 * 1024
      });

      parts.push(partPath);
    }

    if (!parts.length) {
      throw new Error("Render လုပ်ရန် Video အပိုင်းမရှိပါ။");
    }

    const listPath = path.join(tempDir, "list.txt");

    fs.writeFileSync(
      listPath,
      parts.map(file => `file '${file}'`).join("\n")
    );

    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-threads", "1",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y",
        outputPath
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    return outputPath;

  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    service: "HWA Recap Backend"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Video file is required"
    });
  }

  res.json({
    success: true,
    message: "Video uploaded successfully",
    file: {
      name: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size
    }
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { filename } = req.body;
    const filePath = safeFilePath(filename);
    const videoInfo = await getVideoInfo(filePath);

    if (
      !videoInfo.duration ||
      videoInfo.duration > 350 * 60
    ) {
      return res.status(400).json({
        success: false,
        message: "Video ကြာချိန် မမှန်ပါ သို့မဟုတ် 350 မိနစ်ကျော်နေပါတယ်။"
      });
    }

    const sceneTimes = await detectScenes(
      filePath,
      videoInfo.duration
    );

    const frames = await createSceneFrames(
      filePath,
      sceneTimes,
      filename
    );

    const scenes = makeScenes(
      sceneTimes,
      videoInfo.duration
    );

    res.json({
      success: true,
      message: "Scene analysis completed",
      video: videoInfo,
      sceneCount: scenes.length,
      scenes,
      frames
    });

  } catch (error) {
    console.error("Scene analysis error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Scene analysis failed"
    });
  }
});

app.post("/api/editing-plan", async (req, res) => {
  try {
    const { filename } = req.body;
    const filePath = safeFilePath(filename);
    const videoInfo = await getVideoInfo(filePath);

    if (videoInfo.duration > 350 * 60) {
      return res.status(400).json({
        success: false,
        message: "Video ကြာချိန် 350 မိနစ်ထက် ကျော်နေပါတယ်။"
      });
    }

    const sceneTimes = await detectScenes(
      filePath,
      videoInfo.duration
    );

    const scenes = makeScenes(
      sceneTimes,
      videoInfo.duration
    );

    const plan = buildEditingPlan(
      scenes,
      videoInfo.duration
    );

    res.json({
      success: true,
      message: "Editing plan created",
      plan
    });

  } catch (error) {
    console.error("Editing plan error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Editing plan failed"
    });
  }
});

app.post("/api/render", async (req, res) => {
  try {
    const { filename, plan } = req.body;
    const filePath = safeFilePath(filename);

    if (!plan || !Array.isArray(plan.scenes)) {
      return res.status(400).json({
        success: false,
        message: "Editing plan is required"
      });
    }

    const outputName = `${randomUUID()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    await renderVideo(filePath, plan, outputPath);

    res.json({
      success: true,
      message: "Render completed",
      output: {
        filename: outputName,
        url: `${req.protocol}://${req.get("host")}/outputs/${outputName}`
      }
    });

  } catch (error) {
    console.error("Render error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Render failed"
    });
  }
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(400).json({
    success: false,
    message: err.message || "Request failed"
  });
});

app.listen(PORT, () => {
  console.log(`HWA Recap Backend running on port ${PORT}`);
});

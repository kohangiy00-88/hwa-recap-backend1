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

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || ".mp4");
    cb(null, `${randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new Error("Video ဖိုင်ကိုသာ Upload လုပ်နိုင်ပါတယ်။"));
    }

    cb(null, true);
  }
});

function safeFilePath(filename) {
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename)
  ) {
    throw new Error("Invalid filename");
  }

  const filePath = path.join(UPLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error("Video file not found");
  }

  return filePath;
}

async function getVideoInfo(filePath) {
  const ffprobePath = ffprobeStatic.path;

  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=width,height,duration,avg_frame_rate:format=duration",
      "-of", "json",
      filePath
    ],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];

  if (!stream) {
    throw new Error("Video stream မတွေ့ပါ။");
  }

  return {
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    duration: Number(
      stream.duration || data.format?.duration || 0
    ),
    frameRate: stream.avg_frame_rate || "unknown"
  };
}

async function detectScenes(filePath, duration) {
  const threshold = 0.35;

  const filter =
    `select='gt(scene,${threshold})',showinfo`;

  const { stderr } = await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner",
      "-i", filePath,
      "-vf", filter,
      "-an",
      "-f", "null",
      "-"
    ],
    {
      maxBuffer: 50 * 1024 * 1024
    }
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

  return timestamps;
}

async function createSceneFrames(filePath, sceneTimes, filename) {
  const frames = [];

  const safeBase = path.parse(filename).name;

  for (let i = 0; i < sceneTimes.length; i++) {
    const timestamp = sceneTimes[i];

    const frameName = `${safeBase}-scene-${i + 1}.jpg`;
    const framePath = path.join(FRAME_DIR, frameName);

    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", String(timestamp),
        "-i", filePath,
        "-frames:v", "1",
        "-vf", "scale=640:-1",
        "-q:v", "3",
        "-y",
        framePath
      ]
    );

    frames.push({
      scene: i + 1,
      time: timestamp,
      frame: frameName
    });
  }

  return frames;
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

    const frames = await createSceneFrames(
      filePath,
      sceneTimes,
      filename
    );

    const boundaries = [
      0,
      ...sceneTimes,
      videoInfo.duration
    ];

    const scenes = [];

    for (let i = 0; i < boundaries.length - 1; i++) {
      scenes.push({
        scene: i + 1,
        start: boundaries[i],
        end: boundaries[i + 1],
        duration: boundaries[i + 1] - boundaries[i]
      });
    }

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

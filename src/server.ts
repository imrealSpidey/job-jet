import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { runIngestionPipeline } from "./ingestion.js";
import { evaluateJobs, readApprovedJobs, writeApprovedJobs, getEvaluationProgress } from "./evaluator.js";
import { loadSourceOfTruth, loadSettings, loadBlacklist, loadCandidateProfile, saveCandidateProfile, paths } from "./config.js";
import { extractCandidateProfile } from "./profileBuilder.js";
import { getAutomationProgress, startAutomation, stopAutomation } from "./automationRunner.js";
import type { Settings, CandidateProfile } from "./types.js";
import chalk from "chalk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use("/api/preview", express.static(paths.sourceDir));

// Configure Multer for Document Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, paths.sourceDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    if (file.fieldname === "resume") {
      cb(null, "current_resume" + ext);
    } else if (file.fieldname === "linkedin") {
      cb(null, "linkedin_export" + ext);
    } else {
      cb(null, file.originalname);
    }
  },
});
const upload = multer({ storage });

// ============================================================
// Document Endpoints
// ============================================================

app.get("/api/documents", (req, res) => {
  try {
    const files = fs.existsSync(paths.sourceDir) ? fs.readdirSync(paths.sourceDir) : [];
    const resume = files.find(f => f.startsWith("current_resume"));
    const linkedin = files.find(f => f.startsWith("linkedin_export"));
    res.json({ resume, linkedin });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/upload", upload.any(), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }
  res.json({ success: true, filenames: files.map(f => f.filename) });
});

// ============================================================
// Settings & Config
// ============================================================

app.get("/api/settings", (req, res) => {
  try {
    const settings = loadSettings();
    const envKeys = {
      gemini: process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "",
      openrouter: process.env.OPENROUTER_API_KEYS || "",
      apify: process.env.APIFY_API_TOKEN || "",
    };
    res.json({ settings, keys: envKeys });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const { settings, keys } = req.body;
    fs.writeFileSync(paths.settingsYaml, yaml.dump(settings), "utf8");
    const envContent = `APIFY_API_TOKEN=${keys.apify}\nGEMINI_API_KEYS=${keys.gemini}\nOPENROUTER_API_KEYS=${keys.openrouter}\n`;
    fs.writeFileSync(".env", envContent, "utf8");
    dotenv.config({ override: true });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Blacklist Management
// ============================================================

app.get("/api/blacklist", (req, res) => {
  try {
    const blacklist = loadBlacklist();
    res.json(blacklist);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/blacklist", (req, res) => {
  try {
    const { companies, keywords } = req.body;
    const blacklistData = { companies: companies || [], keywords: keywords || [] };
    fs.writeFileSync(paths.blacklistYaml, yaml.dump(blacklistData), "utf8");
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Candidate Profile
// ============================================================

app.get("/api/profile", (req, res) => {
  try {
    const profile = loadCandidateProfile();
    res.json(profile);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/profile", (req, res) => {
  try {
    const profile = req.body as CandidateProfile;
    saveCandidateProfile(profile);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pipeline/extract-profile", async (req, res) => {
  try {
    const settings = loadSettings();
    const resumeText = await loadSourceOfTruth();
    if (!resumeText || resumeText.length < 10) {
      return res.status(400).json({ error: "Resume text is empty or too short. Upload a valid document first." });
    }
    const extracted = await extractCandidateProfile(resumeText, settings);
    const existing = loadCandidateProfile();
    const merged = { ...existing, ...extracted };
    saveCandidateProfile(merged);
    res.json(merged);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Pipeline Endpoints
// ============================================================

app.post("/api/pipeline/ingest", async (req, res) => {
  try {
    const settings = loadSettings();
    const blacklist = loadBlacklist();
    const jobs = await runIngestionPipeline(blacklist, settings);
    res.json({ success: true, count: jobs.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/pipeline/evaluate/progress", (req, res) => {
  try {
    const progress = getEvaluationProgress();
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pipeline/evaluate", async (req, res) => {
  try {
    const progress = getEvaluationProgress();
    if (progress.isRunning) {
      return res.json({ success: true, message: "Evaluation already in progress", progress });
    }

    const settings = loadSettings();
    const rawJobsText = fs.readFileSync(paths.jobsRaw, "utf8");
    const jobs = JSON.parse(rawJobsText);
    const resumeText = await loadSourceOfTruth();

    // Run evaluation in the background without blocking the HTTP request
    evaluateJobs(jobs, resumeText, settings).catch((err) => {
      console.error(chalk.red("Evaluation error:"), err);
    });

    res.json({ success: true, message: "Evaluation started", total: jobs.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jobs", (req, res) => {
  try {
    const jobs = readApprovedJobs();
    res.json(jobs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jobs/raw", (req, res) => {
  try {
    if (!fs.existsSync(paths.jobsRaw)) {
      return res.json([]);
    }
    const rawJobsText = fs.readFileSync(paths.jobsRaw, "utf8");
    res.json(JSON.parse(rawJobsText));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/pipeline/apply/progress", (req, res) => {
  try {
    const progress = getAutomationProgress();
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pipeline/apply", async (req, res) => {
  try {
    const progress = getAutomationProgress();
    if (progress.isRunning) {
      return res.json({ success: true, message: "Automation already in progress", progress });
    }
    const dryRun = Boolean(req.body?.dryRun);
    startAutomation(dryRun).catch((err) => {
      console.error(chalk.red("Automation runner error:"), err);
    });
    res.json({ success: true, message: "Browser automation initialized!" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pipeline/apply/stop", async (req, res) => {
  try {
    await stopAutomation();
    res.json({ success: true, message: "Automation stopped" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Start Server
// ============================================================

app.listen(PORT, () => {
  console.log(chalk.green(`\n🚀 Orchestrator API Server running on http://localhost:${PORT}`));
});

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { runIngestionPipeline, filterByRoleRelevance, applyBlacklist, deduplicateHistory } from "./ingestion.js";
import { evaluateJobs, readApprovedJobs, writeApprovedJobs, getEvaluationProgress, stopEvaluation } from "./evaluator.js";
import { loadSourceOfTruth, loadSettings, loadBlacklist, loadCandidateProfile, saveCandidateProfile, paths } from "./config.js";
import { extractCandidateProfile } from "./profileBuilder.js";
import { getAutomationProgress, startAutomation, stopAutomation } from "./automationRunner.js";
import type { Settings, CandidateProfile, RawJob } from "./types.js";
import { normalizeRawJobInput } from "./types.js";
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

let lastScrapeBatchId: string | null = null;

app.post("/api/pipeline/ingest", async (req, res) => {
  try {
    const settings = loadSettings();
    const { query, rows } = req.body || {};
    let settingsUpdated = false;
    
    if (query || rows !== undefined) {
      if (!settings.ingestion) settings.ingestion = { mode: "api", apify_input: {} };
      if (!settings.ingestion.apify_input) settings.ingestion.apify_input = {};
      
      if (query !== undefined && query !== settings.ingestion.apify_input.searchTerms) {
        settings.ingestion.apify_input.searchTerms = query;
        settingsUpdated = true;
      }
      if (rows !== undefined && rows !== settings.ingestion.apify_input.rows) {
        settings.ingestion.apify_input.rows = Number(rows);
        settingsUpdated = true;
      }
      
      if (settingsUpdated) {
        fs.writeFileSync(paths.settingsYaml, yaml.dump(settings), "utf8");
      }
    }
    
    const blacklist = loadBlacklist();
    const jobs = await runIngestionPipeline(blacklist, settings);
    const batchId = (jobs[0] as any)?.scrapeBatchId || lastScrapeBatchId;
    if (batchId) {
      lastScrapeBatchId = batchId;
    }
    res.json({ success: true, count: jobs.length, batchId: lastScrapeBatchId });
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

    const { batchId } = req.body || {};
    const settings = loadSettings();
    const rawJobsText = fs.readFileSync(paths.jobsRaw, "utf8");
    let allJobs = JSON.parse(rawJobsText);

    // Default to the latest batch if not explicitly specified
    let targetBatchId = batchId;
    if (!targetBatchId || targetBatchId === "latest") {
      targetBatchId = lastScrapeBatchId || allJobs[allJobs.length - 1]?.scrapeBatchId;
    }

    let targetJobs: any[];
    if (targetBatchId && targetBatchId !== "all") {
      targetJobs = allJobs.filter((j: any) => j.scrapeBatchId === targetBatchId);
    } else {
      targetJobs = allJobs;
    }

    if (targetJobs.length === 0) {
      return res.status(400).json({ error: "No jobs found for the selected batch." });
    }

    // Always apply deterministic pre-filters so irrelevant jobs are removed before AI
    const blacklist = loadBlacklist();
    const normalized = targetJobs.map((j: any) => normalizeRawJobInput(j)) as RawJob[];
    const blacklisted = applyBlacklist(normalized, blacklist);
    const profile = loadCandidateProfile();
    const roleFiltered = filterByRoleRelevance(blacklisted, profile.search?.titles || []);
    const filteredJobs = deduplicateHistory(roleFiltered);

    const resumeText = await loadSourceOfTruth();

    // Run evaluation in the background without blocking the HTTP request
    evaluateJobs(filteredJobs, resumeText, settings).catch((err) => {
      console.error(chalk.red("Evaluation error:"), err);
    });

    res.json({ success: true, message: "Evaluation started", total: filteredJobs.length, batchId: targetBatchId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pipeline/evaluate/stop", (req, res) => {
  try {
    stopEvaluation();
    res.json({ success: true, message: "Evaluation stopped" });
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
    const { batchId, dryRun } = req.body || {};
    
    startAutomation(Boolean(dryRun), batchId).catch((err) => {
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
// Job Batch Management
// ============================================================

app.delete("/api/jobs/raw/stale", (req, res) => {
  try {
    const olderThanDays = Number(req.query.olderThanDays) || 7;
    if (!fs.existsSync(paths.jobsRaw)) {
      return res.json({ success: true, removed: 0, remaining: 0 });
    }
    const rawJobs: any[] = JSON.parse(fs.readFileSync(paths.jobsRaw, "utf-8"));
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const fresh = rawJobs.filter((j: any) => !j.scrapedAt || j.scrapedAt >= cutoff);
    fs.writeFileSync(paths.jobsRaw, JSON.stringify(fresh, null, 2), "utf-8");
    res.json({ success: true, removed: rawJobs.length - fresh.length, remaining: fresh.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/jobs/raw/batch/:batchId", (req, res) => {
  try {
    const { batchId } = req.params;
    if (!fs.existsSync(paths.jobsRaw)) {
      return res.json({ success: true, removed: 0, remaining: 0 });
    }
    const rawJobs: any[] = JSON.parse(fs.readFileSync(paths.jobsRaw, "utf-8"));
    const filtered = rawJobs.filter((j: any) => j.scrapeBatchId !== batchId);
    fs.writeFileSync(paths.jobsRaw, JSON.stringify(filtered, null, 2), "utf-8");
    res.json({ success: true, removed: rawJobs.length - filtered.length, remaining: filtered.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Start Server
// ============================================================

import("./ai/discovery.js").then(({ discoverModels }) => {
  discoverModels().catch(err => console.warn(chalk.yellow("⚠ Could not discover AI models.")));
}).catch(() => {});

app.listen(PORT, () => {
  console.log(chalk.green(`\n🚀 Orchestrator API Server running on http://localhost:${PORT}`));
});

/**
 * config.ts — Configuration loader, validator, and resume text extractor
 *
 * Loads settings.yaml, blacklist.yaml, and .env at startup.
 * Automatically extracts text from the PDF resume via pdf-parse,
 * falling back to data/resume.txt if the PDF is unavailable.
 * Also exposes loadSourceOfTruth for Phase 0 optimization.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import chalk from "chalk";
import {
  SettingsSchema,
  BlacklistSchema,
  CandidateProfileSchema,
  type CandidateProfile,
  type Settings,
  type Blacklist,
  type CliFlags,
  type HistoryEntry,
} from "./types.js";

// ============================================================
// Paths (relative to project root)
// ============================================================

const PROJECT_ROOT = process.cwd();
const SETTINGS_PATH = path.resolve(PROJECT_ROOT, "config", "settings.yaml");
const BLACKLIST_PATH = path.resolve(PROJECT_ROOT, "config", "blacklist.yaml");
const JOBS_RAW_PATH = path.resolve(PROJECT_ROOT, "data", "jobs_raw.json");
const JOBS_APPROVED_PATH = path.resolve(PROJECT_ROOT, "data", "jobs_approved.json");
const HISTORY_PATH = path.resolve(PROJECT_ROOT, "data", "history.json");
const CANDIDATE_PROFILE_PATH = path.resolve(PROJECT_ROOT, "data", "candidate_profile.json");
const SCREENSHOTS_DIR = path.resolve(PROJECT_ROOT, "data", "screenshots");

// Phase 0 / External Paths
const SOURCE_DIR = path.resolve(PROJECT_ROOT, "data", "source");
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, "output");
const ATS_RESUME_PATH = path.resolve(OUTPUT_DIR, "ats_optimized_resume.md");
const LINKEDIN_REC_PATH = path.resolve(OUTPUT_DIR, "linkedin_recommendations.md");
const INTERVIEW_PREP_PATH = path.resolve(OUTPUT_DIR, "interview_prep.md");
const EXTERNAL_SHORTLIST_PATH = path.resolve(OUTPUT_DIR, "external_shortlist.md");

/**
 * Dynamically find the actual file in SOURCE_DIR by prefix (e.g. "current_resume" → "current_resume.pdf" or "current_resume.docx").
 * Returns the full resolved path, or a fallback default (.pdf) if nothing is found.
 */
function findSourceFile(prefix: string): string {
  if (!fs.existsSync(SOURCE_DIR)) return path.resolve(SOURCE_DIR, `${prefix}.pdf`);
  const files = fs.readdirSync(SOURCE_DIR);
  const match = files.find(f => f.startsWith(prefix) && f !== ".gitkeep");
  return match ? path.resolve(SOURCE_DIR, match) : path.resolve(SOURCE_DIR, `${prefix}.pdf`);
}


// ============================================================
// Load .env
// ============================================================

dotenv.config({ path: path.resolve(PROJECT_ROOT, ".env") });

export function ensureDirectories(): void {
  const dirs = [
    path.resolve(PROJECT_ROOT, "data"),
    path.resolve(PROJECT_ROOT, "config"),
    SCREENSHOTS_DIR,
    SOURCE_DIR,
    OUTPUT_DIR,
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============================================================
// Load YAML Configs
// ============================================================

function loadYaml<T>(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red.bold(`✖ [CONFIG ERROR]`), `File not found: ${filePath}`);
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    const fileContents = fs.readFileSync(filePath, "utf8");
    return yaml.load(fileContents);
  } catch (err) {
    console.error(chalk.red.bold(`✖ [YAML PARSE ERROR]`), `in ${filePath}`);
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    throw new Error(`Failed to parse YAML in ${filePath}`);
  }
}

export function loadSettings(): Settings {
  const rawYaml = loadYaml(SETTINGS_PATH);
  const result = SettingsSchema.safeParse(rawYaml);
  if (!result.success) {
    console.error(chalk.red.bold(`✖ [SETTINGS VALIDATION ERROR]`));
    for (const issue of result.error.issues) {
      console.error(chalk.red(`  - ${issue.path.join(".")}: ${issue.message}`));
    }
    throw new Error("Settings validation failed.");
  }
  return result.data;
}

export function loadBlacklist(): Blacklist {
  const rawYaml = loadYaml(BLACKLIST_PATH);
  const result = BlacklistSchema.safeParse(rawYaml);
  if (!result.success) {
    console.error(chalk.red.bold(`✖ [BLACKLIST VALIDATION ERROR]`));
    for (const issue of result.error.issues) {
      console.error(chalk.red(`  - ${issue.path.join(".")}: ${issue.message}`));
    }
    throw new Error("Blacklist validation failed.");
  }
  return result.data;
}

// ============================================================
// Resume & Phase 0 Extraction
// ============================================================

async function extractDocumentText(filePath: string): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === ".pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (ext === ".docx") {
      // Simple DOCX text extraction using Node's built-in zlib
      const { createReadStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const { Writable } = await import("node:stream");
      const zlib = await import("node:zlib");

      // DOCX is a ZIP containing XML; extract document.xml for text content
      try {
        const { execFileSync } = await import("node:child_process");
        // Use PowerShell to extract text from DOCX (available on all Windows systems)
        const psScript = `
          Add-Type -Assembly System.IO.Compression.FileSystem
          $zip = [IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}')
          $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
          $stream = $entry.Open()
          $reader = New-Object IO.StreamReader($stream)
          $xml = $reader.ReadToEnd()
          $reader.Close()
          $stream.Close()
          $zip.Dispose()
          # Strip XML tags to get plain text
          $xml -replace '<[^>]+>', ' ' -replace '\\s+', ' '
        `;
        const result = execFileSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
          encoding: "utf-8",
          timeout: 15000,
        });
        return result.trim();
      } catch (psErr) {
        console.warn(chalk.yellow(`⚠ DOCX extraction via PowerShell failed: ${psErr instanceof Error ? psErr.message : String(psErr)}`));
        return null;
      }
    } else if (ext === ".txt") {
      return fs.readFileSync(filePath, "utf-8");
    }
    console.warn(chalk.yellow(`⚠ Unsupported file format: ${ext}`));
    return null;
  } catch (err) {
    console.warn(chalk.yellow(`⚠ Could not extract text from ${filePath}: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
}

export function getResumeFilePath(): string {
  return findSourceFile("current_resume");
}

export async function loadResumeText(settings?: Settings): Promise<string> {
  const resumeFile = getResumeFilePath();
  
  console.log(chalk.gray(`\n  📄 Loading resume from: ${resumeFile}`));
  const text = await extractDocumentText(resumeFile);
  if (text && text.trim().length > 0) {
    return text.trim();
  }

  // Last-ditch fallback: try a .txt version next to the original
  const txtPath = resumeFile.replace(/\.[^/.]+$/, ".txt");
  if (fs.existsSync(txtPath)) {
    console.log(chalk.gray(`  📄 Falling back to text resume: ${txtPath}`));
    return fs.readFileSync(txtPath, "utf-8").trim();
  }

  return await loadSourceOfTruth();
}

/**
 * Loads and merges the Phase 0 Source of Truth (LinkedIn Export + Current Resume).
 */
export async function loadSourceOfTruth(): Promise<string> {
  console.log(chalk.cyan(`\n📥 [SOURCE OF TRUTH] Reading from data/source/...`));
  
  let combined = "";

  const linkedinPath = findSourceFile("linkedin_export");
  const linkedinText = await extractDocumentText(linkedinPath);
  if (linkedinText) {
    combined += `\n--- LINKEDIN EXPORT ---\n${linkedinText}\n`;
    console.log(chalk.green(`  ✔ Loaded ${path.basename(linkedinPath)}`));
  } else {
    console.log(chalk.yellow(`  ⚠ Missing or unreadable linkedin_export (looked for: ${path.basename(linkedinPath)})`));
  }

  const resumePath = findSourceFile("current_resume");
  const resumeText = await extractDocumentText(resumePath);
  if (resumeText) {
    combined += `\n--- CURRENT RESUME ---\n${resumeText}\n`;
    console.log(chalk.green(`  ✔ Loaded ${path.basename(resumePath)}`));
  } else {
    // Fallback to .txt
    const txtPath = resumePath.replace(/\.[^/.]+$/, ".txt");
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, "utf-8");
      combined += `\n--- CURRENT RESUME ---\n${text}\n`;
      console.log(chalk.green(`  ✔ Loaded ${path.basename(txtPath)} (fallback)`));
    } else {
      console.log(chalk.yellow(`  ⚠ Missing or unreadable resume (looked for: ${path.basename(resumePath)})`));
    }
  }

  if (combined.trim().length === 0) {
    console.error(chalk.red.bold(`✖ [SOURCE ERROR]`), `Both linkedin_export and current_resume are missing or empty in data/source/.`);
    throw new Error("Both linkedin_export and current_resume are missing or empty. Upload documents first.");
  }

  return combined.trim();
}

// ============================================================
// API Keys
// ============================================================

export function tryGetApiKeys(provider: "gemini" | "openrouter"): string[] {
  const envVar = provider === "gemini" ? process.env.GEMINI_API_KEYS : process.env.OPENROUTER_API_KEYS;
  if (!envVar || envVar.trim() === "") {
    const legacyKey = provider === "gemini" ? process.env.GEMINI_API_KEY : undefined;
    if (legacyKey && legacyKey !== "your_gemini_api_key_here") {
      return [legacyKey];
    }
    return [];
  }
  return envVar.split(",").map(k => k.trim()).filter(k => k.length > 0 && !k.includes("your_"));
}

export function hasApiKeys(provider: "gemini" | "openrouter"): boolean {
  return tryGetApiKeys(provider).length > 0;
}

export function getApiKeys(provider: "gemini" | "openrouter"): string[] {
  const keys = tryGetApiKeys(provider);
  if (keys.length === 0) {
    console.error(chalk.red.bold(`✖ [AUTH ERROR]`), `${provider.toUpperCase()}_API_KEYS not set.`);
    throw new Error(`${provider.toUpperCase()}_API_KEYS not set in .env. Configure them in Settings or .env file.`);
  }
  return keys;
}

export function getApifyToken(): string {
  const key = process.env.APIFY_API_TOKEN;
  if (!key || key === "your_apify_token_here") {
    console.error(chalk.red.bold(`✖ [AUTH ERROR]`), `APIFY_API_TOKEN not set. Required for mode 'api'.`);
    throw new Error("APIFY_API_TOKEN not set. Required for mode 'api'.");
  }
  return key;
}

// ============================================================
// Application History
// ============================================================

export function loadHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as HistoryEntry[];
  } catch {
    return [];
  }
}

export function saveHistory(history: HistoryEntry[]): void {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf-8");
}

export function appendHistory(entry: HistoryEntry): void {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

export function isAlreadyApplied(url: string): boolean {
  const history = loadHistory();
  // Only consider truly applied jobs as already applied (not skipped or halted)
  return history.some((entry) => entry.url === url && entry.status === "applied");
}

// ============================================================
// CLI Flags
// ============================================================

function getFlagValue(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return undefined;
}

export function parseCliFlags(): CliFlags {
  const args = process.argv.slice(2);
  return {
    filterOnly: args.includes("--filter-only"),
    applyOnly: args.includes("--apply-only"),
    dryRun: args.includes("--dry-run"),
    openExternal: args.includes("--open-external"),
    autoConfirm: args.includes("--auto-confirm"),
    auditResume: getFlagValue("--audit-resume", args),
    alignLinkedin: getFlagValue("--align-linkedin", args),
    prepInterview: getFlagValue("--prep-interview", args),
  };
}

// ============================================================
// Path exports
// ============================================================

export const paths = {
  projectRoot: PROJECT_ROOT,
  settingsYaml: SETTINGS_PATH,
  blacklistYaml: BLACKLIST_PATH,
  jobsRaw: JOBS_RAW_PATH,
  jobsApproved: JOBS_APPROVED_PATH,
  externalShortlist: EXTERNAL_SHORTLIST_PATH,
  historyJson: HISTORY_PATH,
  candidateProfileJson: CANDIDATE_PROFILE_PATH,
  screenshotsDir: SCREENSHOTS_DIR,
  sourceDir: SOURCE_DIR,
  outputDir: OUTPUT_DIR,
  atsResumePath: ATS_RESUME_PATH,
  linkedinRecPath: LINKEDIN_REC_PATH,
  interviewPrepPath: INTERVIEW_PREP_PATH,
} as const;
export function loadCandidateProfile(): CandidateProfile {
  if (!fs.existsSync(CANDIDATE_PROFILE_PATH)) {
    return CandidateProfileSchema.parse({}); // return defaults
  }
  try {
    const rawData = JSON.parse(fs.readFileSync(CANDIDATE_PROFILE_PATH, 'utf-8'));
    return CandidateProfileSchema.parse(rawData);
  } catch (err) {
    console.error(chalk.yellow("[WARN] Failed to parse candidate profile. Returning defaults."));
    return CandidateProfileSchema.parse({});
  }
}

export function saveCandidateProfile(profile: CandidateProfile): void {
  fs.writeFileSync(CANDIDATE_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}


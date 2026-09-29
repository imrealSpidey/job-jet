/**
 * evaluator.ts — Dual-Provider AI job match scoring engine
 *
 * Evaluates filtered job descriptions against candidate resume/profile using
 * batched Gemini requests with structured output validation.
 * Reuses existing scores to prevent re-scoring and preserve API quota.
 */

import fs from "node:fs";
import chalk from "chalk";
import { z } from "zod";
import type { RawJob, ScoredJob, GeminiScore } from "./types.js";
import { normalizeRawJobInput } from "./types.js";
import type { Settings } from "./types.js";
import { paths, getApiKeys, loadCandidateProfile } from "./config.js";
import { generateStructuredResponse, getModelForTask, abortAiOperations, type AiConfig } from "./ai.js";

// ============================================================
// System Prompt for Batched Job Scoring
// ============================================================

const BATCH_SCORING_SYSTEM_PROMPT = `You are a strict hiring match evaluator. Your task is to evaluate a batch of job postings against a candidate's profile.

RULES:
1. Be strict and honest — only score above 80 if there is GENUINE, DEMONSTRABLE alignment between the candidate's skills/experience and the job requirements.
2. NEVER fabricate, invent, or assume skills that are not explicitly stated in the candidate profile or resume highlights.
3. For each job, evaluate across these dimensions (0-100):
   - Core Technical Stack (0-100): Direct overlap of required technical skills & design tools
   - Seniority Alignment (0-100): Experience level and seniority match
   - Domain Relevance (0-100): Industry and domain experience fit
   - Bonus Skills (0-100): Nice-to-have skills present
4. Penalize heavily if the job requires skills or experience the candidate clearly lacks.
5. Determine applyType strictly:
   - 'EXTERNAL': job description directs applicants to apply on a company website, external career portal (Workday, Greenhouse, Lever, Taleo, iCIMS, or custom link), or email.
   - 'EASY_APPLY': job posting specifies applying on LinkedIn directly or has no external apply link mentioned.
   - 'UNKNOWN': uncertain.
6. CRITICAL ROLE & PROFESSION INTEGRITY:
   - You MUST verify that the primary job profession matches the candidate's profession.
   - If the candidate is a Designer (UI/UX, Product Designer, Interaction Designer) but the job is an Engineering/Development role (Frontend Developer, Full Stack Engineer, Software Developer, React Engineer), totalScore MUST be capped under 40% and marked REJECT. Collaborating with developers does NOT make a designer qualified as a developer.
   - If the candidate is a Software Developer, do NOT approve Designer, Sales, or HR roles.
   - If the core job discipline does not match the candidate's primary discipline, totalScore MUST be below 45%.

OUTPUT FORMAT:
You MUST evaluate EVERY job in the input list and return a JSON object with a "results" array.
Each element in "results" must contain:
- jobId: string (must match the input jobId exactly)
- totalScore: integer 0-100 (weighted average based on provided weights)
- subScores: object with coreTechnicalStack (integer), seniorityAlignment (integer), domainRelevance (integer), bonusSkills (integer)
- applyType: 'EASY_APPLY' | 'EXTERNAL' | 'UNKNOWN'
- pros: array of strings (matching points)
- cons: array of strings (weaknesses or mismatches)
- missingSkills: array of strings (required skills the candidate lacks)
- reasoning: a 2-3 sentence explanation of why this score was given`;

// ============================================================
// Response Validation Schema
// ============================================================

const SubScoresSchema = z.object({
  coreTechnicalStack: z.number().optional(),
  techStack: z.number().optional(),
  seniorityAlignment: z.number().optional(),
  seniority: z.number().optional(),
  domainRelevance: z.number().optional(),
  domain: z.number().optional(),
  bonusSkills: z.number().optional(),
  bonus: z.number().optional(),
}).transform((val) => {
  const core = Math.round(val.coreTechnicalStack ?? val.techStack ?? 0);
  const sen = Math.round(val.seniorityAlignment ?? val.seniority ?? 0);
  const dom = Math.round(val.domainRelevance ?? val.domain ?? 0);
  const bon = Math.round(val.bonusSkills ?? val.bonus ?? 0);
  return {
    coreTechnicalStack: core,
    seniorityAlignment: sen,
    domainRelevance: dom,
    bonusSkills: bon,
    techStack: core,
    seniority: sen,
    domain: dom,
    bonus: bon,
  };
});

const BatchJobResultSchema = z.object({
  jobId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  totalScore: z.number().min(0).max(100).transform((v) => Math.round(v)),
  subScores: SubScoresSchema.default({}),
  applyType: z.enum(["EASY_APPLY", "EXTERNAL", "UNKNOWN"]).default("UNKNOWN"),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  missingSkills: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
});

function parseAndValidateBatchResponse(content: any): z.infer<typeof BatchJobResultSchema>[] {
  let list: any = content;
  if (content && typeof content === "object") {
    if (Array.isArray(content)) {
      list = content;
    } else if (Array.isArray(content.results)) {
      list = content.results;
    } else if (Array.isArray(content.evaluations)) {
      list = content.evaluations;
    } else if (Array.isArray(content.jobs)) {
      list = content.jobs;
    } else {
      const arrKey = Object.keys(content).find((k) => Array.isArray(content[k]));
      if (arrKey) {
        list = content[arrKey];
      }
    }
  }

  if (!Array.isArray(list)) {
    throw new Error("Expected an array of job evaluation results");
  }

  return z.array(BatchJobResultSchema).parse(list);
}

// ============================================================
// Real-time Evaluation Progress Tracker
// ============================================================

export interface EvaluationProgress {
  isRunning: boolean;
  total: number;
  current: number;
  approvedCount: number;
  rejectedCount: number;
  currentJobTitle: string;
  currentCompany: string;
  currentScore: number | null;
  status: "idle" | "evaluating" | "completed" | "error";
  error: string | null;
  startedAt?: number;
  completedAt?: number;
}

let currentProgress: EvaluationProgress = {
  isRunning: false,
  total: 0,
  current: 0,
  approvedCount: 0,
  rejectedCount: 0,
  currentJobTitle: "",
  currentCompany: "",
  currentScore: null,
  status: "idle",
  error: null,
};

export function getEvaluationProgress(): EvaluationProgress {
  return { ...currentProgress };
}

export let shouldStopEvaluation = false;

export function stopEvaluation() {
  shouldStopEvaluation = true;
  abortAiOperations(true);
  currentProgress.isRunning = false;
  currentProgress.status = "stopped" as any;
  console.log(chalk.red("\n  ⏹ [STOP] AI Evaluation halted immediately by user."));
}

// ============================================================
// Compact Candidate Profile (prevents raw PDF repetition)
// ============================================================

function getCandidateProfileSummary(resumeText: string): string {
  const profile = loadCandidateProfile();
  const parts: string[] = [];

  if (profile.search?.titles && profile.search.titles.length > 0) {
    parts.push(`Target Titles: ${profile.search.titles.join(", ")}`);
  }
  if (profile.search?.locations && profile.search.locations.length > 0) {
    parts.push(`Target Locations: ${profile.search.locations.join(", ")}`);
  }
  if (profile.personal_info?.city) {
    parts.push(`Location: ${profile.personal_info.city}`);
  }
  if (profile.professional?.years_of_experience) {
    parts.push(`Experience: ${profile.professional.years_of_experience} years`);
  }
  if (profile.education?.degree) {
    parts.push(`Education: ${profile.education.degree}${profile.education.university ? ` (${profile.education.university})` : ""}`);
  }

  // Add clean concise excerpt of resume text (up to 2500 chars) for core skills and highlights
  if (resumeText) {
    const cleanText = resumeText
      .replace(/[\r\n]+/g, "\n")
      .replace(/\s+/g, " ")
      .trim();
    const excerpt = cleanText.length > 2500 ? cleanText.substring(0, 2500) + "..." : cleanText;
    parts.push(`\nResume Highlights:\n${excerpt}`);
  }

  return parts.join("\n");
}

// ============================================================
// Known Scores Cache & Persistence
// ============================================================

function getKnownScoresMap(): Map<string, { matchScore: number; aiScoreDetails: GeminiScore; applyType?: "EASY_APPLY" | "EXTERNAL" }> {
  const map = new Map<string, { matchScore: number; aiScoreDetails: GeminiScore; applyType?: "EASY_APPLY" | "EXTERNAL" }>();

  // Check jobs_raw.json
  if (fs.existsSync(paths.jobsRaw)) {
    try {
      const rawList = JSON.parse(fs.readFileSync(paths.jobsRaw, "utf-8"));
      if (Array.isArray(rawList)) {
        for (const item of rawList) {
          if (item && item.matchScore !== undefined && item.aiScoreDetails) {
            const scoreData = { matchScore: item.matchScore, aiScoreDetails: item.aiScoreDetails, applyType: item.applyType };
            if (item.url) map.set(item.url, scoreData);
            if (item.jobUrl) map.set(item.jobUrl, scoreData);
            if (item.id) map.set(String(item.id), scoreData);
          }
        }
      }
    } catch {}
  }

  // Check jobs_approved.json
  if (fs.existsSync(paths.jobsApproved)) {
    try {
      const appList = JSON.parse(fs.readFileSync(paths.jobsApproved, "utf-8"));
      if (Array.isArray(appList)) {
        for (const item of appList) {
          if (item && item.matchScore !== undefined && item.aiScoreDetails) {
            const scoreData = { matchScore: item.matchScore, aiScoreDetails: item.aiScoreDetails, applyType: item.applyType };
            if (item.url) map.set(item.url, scoreData);
            if (item.jobUrl) map.set(item.jobUrl, scoreData);
            if (item.id) map.set(String(item.id), scoreData);
          }
        }
      }
    } catch {}
  }

  return map;
}

function updateRawJobsFile(updatedJobs: RawJob[]) {
  if (!fs.existsSync(paths.jobsRaw)) return;
  try {
    const rawList = JSON.parse(fs.readFileSync(paths.jobsRaw, "utf-8"));
    if (!Array.isArray(rawList)) return;
    const updateMap = new Map<string, RawJob>();
    for (const j of updatedJobs) {
      if (j.url) updateMap.set(j.url, j);
      if (j.id) updateMap.set(String(j.id), j);
    }
    const merged = rawList.map((item: any) => {
      const match = (item.url && updateMap.get(item.url)) || (item.id && updateMap.get(String(item.id)));
      if (match) {
        return {
          ...item,
          matchScore: (match as any).matchScore,
          aiScoreDetails: (match as any).aiScoreDetails,
          applyType: (match as any).applyType || item.applyType,
        };
      }
      return item;
    });
    fs.writeFileSync(paths.jobsRaw, JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to update jobs_raw.json:", err);
  }
}

// ============================================================
// Adaptive Batch Creation
// ============================================================

function createJobBatches(jobs: RawJob[], maxBatchSize: number = 10, maxCharsPerBatch: number = 20000): RawJob[][] {
  const batches: RawJob[][] = [];
  let currentBatch: RawJob[] = [];
  let currentBatchChars = 0;

  for (const job of jobs) {
    const descLen = (job.description || "").length;
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchSize || currentBatchChars + descLen > maxCharsPerBatch)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchChars = 0;
    }
    currentBatch.push(job);
    currentBatchChars += descLen;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

// ============================================================
// Batch Scoring Execution
// ============================================================

async function scoreBatchWithRetry(
  aiConfig: AiConfig,
  apiKeys: string[],
  batch: RawJob[],
  candidateSummary: string,
  settings: Settings,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<Map<string, GeminiScore>> {
  const jobsPayload = batch.map((j, idx) => ({
    jobId: j.id ? String(j.id) : `job-${idx + 1}`,
    title: j.title,
    company: (j as any).companyName || j.company || "Unknown",
    location: j.location || "Unknown",
    description: (j.description || "").substring(0, 2000),
  }));

  const userPrompt = `=== CANDIDATE PROFILE ===
${candidateSummary}

Evaluation Weights:
- Tech Stack: ${settings.evaluation_weights.core_technical_stack}%
- Seniority: ${settings.evaluation_weights.seniority_alignment}%
- Domain: ${settings.evaluation_weights.domain_relevance}%
- Bonus: ${settings.evaluation_weights.bonus_skills}%

=== JOBS TO EVALUATE (${batch.length} jobs) ===
${JSON.stringify(jobsPayload, null, 2)}

Evaluate all ${batch.length} jobs. Return a JSON object with format:
{ "results": [ { "jobId": "...", "totalScore": 85, "subScores": { "coreTechnicalStack": 90, "seniorityAlignment": 80, "domainRelevance": 85, "bonusSkills": 80 }, "applyType": "EASY_APPLY", "pros": [...], "cons": [...], "missingSkills": [...], "reasoning": "..." } ] }`;

  const maxRetries = 2;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const rawJson = await generateStructuredResponse(
        aiConfig,
        apiKeys,
        BATCH_SCORING_SYSTEM_PROMPT,
        userPrompt,
        fallbackConfig,
        fallbackApiKeys
      );

      const validated = parseAndValidateBatchResponse(rawJson);
      console.log(chalk.gray(`  [SCORING] Batch schema valid: true`));

      const resultsMap = new Map<string, GeminiScore>();
      for (const res of validated) {
        resultsMap.set(res.jobId, {
          totalScore: res.totalScore,
          subScores: res.subScores as any,
          applyType: res.applyType,
          pros: res.pros,
          cons: res.cons,
          missingSkills: res.missingSkills,
          reasoning: res.reasoning,
        });
      }

      return resultsMap;
    } catch (err: any) {
      lastError = err;
      console.warn(
        chalk.yellow(`  ⚠ [SCORING] Batch attempt ${attempt}/${maxRetries} failed: ${err.message}`)
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  console.log(chalk.gray(`  [SCORING] Batch schema valid: false`));
  console.error(chalk.red(`  ✖ [SCORING] Batch permanently failed after ${maxRetries} attempts.`));
  return new Map();
}

// ============================================================
// Evaluate All Jobs (Batched & Deduplicated)
// ============================================================

export async function evaluateJobs(
  jobs: RawJob[],
  resumeText: string,
  settings: Settings
): Promise<ScoredJob[]> {
  const { config: aiConfig, apiKeys, fallbackConfig, fallbackApiKeys } = getModelForTask(settings, "scoring");

  // Deduplicate incoming jobs by URL and ID
  const seenKeys = new Set<string>();
  const dedupedJobs: RawJob[] = [];
  for (const j of jobs) {
    const key = j.url || j.id;
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedJobs.push(j);
    } else if (!key) {
      dedupedJobs.push(j);
    }
  }

  // Load existing score cache
  const knownScores = getKnownScoresMap();
  const alreadyScored: RawJob[] = [];
  const toScore: RawJob[] = [];

  for (const job of dedupedJobs) {
    const key = job.url || job.id;
    const existing = key ? knownScores.get(key) : null;
    if (existing && existing.matchScore !== undefined && existing.aiScoreDetails) {
      (job as any).matchScore = existing.matchScore;
      (job as any).aiScoreDetails = existing.aiScoreDetails;
      if (existing.applyType) (job as any).applyType = existing.applyType;
      alreadyScored.push(job);
    } else {
      toScore.push(job);
    }
  }

  // Required diagnostics
  console.log(chalk.cyan.bold(`\n--- AI SCORING PIPELINE ---`));
  console.log(chalk.gray(`[SCORING] Current scrape jobs: ${dedupedJobs.length}`));
  console.log(chalk.gray(`[SCORING] Previously scored reused: ${alreadyScored.length}`));
  console.log(chalk.gray(`[SCORING] New jobs requiring AI: ${toScore.length}`));

  const approvedJobs: ScoredJob[] = [];
  shouldStopEvaluation = false;
  abortAiOperations(false);

  // Add previously approved jobs
  for (const job of alreadyScored) {
    const score = (job as any).matchScore;
    if (score >= settings.evaluation_weights.match_threshold) {
      const applyType = (job as any).applyType === "EASY_APPLY" ? "EASY_APPLY" : "EXTERNAL";
      approvedJobs.push({
        ...job,
        matchScore: score,
        aiScoreDetails: (job as any).aiScoreDetails,
        applyType,
      });
    }
  }

  // If no new jobs require AI, finish early
  if (toScore.length === 0) {
    console.log(chalk.green(`\n✔ [SCORING] All jobs already evaluated. Reusing scores.`));
    console.log(chalk.gray(`[SCORING] Final scored jobs: ${alreadyScored.length}`));
    writeApprovedJobs(approvedJobs);
    return approvedJobs;
  }

  // Partition new jobs into batches
  const batches = createJobBatches(toScore, 10, 20000);
  const candidateSummary = getCandidateProfileSummary(resumeText);

  console.log(chalk.gray(`[SCORING] Batch size: ${batches[0]?.length || 0}`));
  console.log(chalk.gray(`[SCORING] Number of Gemini requests: ${batches.length}`));
  console.log(chalk.gray(`[SCORING] Gemini model: ${aiConfig.model}`));

  currentProgress = {
    isRunning: true,
    total: toScore.length,
    current: 0,
    approvedCount: approvedJobs.length,
    rejectedCount: alreadyScored.length - approvedJobs.length,
    currentJobTitle: "",
    currentCompany: "",
    currentScore: null,
    status: "evaluating",
    error: null,
    startedAt: Date.now(),
  };

  let newlyScoredCount = 0;
  const processedToScoreJobs: RawJob[] = [];

  try {
    for (let b = 0; b < batches.length; b++) {
      if (shouldStopEvaluation) {
        console.log(chalk.yellow(`\n  ⚠ [SCORING] Evaluation stopped by user.`));
        break;
      }
      if (approvedJobs.length >= settings.ai.max_approved_jobs) {
        console.log(
          chalk.yellow(
            `\n  ⚠ [SCORING] Reached maximum approved jobs limit (${settings.ai.max_approved_jobs}). Stopping.`
          )
        );
        break;
      }

      const batch = batches[b];
      console.log(chalk.blue.bold(`\n[SCORING] Batch ${b + 1}/${batches.length} (${batch.length} jobs)`));

      const resultsMap = await scoreBatchWithRetry(
        aiConfig,
        apiKeys,
        batch,
        candidateSummary,
        settings,
        fallbackConfig,
        fallbackApiKeys
      );

      console.log(chalk.gray(`  [SCORING] Batch result count: ${resultsMap.size}`));

      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        const jobId = job.id ? String(job.id) : `job-${i + 1}`;
        const scoreResult = resultsMap.get(jobId);

        newlyScoredCount++;
        currentProgress.current = newlyScoredCount;
        currentProgress.currentJobTitle = job.title;
        currentProgress.currentCompany = (job as any).companyName || job.company || "";

        if (scoreResult) {
          const totalScore = scoreResult.totalScore;
          currentProgress.currentScore = totalScore;
          (job as any).matchScore = totalScore;
          (job as any).aiScoreDetails = scoreResult;

          let finalApplyType: "EASY_APPLY" | "EXTERNAL";
          if (scoreResult.applyType === "EASY_APPLY" || scoreResult.applyType === "EXTERNAL") {
            finalApplyType = scoreResult.applyType;
          } else if (job.applyType === "EASY_APPLY" || job.applyType === "EXTERNAL") {
            finalApplyType = job.applyType;
          } else {
            finalApplyType = "EXTERNAL";
          }
          (job as any).applyType = finalApplyType;

          if (totalScore >= settings.evaluation_weights.match_threshold) {
            console.log(chalk.green(`    ✔ ${job.title} @ ${job.company}: APPROVED (${totalScore}%) [${finalApplyType}]`));
            currentProgress.approvedCount++;
            approvedJobs.push({
              ...job,
              matchScore: totalScore,
              aiScoreDetails: scoreResult,
              applyType: finalApplyType,
            });
          } else {
            console.log(chalk.gray(`    ✗ ${job.title} @ ${job.company}: REJECTED (${totalScore}%)`));
            currentProgress.rejectedCount++;
          }
        } else {
          console.log(chalk.red(`    ✖ ${job.title} @ ${job.company}: SCORING FAILED`));
          (job as any).matchScore = 0;
          currentProgress.rejectedCount++;
        }

        processedToScoreJobs.push(job);
      }

      // Incremental persistence
      updateRawJobsFile(processedToScoreJobs);
      writeApprovedJobs(approvedJobs);

      // Polite pause between batches to prevent quota pressure
      if (b < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    currentProgress.isRunning = false;
    currentProgress.status = "completed";
    currentProgress.completedAt = Date.now();
  } catch (err: any) {
    currentProgress.isRunning = false;
    currentProgress.status = "error";
    currentProgress.error = err.message;
    throw err;
  }

  // Final persistence
  updateRawJobsFile(processedToScoreJobs);
  writeApprovedJobs(approvedJobs);

  const finalScoredCount = alreadyScored.length + newlyScoredCount;
  console.log(chalk.green.bold(`\n[SCORING] Final scored jobs: ${finalScoredCount}`));

  return approvedJobs;
}

// ============================================================
// File Operations
// ============================================================

export function writeApprovedJobs(jobs: ScoredJob[]): void {
  // Merge with existing approved jobs so newly approved jobs are saved without losing previous ones
  let existingApproved: ScoredJob[] = [];
  if (fs.existsSync(paths.jobsApproved)) {
    try {
      existingApproved = JSON.parse(fs.readFileSync(paths.jobsApproved, "utf-8"));
    } catch {}
  }

  const seen = new Set<string>();
  const merged: ScoredJob[] = [];

  for (const j of jobs) {
    const key = j.url || j.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(j);
    } else if (!key) {
      merged.push(j);
    }
  }

  for (const j of existingApproved) {
    const key = j.url || j.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(j);
    }
  }

  fs.writeFileSync(paths.jobsApproved, JSON.stringify(merged, null, 2), "utf-8");
}

export function readApprovedJobs(): ScoredJob[] {
  if (!fs.existsSync(paths.jobsApproved)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(paths.jobsApproved, "utf-8")) as any[];
  return raw.map((j) => {
    const norm = normalizeRawJobInput(j);
    return {
      ...norm,
      ...j,
      url: norm.url || j.url || j.jobUrl || j.applyUrl || "",
      company: norm.company || j.company || j.companyName || "",
      title: norm.title || j.title || j.jobTitle || "",
    };
  }) as ScoredJob[];
}

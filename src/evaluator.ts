/**
 * evaluator.ts — Dual-Provider AI job match scoring engine
 *
 * Sends each filtered job description + the candidate's resume to the AI API
 * and receives a structured match score. Jobs scoring above the configured
 * threshold are approved for the dual-track pipeline.
 */

import fs from "node:fs";
import chalk from "chalk";
import type { RawJob, ScoredJob, GeminiScore } from "./types.js";
import { normalizeRawJobInput } from "./types.js";
import type { Settings } from "./types.js";
import { paths, getApiKeys } from "./config.js";
import { generateStructuredResponse, type AiConfig } from "./ai.js";

// ============================================================
// System Prompt for Job Scoring
// ============================================================

const SCORING_SYSTEM_PROMPT = `You are a strict hiring match evaluator. Your task is to assess how well a candidate's resume aligns with a specific job description.

RULES:
1. Be strict and honest — only score above 80 if there is GENUINE, DEMONSTRABLE alignment between the candidate's skills/experience and the job requirements.
2. NEVER fabricate, invent, or assume skills that are not explicitly stated in the resume.
3. Evaluate this candidate against the job across these dimensions:
   - Core Technical Stack (0-100): Direct overlap of required tech skills
   - Seniority Alignment (0-100): Experience level match
   - Domain Relevance (0-100): Industry/domain experience fit
   - Bonus Skills (0-100): Nice-to-have skills present
4. Penalize heavily if the job requires skills or experience the candidate clearly lacks.
5. Determine applyType strictly:
   - If the job description directs applicants to apply on a company website, external career portal (e.g. Workday, Greenhouse, Lever, Taleo, iCIMS, or custom link), or email, classify as 'EXTERNAL'.
   - If the job posting does not mention an external site/link, or specifies applying on LinkedIn directly, classify as 'EASY_APPLY'.
   - If truly uncertain, classify as 'UNKNOWN'.

Respond with a JSON object containing:
- totalScore: integer 0-100 (calculate this as a weighted average based on the user's provided weights, or just a holistic score if not provided)
- subScores: object with coreTechnicalStack (integer), seniorityAlignment (integer), domainRelevance (integer), bonusSkills (integer)
- applyType: string exactly 'EASY_APPLY' or 'EXTERNAL' or 'UNKNOWN'
- pros: array of strong matching points (strings)
- cons: array of weaknesses or mismatches (strings)
- missingSkills: array of required skills the candidate lacks (strings)
- reasoning: a 2-3 sentence explanation of why this score was given`;

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

// ============================================================
// Score a Single Job
// ============================================================

async function scoreJob(
  aiConfig: AiConfig,
  apiKeys: string[],
  job: RawJob,
  resumeText: string,
  settings: Settings
): Promise<GeminiScore | null> {
  const companyStr = (job as any).companyName || job.company || "Unknown";
  const prompt = `
=== JOB DESCRIPTION ===
Title: ${job.title}
Company: ${companyStr}
${job.description}

=== CANDIDATE RESUME ===
${resumeText}

Evaluate the match. Apply these weights to the totalScore calculation:
- Tech Stack: ${settings.evaluation_weights.core_technical_stack}%
- Seniority: ${settings.evaluation_weights.seniority_alignment}%
- Domain: ${settings.evaluation_weights.domain_relevance}%
- Bonus: ${settings.evaluation_weights.bonus_skills}%`;

  try {
    const rawJson = await generateStructuredResponse(aiConfig, apiKeys, SCORING_SYSTEM_PROMPT, prompt);
    const tech = rawJson.subScores?.coreTechnicalStack ?? rawJson.subScores?.techStack ?? 0;
    const sen = rawJson.subScores?.seniorityAlignment ?? rawJson.subScores?.seniority ?? 0;
    const dom = rawJson.subScores?.domainRelevance ?? rawJson.subScores?.domain ?? 0;
    const bon = rawJson.subScores?.bonusSkills ?? rawJson.subScores?.bonus ?? 0;

    const score: GeminiScore = {
      totalScore: rawJson.totalScore || 0,
      subScores: {
        coreTechnicalStack: tech,
        seniorityAlignment: sen,
        domainRelevance: dom,
        bonusSkills: bon,
        techStack: tech,
        seniority: sen,
        domain: dom,
        bonus: bon,
      } as any,
      applyType: ["EASY_APPLY", "EXTERNAL", "UNKNOWN"].includes(rawJson.applyType) ? rawJson.applyType : "UNKNOWN",
      pros: rawJson.pros || [],
      cons: rawJson.cons || [],
      missingSkills: rawJson.missingSkills || [],
      reasoning: rawJson.reasoning || "",
    };
    return score;
  } catch (err) {
    console.error(
      chalk.red(`  ✖ AI error for "${job.title}" @ ${companyStr}:`),
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ============================================================
// Evaluate All Jobs
// ============================================================

export async function evaluateJobs(
  jobs: RawJob[],
  resumeText: string,
  settings: Settings
): Promise<ScoredJob[]> {
  const aiConfig: AiConfig = {
    provider: settings.ai.provider,
    model: settings.ai.model,
  };
  const apiKeys = getApiKeys(aiConfig.provider);

  console.log(
    chalk.white(
      `\n  🧠 Evaluating ${jobs.length} jobs using ${aiConfig.provider.toUpperCase()} (${aiConfig.model})...`
    )
  );

  const approvedJobs: ScoredJob[] = [];
  let evaluated = 0;

  currentProgress = {
    isRunning: true,
    total: jobs.length,
    current: 0,
    approvedCount: 0,
    rejectedCount: 0,
    currentJobTitle: "",
    currentCompany: "",
    currentScore: null,
    status: "evaluating",
    error: null,
    startedAt: Date.now(),
  };

  try {
    for (const job of jobs) {
      if (approvedJobs.length >= settings.ai.max_approved_jobs) {
        console.log(
          chalk.yellow(
            `\n  ⚠ Reached maximum approved jobs limit (${settings.ai.max_approved_jobs}). Stopping evaluation.`
          )
        );
        break;
      }

      evaluated++;
      const companyStr = (job as any).companyName || job.company || "Unknown";
      const titleStr = job.title || "Unknown Title";
      const progress = `[${evaluated}/${jobs.length}]`;

      currentProgress.current = evaluated;
      currentProgress.currentJobTitle = titleStr;
      currentProgress.currentCompany = companyStr;

      process.stdout.write(
        chalk.gray(`  ${progress} Scoring: ${companyStr.substring(0, 15)} — "${titleStr.substring(0, 30)}"... `)
      );

      const scoreResult = await scoreJob(aiConfig, apiKeys, job, resumeText, settings);

      if (!scoreResult) {
        console.log(chalk.red("API ERROR"));
        continue;
      }

      const { totalScore, applyType } = scoreResult;
      // Prioritize AI detection if valid (EASY_APPLY or EXTERNAL), otherwise fall back to job.applyType or EXTERNAL
      let finalApplyType: "EASY_APPLY" | "EXTERNAL";
      if (applyType === "EASY_APPLY" || applyType === "EXTERNAL") {
        finalApplyType = applyType;
      } else if (job.applyType === "EASY_APPLY" || job.applyType === "EXTERNAL") {
        finalApplyType = job.applyType;
      } else {
        finalApplyType = "EXTERNAL";
      }

      currentProgress.currentScore = totalScore;
      (job as any).matchScore = totalScore;
      (job as any).aiScoreDetails = scoreResult;

      if (totalScore >= settings.evaluation_weights.match_threshold) {
        console.log(chalk.green(`APPROVED (${totalScore}%) [${finalApplyType}]`));
        currentProgress.approvedCount++;
        approvedJobs.push({
          ...job,
          matchScore: totalScore,
          aiScoreDetails: scoreResult,
          applyType: finalApplyType as "EASY_APPLY" | "EXTERNAL",
        });
        writeApprovedJobs(approvedJobs);
      } else {
        console.log(chalk.red(`REJECTED (${totalScore}%)`));
        currentProgress.rejectedCount++;
      }

      // Incremental save of raw jobs with matchScores & details so UI can show them immediately
      fs.writeFileSync(paths.jobsRaw, JSON.stringify(jobs, null, 2), "utf-8");

      // Modest rate limiting delay
      await new Promise((resolve) => setTimeout(resolve, 800));
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

  // Final rewrite
  fs.writeFileSync(paths.jobsRaw, JSON.stringify(jobs, null, 2), "utf-8");
  writeApprovedJobs(approvedJobs);

  return approvedJobs;
}

// ============================================================
// File Operations
// ============================================================

export function writeApprovedJobs(jobs: ScoredJob[]): void {
  fs.writeFileSync(paths.jobsApproved, JSON.stringify(jobs, null, 2), "utf-8");
  console.log(
    chalk.green.bold(
      `\n  ✔ Saved ${jobs.length} approved jobs to jobs_approved.json`
    )
  );
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

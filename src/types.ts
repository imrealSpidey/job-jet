/**
 * types.ts — Shared TypeScript interfaces and Zod schemas
 *
 * All data shapes flowing through the pipeline are defined and validated here.
 * Zod schemas provide runtime validation; TypeScript types are inferred from them.
 *
 * The RawJob schema is intentionally flexible — it normalizes field names from
 * various cloud scraper outputs (Apify, PhantomBuster, etc.) so the rest of
 * the pipeline can work with a single canonical shape.
 */

import { z } from "zod";

// ============================================================
// Raw Job — Flexible Apify / Cloud Scraper Input
// ============================================================

/**
 * Normalizes field names from various scraper JSON conventions
 * into a single canonical shape before Zod validation.
 *
 * Supports: url/jobUrl/link, company/companyName, title/jobTitle, etc.
 */
export function normalizeRawJobInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  // Map Bebity's applicationsCount to our applicationsCount property
  let appsCount = input.applicationsCount ?? input.applicants ?? input.numberOfApplicants ?? input.applicantCount ?? undefined;
  if (typeof appsCount === "string") {
    const match = appsCount.match(/\d+/);
    appsCount = match ? parseInt(match[0], 10) : undefined;
  }

  return {
    id: input.id ?? input.jobId ?? input.idString ?? undefined,
    url: input.url ?? input.jobUrl ?? input.link ?? input.applyUrl ?? "",
    title: input.title ?? input.jobTitle ?? input.position ?? "",
    company: input.company ?? input.companyName ?? input.employer ?? "",
    location: input.location ?? input.jobLocation ?? input.place ?? "Unknown",
    // Prioritize plain text description from Bebity
    description: input.description ?? input.jobDescription ?? input.descriptionText ?? "",
    postedAt: input.postedAt ?? input.postedDate ?? input.publishedAt ?? input.datePosted ?? undefined,
    applicationsCount: appsCount,
    easyApply: input.easyApply ?? input.isEasyApply ?? input.easy_apply ?? undefined,
    // Map applyType if Bebity gives it explicitly
    applyType: input.applyType ?? undefined,
    salaryMin: input.salaryMin ?? undefined,
    salaryMax: input.salaryMax ?? undefined,
  };
}

export const RawJobSchema = z.object({
  id: z.string().optional(),
  url: z.string().url("Job URL must be a valid URL"),
  title: z.string().min(1, "Job title is required"),
  company: z.string().min(1, "Company name is required"),
  location: z.string().default("Unknown"),
  description: z.string().default(""),
  postedAt: z.string().optional(),
  applicationsCount: z.number().optional(),
  easyApply: z.boolean().optional(),
  applyType: z.enum(["EASY_APPLY", "EXTERNAL"]).optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
});

export type RawJob = z.infer<typeof RawJobSchema>;

// ============================================================
// Scored Job (after Gemini evaluation)
// ============================================================

export const GeminiScoreSchema = z.object({
  totalScore: z.number().min(0).max(100),
  subScores: z.object({
    coreTechnicalStack: z.number().min(0).max(100),
    seniorityAlignment: z.number().min(0).max(100),
    domainRelevance: z.number().min(0).max(100),
    bonusSkills: z.number().min(0).max(100),
  }),
  applyType: z.enum(["EASY_APPLY", "EXTERNAL", "UNKNOWN"]).optional(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  missingSkills: z.array(z.string()),
  reasoning: z.string(),
});

export type GeminiScore = z.infer<typeof GeminiScoreSchema>;

export interface ScoredJob extends RawJob {
  matchScore: number;
  aiScoreDetails: GeminiScore;
  applyType: "EASY_APPLY" | "EXTERNAL";
}

// ============================================================
// Form Answer (Tier 1 / 2 / 3)
// ============================================================

export type FormAnswerTier = "deterministic" | "ai_context" | "halt" | "tier1_deterministic" | "tier2_ai";

export interface FormAnswer {
  tier: FormAnswerTier;
  question: string;
  answer: string | null;
  /** If tier is 'halt', this explains why the system stopped */
  haltReason?: string;
}

// ============================================================
// Form Solving & Context
// ============================================================

export interface SolverContext {
  settings: any;
  geminiClient?: any;
  jobDescription: string;
  resumeText: string;
}

// ============================================================
// Application History (deduplication log)
// ============================================================

export interface HistoryEntry {
  url: string;
  title: string;
  company: string;
  status: ApplicationStatus;
  appliedAt: string;
  matchScore?: number;
}

// ============================================================
// Settings YAML schema
// ============================================================

export const CandidateProfileSchema = z.object({
  search: z.object({
    titles: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
  }).default({}),
  personal_info: z.object({
    phone: z.string().nullable().default(null),
    email: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
  }).default({}),
  professional: z.object({
    salary_expectation: z.string().nullable().default(null),
    years_of_experience: z.string().nullable().default(null),
    notice_period: z.string().nullable().default(null),
  }).default({}),
  links: z.object({
    linkedin_profile: z.string().nullable().default(null),
    portfolio_website: z.string().nullable().default(null),
    github: z.string().nullable().default(null),
  }).default({}),
  education: z.object({
    degree: z.string().nullable().default(null),
    university: z.string().nullable().default(null),
    gpa: z.string().nullable().default(null),
    graduation_year: z.string().nullable().default(null),
  }).default({}),
  compliance: z.object({
    visa_sponsorship: z.string().nullable().default(null),
    work_authorization: z.string().nullable().default(null),
    gender: z.string().nullable().default(null),
    race_ethnicity: z.string().nullable().default(null),
    veteran_status: z.string().nullable().default(null),
    disability_status: z.string().nullable().default(null),
  }).default({}),
  raw_extracted: z.boolean().default(false), // To indicate if it just came from AI
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

export const SettingsSchema = z.object({
  ingestion: z.object({
    mode: z.enum(["manual", "api"]).default("manual"),
    apify_actor_id: z.string().optional(),
    apify_input: z.record(z.string(), z.any()).optional(),
  }).default({ mode: "manual" }),

  ai: z.object({
    provider: z.enum(["gemini", "openrouter"]).default("gemini"),
    model: z.string().default("gemini-3.6-flash"),
    max_approved_jobs: z.number().int().positive().default(15),
  }),

  evaluation_weights: z.object({
    core_technical_stack: z.number().min(0).max(100),
    seniority_alignment: z.number().min(0).max(100),
    domain_relevance: z.number().min(0).max(100),
    bonus_skills: z.number().min(0).max(100),
    match_threshold: z.number().min(0).max(100).default(80),
  }).refine(
    (val) => 
      val.core_technical_stack + 
      val.seniority_alignment + 
      val.domain_relevance + 
      val.bonus_skills === 100,
    { message: "Evaluation weights must sum to exactly 100" }
  ).default({
    core_technical_stack: 40,
    seniority_alignment: 30,
    domain_relevance: 20,
    bonus_skills: 10,
    match_threshold: 80,
  }),

  safety: z.object({
    job_cooldown_min_s: z.number().min(0).default(45),
    job_cooldown_max_s: z.number().min(0).default(120),
    typing_speed_min_ms: z.number().min(0).default(40),
    typing_speed_max_ms: z.number().min(0).default(90),
    click_jitter_base_ms: z.number().min(0).default(2500),
    click_jitter_variance_ms: z.number().min(0).default(1200),
  }).default({}),

  browser: z
    .object({
      user_data_dir: z.string().default("./browser_profile"),
      headless: z.boolean().default(false),
      slow_mo: z.number().default(0),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ============================================================
// Blacklist YAML schema
// ============================================================

export const BlacklistSchema = z.object({
  companies: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
});

export type Blacklist = z.infer<typeof BlacklistSchema>;

// ============================================================
// CLI Flags
// ============================================================

export interface CliFlags {
  filterOnly: boolean;
  applyOnly: boolean;
  dryRun: boolean;
  openExternal: boolean;
  autoConfirm?: boolean;
  auditResume?: string;
  alignLinkedin?: string;
  prepInterview?: string;
}

// ============================================================
// Application Result (for final summary)
// ============================================================

export type ApplicationStatus = "applied" | "skipped" | "error" | "halted" | "exported";

export interface ApplicationResult {
  job: ScoredJob;
  status: ApplicationStatus;
  message?: string;
  answers: FormAnswer[];
}

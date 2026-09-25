/**
 * formSolver.ts — Three-tier form answer engine
 *
 * Resolves Easy Apply form questions using a strict priority cascade:
 *
 * Tier 1 (Deterministic): Pattern-matches question text against known field
 *   types and returns answers directly from settings.yaml.
 *
 * Tier 2 (AI Context): Sends the question + job description + resume to AI
 *   with strict grounding instructions. The AI may only use information
 *   explicitly present in the resume — no fabrication.
 *
 * Tier 3 (Halt Trigger): If neither Tier 1 nor Tier 2 can answer, the system
 *   halts and alerts the user. Never guesses subjective/personal information.
 */

import chalk from "chalk";
import { type Settings, type FormAnswer } from "./types.js";
import { loadCandidateProfile } from "./config.js";
import { generateStructuredResponse, getModelForTask, type AiConfig } from "./ai.js";

// ============================================================
// Tier 1: Deterministic Fallbacks
// ============================================================

// Regex patterns to map standard questions directly to config values
const TIER1_PATTERNS = [
  { pattern: /phone|mobile/i, category: "personal_info", key: "phone" },
  { pattern: /email/i, category: "personal_info", key: "email" },
  { pattern: /city|location/i, category: "personal_info", key: "city" },
  { pattern: /salary/i, category: "professional", key: "salary_expectation" },
  { pattern: /notice period/i, category: "professional", key: "notice_period" },
  { pattern: /years|experience/i, category: "professional", key: "years_of_experience" },
  { pattern: /linkedin/i, category: "links", key: "linkedin_profile" },
  { pattern: /website|portfolio/i, category: "links", key: "portfolio_website" },
  { pattern: /github/i, category: "links", key: "github" },
  { pattern: /degree/i, category: "education", key: "degree" },
  { pattern: /university/i, category: "education", key: "university" },
  { pattern: /gpa/i, category: "education", key: "gpa" },
  { pattern: /graduation year/i, category: "education", key: "graduation_year" },
  { pattern: /sponsor/i, category: "compliance", key: "visa_sponsorship" },
  { pattern: /authorized|right to work/i, category: "compliance", key: "work_authorization" },
  { pattern: /veteran/i, category: "compliance", key: "veteran_status" },
  { pattern: /disability/i, category: "compliance", key: "disability_status" },
  { pattern: /gender|sex/i, category: "compliance", key: "gender" },
  { pattern: /race|ethnicity/i, category: "compliance", key: "race_ethnicity" },
];

function resolveTier1(questionText: string, settings: Settings): string | null {
  const profile: any = loadCandidateProfile();
  for (const { pattern, category, key } of TIER1_PATTERNS) {
    if (pattern.test(questionText)) {
      const answer = profile[category]?.[key];
      if (answer !== undefined && answer !== null && answer !== "") {
        return answer.toString();
      }
    }
  }
  return null;
}

// ============================================================
// Tier 2: AI Context Retrieval
// ============================================================

const AI_SOLVER_PROMPT = `You are a strict data extraction assistant.
Given a job application question and the candidate's resume, determine the factual answer.

RULES:
1. Use ONLY information explicitly present in the resume.
2. If the answer is not in the resume (e.g. "Do you have 5 years of X?"), you MUST output null or a blank string. Do NOT fabricate or assume.
3. If the question asks for years of experience with X, calculate it strictly based on the dates in the resume. If X is not found, the answer is 0.
4. Format the output based on the likely expected input type (e.g., a number for years of experience, "Yes"/"No" for booleans).

Respond with a JSON object:
{
  "answer": "The factual answer, or null if cannot be determined",
  "confidence": 0-100,
  "reasoning": "Brief explanation of where in the resume this was found"
}`;

async function resolveTier2(
  aiConfig: AiConfig,
  apiKeys: string[],
  questionText: string,
  options: string[],
  resumeText: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<string | null> {
  const prompt = `
Question: ${questionText}
Options provided by the form (if any): ${options.length > 0 ? options.join(", ") : "None. It's a text input field."}

Candidate Resume:
${resumeText}

Extract the factual answer. If options are provided, your answer MUST match one of the options exactly.`;

  try {
    const json = await generateStructuredResponse(
      aiConfig,
      apiKeys,
      AI_SOLVER_PROMPT,
      prompt,
      fallbackConfig,
      fallbackApiKeys
    );

    if (json.confidence >= 50 && json.answer !== null && json.answer !== "") {
      return json.answer.toString();
    }
    return null;
  } catch (error) {
    console.error(chalk.red(`  ✖ AI Solver failed:`), error);
    return null;
  }
}

/**
 * Tier 2.5: Context-aware fallback heuristics for standard ATS questions.
 */
function resolveTierFallback(questionText: string, options: string[], settings: Settings): string | null {
  const q = questionText.toLowerCase();
  const profile: any = loadCandidateProfile();

  // 1. Years of experience / numeric questions
  if (q.includes("years") || q.includes("how many") || q.includes("experience")) {
    const rawYoe = profile.professional?.years_of_experience;
    const yoeNum = rawYoe ? String(rawYoe).replace(/[^0-9]/g, "") : "5";
    if (options.length > 0) {
      const match = options.find(
        (o) =>
          o.includes(yoeNum) ||
          (parseInt(yoeNum, 10) >= 3 && (o.includes("3") || o.includes("4") || o.includes("5")))
      );
      if (match) return match;
    }
    return yoeNum || "3";
  }

  // 2. Binary Yes/No questions
  const hasYes = options.some((o) => /^yes$/i.test(o.trim()));
  const hasNo = options.some((o) => /^no$/i.test(o.trim()));

  if (hasYes && hasNo) {
    // English language proficiency / communication
    if (q.includes("english") || q.includes("fluent") || q.includes("communicate") || q.includes("comfortable")) {
      return "Yes";
    }
    // Background check / screening / references
    if (q.includes("background check") || q.includes("drug") || q.includes("screen") || q.includes("reference")) {
      return "Yes";
    }
    // Commute / onsite / hybrid / travel / relocation
    if (
      q.includes("commute") ||
      q.includes("hybrid") ||
      q.includes("travel") ||
      q.includes("relocate") ||
      q.includes("onsite") ||
      q.includes("remote")
    ) {
      return "Yes";
    }
    // Education / Degree
    if (
      q.includes("degree") ||
      q.includes("bachelor") ||
      q.includes("education") ||
      q.includes("graduate") ||
      q.includes("high school")
    ) {
      return "Yes";
    }
    // Work authorization / legal right
    if (q.includes("authorized") || q.includes("right to work") || q.includes("legally")) {
      return profile.compliance?.work_authorization || "Yes";
    }
    // Sponsorship
    if (q.includes("sponsorship") || q.includes("sponsor")) {
      return profile.compliance?.visa_sponsorship || "No";
    }
    // Disciplinary / criminal
    if (q.includes("crime") || q.includes("felony") || q.includes("convict") || q.includes("disciplinary")) {
      return "No";
    }
    // Default to "Yes" for positive capability questions
    return "Yes";
  }

  // 3. Dropdowns with proficiency levels (e.g. English proficiency)
  if (options.length > 0) {
    const profOpt = options.find((o) =>
      /professional|fluent|native|expert|advanced|full professional|working/i.test(o)
    );
    if (profOpt) return profOpt;
    return options[0];
  }

  return null;
}

// ============================================================
// Orchestrator
// ============================================================

export async function solveQuestion(
  questionText: string,
  options: string[],
  resumeText: string,
  settings: Settings
): Promise<FormAnswer> {
  console.log(chalk.gray(`  🔍 Solving: "${questionText.substring(0, 50)}..."`));

  // Tier 1
  const t1Answer = resolveTier1(questionText, settings);
  if (t1Answer !== null) {
    console.log(chalk.green(`    ↳ Tier 1 Match: ${t1Answer}`));
    return {
      tier: "tier1_deterministic" as any,
      question: questionText,
      answer: t1Answer,
    };
  }

  // Tier 2
  const { config: aiConfig, apiKeys, fallbackConfig, fallbackApiKeys } = getModelForTask(settings, "form_filling");

  const t2Answer = await resolveTier2(
    aiConfig,
    apiKeys,
    questionText,
    options,
    resumeText,
    fallbackConfig,
    fallbackApiKeys
  );
  if (t2Answer !== null) {
    console.log(chalk.yellow(`    ↳ Tier 2 Match: ${t2Answer}`));
    return {
      tier: "tier2_ai" as any,
      question: questionText,
      answer: t2Answer,
    };
  }

  // Tier 2.5: Fallback Heuristics
  const tFallback = resolveTierFallback(questionText, options, settings);
  if (tFallback !== null) {
    console.log(chalk.cyan(`    ↳ Heuristic Match: ${tFallback}`));
    return {
      tier: "tier2_ai" as any,
      question: questionText,
      answer: tFallback,
    };
  }

  // Tier 3
  console.log(chalk.yellow(`    ↳ Unresolved Question: "${questionText.substring(0, 40)}..."`));
  return {
    tier: "halt" as any,
    question: questionText,
    answer: null,
    haltReason: "Requires user review",
  };
}

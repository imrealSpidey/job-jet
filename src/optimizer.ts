/**
 * optimizer.ts — Phase 0 Upstream Preparation Toolkit
 *
 * Implements the "Editor, not Author" architectural constraint.
 * Uses the candidate's existing LinkedIn export and resume as an
 * absolute Source of Truth to prepare optimized ATS resumes,
 * LinkedIn profile updates, and interview prep dossiers.
 */

import fs from "node:fs";
import chalk from "chalk";
import { paths, getApiKeys } from "./config.js";
import { generateStructuredResponse, generateTextResponse, type AiConfig } from "./ai.js";

// ============================================================
// Core Constraint Prompt
// ============================================================

const EDITOR_SYSTEM_PROMPT = `You are an expert career strategist and ATS formatting editor.
CRITICAL CONSTRAINTS:
1. You are an EDITOR, not an AUTHOR.
2. Use ONLY the facts, skills, and experiences explicitly provided in the "Source of Truth".
3. Do NOT invent, fabricate, hallucinate, or assume any skills, metrics, titles, or dates.
4. If a required metric or fact is missing (e.g., to satisfy the Google XYZ formula), you MUST insert a "[FILL IN]" placeholder.
5. Your sole job is to format, structure, and strategically align the candidate's EXISTING truth to match the provided Job Description naturally.`;

// ============================================================
// 1. Resume Audit & Refine
// ============================================================

export async function auditAndRefineResume(
  jdText: string,
  sourceOfTruth: string,
  aiConfig: AiConfig
): Promise<void> {
  const apiKeys = getApiKeys(aiConfig.provider);
  console.log(chalk.blue.bold(`\n📄 [PHASE 0: RESUME OPTIMIZER]`));
  
  // Step 1: JSON Audit
  console.log(chalk.gray(`  Step 1: Auditing against Job Description...`));
  
  const auditPrompt = `
Job Description:
${jdText}

Source of Truth:
${sourceOfTruth}

Analyze the match and provide a structured JSON audit. The schema MUST have:
- matchScore (number)
- topMissingKeywords (array of strings)
- redFlags (array of strings)`;

  let missingKeywords: string[] = [];

  try {
    const audit = await generateStructuredResponse(aiConfig, apiKeys, EDITOR_SYSTEM_PROMPT, auditPrompt);

    console.log(chalk.cyan(`  ↳ Match Score: ${audit.matchScore}%`));
    console.log(chalk.yellow(`  ↳ Missing Keywords: ${audit.topMissingKeywords?.join(", ")}`));
    
    if (audit.redFlags && audit.redFlags.length > 0) {
      console.log(chalk.red(`  ↳ Red Flags:`));
      audit.redFlags.forEach((flag: string) => console.log(chalk.red(`      - ${flag}`)));
    }
    
    missingKeywords = audit.topMissingKeywords || [];
  } catch (err) {
    console.error(chalk.red(`  ✖ Audit failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Step 2: Markdown Rewrite
  console.log(chalk.gray(`\n  Step 2: Rewriting resume bullets to Google XYZ format...`));

  const rewritePrompt = `
Job Description:
${jdText}

Missing Keywords to naturally embed if applicable: ${missingKeywords.join(", ")}

Source of Truth:
${sourceOfTruth}

Rewrite the experience section of the candidate's resume.
RULES:
1. Output in Markdown format.
2. Strictly apply the Google XYZ Formula to every bullet point: "Accomplished [X] as measured by [Y] by doing [Z]".
3. DO NOT INVENT METRICS. Use [FILL IN] if the source of truth lacks the exact numbers for [Y].
4. Return ONLY the markdown text. No intro/outro.`;

  try {
    const markdown = await generateTextResponse(aiConfig, apiKeys, EDITOR_SYSTEM_PROMPT, rewritePrompt);
    fs.writeFileSync(paths.atsResumePath, markdown, "utf-8");
    console.log(chalk.green.bold(`  ✔ Saved optimized resume to: ${paths.atsResumePath}`));
    console.log(chalk.magenta(`  (Remember to review and replace any [FILL IN] tags!)`));
  } catch (err) {
    console.error(chalk.red(`  ✖ Rewrite failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ============================================================
// 2. LinkedIn Profile Aligner
// ============================================================

export async function alignLinkedInProfile(
  jdText: string,
  sourceOfTruth: string,
  aiConfig: AiConfig
): Promise<void> {
  const apiKeys = getApiKeys(aiConfig.provider);
  console.log(chalk.blue.bold(`\n🔗 [PHASE 0: LINKEDIN ALIGNER]`));
  console.log(chalk.gray(`  Generating profile recommendations...`));

  const prompt = `
Job Description:
${jdText}

Source of Truth:
${sourceOfTruth}

Generate LinkedIn profile optimizations based ONLY on the candidate's actual truth, aligned to attract recruiters for this JD.
Format the output in Markdown as follows:

# LinkedIn Profile Recommendations

## Headline Variations
Provide 3 variations (max 220 chars each) formatted as: [What I do] | [Key result] | [Niche]. Use keywords from the JD.

## About Section
Rewrite the summary to lead with the candidate's core problem-solving impact. Naturally embed 5-8 ATS keywords from the JD. Maximum 3 paragraphs. Use [FILL IN] if metrics are needed but missing.

## Top 5 Pinned Skills
A prioritized list of the top 5 skills the user should pin, based on the overlap between their real experience and JD requirements.

Return ONLY the markdown text.`;

  try {
    const markdown = await generateTextResponse(aiConfig, apiKeys, EDITOR_SYSTEM_PROMPT, prompt);
    fs.writeFileSync(paths.linkedinRecPath, markdown, "utf-8");
    console.log(chalk.green.bold(`  ✔ Saved recommendations to: ${paths.linkedinRecPath}`));
  } catch (err) {
    console.error(chalk.red(`  ✖ Generation failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ============================================================
// 3. Interview Prep Dossier
// ============================================================

export async function prepInterview(
  jdText: string,
  sourceOfTruth: string,
  aiConfig: AiConfig
): Promise<void> {
  const apiKeys = getApiKeys(aiConfig.provider);
  console.log(chalk.blue.bold(`\n🎙️ [PHASE 0: INTERVIEW PREP]`));
  console.log(chalk.gray(`  Compiling interview dossier...`));

  const prompt = `
Job Description:
${jdText}

Source of Truth:
${sourceOfTruth}

Generate a comprehensive, structured interview preparation dossier in Markdown format.
Include the following sections:

# Interview Preparation Dossier

## Predicted Interview Questions
List the top 10 questions the interviewer is likely to ask based on this specific JD.
Under each question, provide a sample answer structured in the STAR format, pulling specific examples DIRECTLY from the Source of Truth. If metrics are missing, use [FILL IN].

## High-Signal Questions to Ask
List 5 highly insightful, strategic questions the candidate should ask the interviewer to demonstrate deep understanding of the role's challenges.

## Salary Negotiation Strategy
Draft a formal negotiation script and an objection-handling script for HR screens, tailored to the seniority of this role.

Return ONLY the markdown text.`;

  try {
    const markdown = await generateTextResponse(aiConfig, apiKeys, EDITOR_SYSTEM_PROMPT, prompt);
    fs.writeFileSync(paths.interviewPrepPath, markdown, "utf-8");
    console.log(chalk.green.bold(`  ✔ Saved interview dossier to: ${paths.interviewPrepPath}`));
  } catch (err) {
    console.error(chalk.red(`  ✖ Generation failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

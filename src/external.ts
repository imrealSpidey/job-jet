/**
 * external.ts — External ATS Job Export & Handling
 *
 * Handles Track B (External/ATS) jobs:
 * 1. AI generation of customized 150-word cover notes based on resume
 * 2. Exporting external jobs + cover notes to Markdown
 * 3. Opening external job tabs in Playwright sequentially (--open-external)
 */

import fs from "node:fs";
import chalk from "chalk";

import { confirm } from "@inquirer/prompts";
import type { BrowserContext } from "playwright";
import type { ScoredJob, Settings } from "./types.js";
import { paths, appendHistory } from "./config.js";
import { launchBrowser, closeBrowser } from "./browser/session.js";
import { generateTextResponse, getModelForTask, type AiConfig } from "./ai.js";

// ============================================================
// Cover Note Generation
// ============================================================

const COVER_NOTE_SYSTEM_PROMPT = `You are an expert career advisor generating a concise, highly tailored elevator pitch / cover note.
RULES:
1. STRICTLY limited to 150 words.
2. Use ONLY facts, skills, and experience present in the provided resume.
3. Absolutely NO FABRICATION or hallucination.
4. Directly address the key requirements mentioned in the job description.
5. Output ONLY the raw cover note text. No introductory remarks.`;

async function generateCoverNote(
  aiConfig: AiConfig,
  apiKeys: string[],
  job: ScoredJob,
  resumeText: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<string> {
  const userPrompt = `
## Job Title: ${job.title}
## Company: ${job.company}

## Job Description:
${job.description}

---
## My Resume:
${resumeText}

Generate the 150-word cover note now.
`;

  try {
    const text = await generateTextResponse(
      aiConfig,
      apiKeys,
      COVER_NOTE_SYSTEM_PROMPT,
      userPrompt,
      fallbackConfig,
      fallbackApiKeys
    );
    return text.trim() || "Failed to generate cover note.";
  } catch (err) {
    console.warn(
      chalk.yellow(`  ⚠ Cover note generation failed: ${err instanceof Error ? err.message : String(err)}`)
    );
    return "Generation failed due to API error.";
  }
}

// ============================================================
// Export Shortlist
// ============================================================

export async function exportExternalShortlist(
  externalJobs: ScoredJob[],
  resumeText: string,
  settings: Settings
): Promise<void> {
  if (externalJobs.length === 0) return;

  const { config: aiConfig, apiKeys, fallbackConfig, fallbackApiKeys } = getModelForTask(settings, "form_filling");

  console.log(
    chalk.magenta.bold(`\n📝 [EXTERNAL]`),
    `Generating cover notes and exporting ${externalJobs.length} external jobs...`
  );

  let markdown = `# External Job Shortlist\n\nGenerated on: ${new Date().toLocaleString()}\n\n`;

  for (let i = 0; i < externalJobs.length; i++) {
    const job = externalJobs[i];
    process.stdout.write(
      chalk.gray(`  [${i + 1}/${externalJobs.length}] Generating pitch for ${job.company}... `)
    );

    const note = await generateCoverNote(aiConfig, apiKeys, job, resumeText, fallbackConfig, fallbackApiKeys);
    
    // Add to history so we don't process it again
    appendHistory({
      url: job.url,
      title: job.title,
      company: job.company,
      status: "exported",
      appliedAt: new Date().toISOString(),
      matchScore: job.matchScore,
    });

    console.log(chalk.green(`✔`));

    const pros = job.aiScoreDetails?.pros || (job as any).pros || [];
    const cons = job.aiScoreDetails?.cons || (job as any).cons || [];
    const missingSkills = job.aiScoreDetails?.missingSkills || (job as any).missingSkills || [];

    markdown += `## ${i + 1}. ${job.title} @ ${job.company} (Score: ${job.matchScore}%)\n`;
    markdown += `**URL:** ${job.url}\n\n`;
    markdown += `**Pros:**\n${pros.map((p: string) => `- ${p}`).join("\n")}\n\n`;
    markdown += `**Cons / Missing Skills:**\n${[...cons, ...missingSkills].map((c: string) => `- ${c}`).join("\n")}\n\n`;
    markdown += `### Elevator Pitch / Cover Note\n> ${note.split("\n").join("\n> ")}\n\n`;
    markdown += `---\n\n`;
    
    // Brief pause to respect API limits
    if (i < externalJobs.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  fs.writeFileSync(paths.externalShortlist, markdown, "utf-8");
  console.log(
    chalk.green.bold(`  ✔ Exported to: ${paths.externalShortlist}`)
  );
}

// ============================================================
// Open External Jobs in Playwright
// ============================================================

export async function openExternalJobs(
  jobs: ScoredJob[],
  settings: Settings
): Promise<void> {
  if (jobs.length === 0) return;

  console.log(
    chalk.magenta.bold(`\n🌐 [EXTERNAL]`),
    `Opening ${jobs.length} external jobs in browser...`
  );

  const proceed = await confirm({
    message: `Ready to open external jobs sequentially?`,
    default: true,
  });

  if (!proceed) return;

  const session = await launchBrowser(settings);
  
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      console.log(chalk.blue(`\n  Navigating to [${i + 1}/${jobs.length}]: ${job.title} @ ${job.company}`));
      
      const page = await session.context.newPage();
      await page.goto(job.url, { waitUntil: "domcontentloaded" });
      
      if (i < jobs.length - 1) {
        const next = await confirm({
          message: `Job opened. Review and apply, then press Y to open the next job, or N to stop.`,
          default: true,
        });
        if (!next) break;
      } else {
        console.log(chalk.green(`  ✔ All external jobs opened.`));
        await confirm({
          message: `Press Enter when you are done to close the browser.`,
          default: true,
        });
      }
    }
  } catch (err) {
    console.error(chalk.red(`  ✖ Error opening external jobs: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    await closeBrowser(session);
  }
}

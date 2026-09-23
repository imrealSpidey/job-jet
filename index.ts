/**
 * index.ts — Main Orchestrator (V2 Dual-Track + Phase 0)
 *
 * Drives the LinkedIn Easy Apply & External pipeline, plus Phase 0 preparation.
 *
 * Phase 0 (Upstream Prep): Optimizer tools for Resume, LinkedIn, and Interview.
 *    --audit-resume <path|id|url>
 *    --align-linkedin <path|id|url>
 *    --prep-interview <path|id|url>
 *
 * Phase 1 (Offline): Ingest (Manual/API) → Blacklist Filter → History Dedup 
 *    → Gemini Matrix Score → Write jobs_approved.json
 *
 * Phase 1.5 (External): Generate cover notes → Export markdown → optionally open tabs
 *
 * Phase 2+3 (Browser): Interactive CLI shortlist → Launch persistent Chromium 
 *    → Navigate to each Easy Apply job → Apply with Tier 1/2/3 form solver 
 *    → Pause for human review → Log result to history.json
 *
 * CLI Flags:
 *   --filter-only     Run Phase 1 only (no browser)
 *   --apply-only      Skip Phase 1, use existing jobs_approved.json
 *   --dry-run         Walk through forms without clicking buttons
 *   --open-external   Open external jobs in browser tabs
 */

import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  loadSettings,
  loadBlacklist,
  loadResumeText,
  loadSourceOfTruth,
  parseCliFlags,
  appendHistory,
  ensureDirectories,
  paths,
} from "./src/config.js";
import { runIngestionPipeline } from "./src/ingestion.js";
import {
  evaluateJobs,
  writeApprovedJobs,
  readApprovedJobs,
} from "./src/evaluator.js";
import { exportExternalShortlist, openExternalJobs } from "./src/external.js";
import { auditAndRefineResume, alignLinkedInProfile, prepInterview } from "./src/optimizer.js";
import { confirmShortlist } from "./src/cli.js";
import type { SolverContext } from "./src/types.js";
import { launchBrowser, closeBrowser } from "./src/browser/session.js";
import {
  openEasyApply,
  stepThroughModal,
  pauseForReview,
  safeCloseModal,
  captureErrorScreenshot,
} from "./src/browser/easyApply.js";
import { initSafetyConfig, jobCooldown } from "./src/browser/humanize.js";
import type {
  ScoredJob,
  ApplicationResult,
  ApplicationStatus,
} from "./src/types.js";

// ============================================================
// Banner
// ============================================================

function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     Job Jet Orchestrator  v2.0                               ║
║     Dual-Track · Matrix Evaluation · Configurable Safety     ║
║     Phase 0 Prep Toolkit Included                            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `)
  );
}

// ============================================================
// Smart JD Router (Phase 0)
// ============================================================

async function resolveJdText(input: string): Promise<string> {
  // If it's a file path
  if (input.endsWith(".txt") || input.endsWith(".md")) {
    const fullPath = path.resolve(process.cwd(), input);
    if (!fs.existsSync(fullPath)) {
      console.error(chalk.red.bold(`✖ [ERROR] JD file not found: ${fullPath}`));
      process.exit(1);
    }
    return fs.readFileSync(fullPath, "utf-8").trim();
  }

  // Otherwise, scan JSON datasets for matching ID or URL
  console.log(chalk.gray(`  Scanning local datasets for job: ${input}`));
  for (const jsonPath of [paths.jobsRaw, paths.jobsApproved]) {
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        if (Array.isArray(data)) {
          const match = data.find((job: any) => job.id === input || job.url === input);
          if (match && match.description) {
            console.log(chalk.green(`  ✔ Found matching JD in ${path.basename(jsonPath)}`));
            return match.description;
          }
        }
      } catch (err) {
        // ignore parse errors and continue
      }
    }
  }

  console.error(chalk.red.bold(`✖ [ERROR] Could not find JD text for input: ${input}`));
  process.exit(1);
}

// ============================================================
// Phase 1: Offline Filtering
// ============================================================

async function runPhase1(
  resumeText: string
): Promise<ScoredJob[]> {
  console.log(
    chalk.cyan.bold(`\n${"━".repeat(60)}`),
    chalk.cyan.bold(`\n  PHASE 1: Offline Filtering & Scoring`),
    chalk.cyan.bold(`\n${"━".repeat(60)}`)
  );

  const settings = loadSettings();
  const blacklist = loadBlacklist();

  // Step 1a: Ingest, filter, and deduplicate
  const filteredJobs = await runIngestionPipeline(blacklist, settings);

  if (filteredJobs.length === 0) {
    console.log(
      chalk.yellow.bold(`\n⚠ No jobs to score. Phase 1 complete.\n`)
    );
    return [];
  }

  // Step 1b: Score with Gemini Matrix
  const approvedJobs = await evaluateJobs(
    filteredJobs,
    resumeText,
    settings
  );

  // Step 1c: Save approved jobs
  if (approvedJobs.length > 0) {
    writeApprovedJobs(approvedJobs);
  } else {
    console.log(
      chalk.yellow.bold(
        `\n⚠ No jobs met the ${settings.evaluation_weights.match_threshold}% threshold.\n`
      )
    );
  }

  return approvedJobs;
}

// ============================================================
// Phase 2+3: Browser Automation with HITL
// ============================================================

async function runPhase2And3(
  easyApplyJobs: ScoredJob[],
  resumeText: string,
  dryRun: boolean
): Promise<ApplicationResult[]> {
  console.log(
    chalk.cyan.bold(`\n${"━".repeat(60)}`),
    chalk.cyan.bold(
      `\n  PHASE 2+3: Browser Automation (${dryRun ? "DRY RUN" : "LIVE"})`
    ),
    chalk.cyan.bold(`\n${"━".repeat(60)}`)
  );

  if (easyApplyJobs.length === 0) {
    console.log(chalk.yellow(`\n⚠ No Easy Apply jobs selected for automation.\n`));
    return [];
  }

  console.log(
    chalk.white(
      `\n  📋 ${easyApplyJobs.length} jobs queued for application\n`
    )
  );

  const settings = loadSettings();

  // Launch browser
  const session = await launchBrowser(settings);
  const results: ApplicationResult[] = [];

  try {
    for (let i = 0; i < easyApplyJobs.length; i++) {
      const job = easyApplyJobs[i];
      const progress = `[${i + 1}/${easyApplyJobs.length}]`;

      console.log(
        chalk.cyan.bold(`\n${"─".repeat(60)}`)
      );
      console.log(
        chalk.cyan.bold(
          `  ${progress} ${job.title} @ ${job.company} (${job.matchScore}%)`
        )
      );
      console.log(chalk.gray(`  ${job.url}`));

      let status: ApplicationStatus = "error";
      let message = "";
      let answers: import("./src/types.js").FormAnswer[] = [];

      try {
        // Navigate and open Easy Apply
        const opened = await openEasyApply(session.page, job.url);

        if (!opened) {
          status = "skipped";
          message = "Easy Apply button not found";
          console.log(
            chalk.yellow(`  ↳ Skipped: ${message}`)
          );
          results.push({ job, status, message, answers });
          continue;
        }

        // Build solver context for this job
        const solverContext: SolverContext = {
          settings,
          jobDescription: job.description,
          resumeText,
        };

        // Step through the modal form
        const stepResult = await stepThroughModal(
          session.page,
          job,
          solverContext,
          settings,
          dryRun
        );

        answers = stepResult.answers;

        if (stepResult.halted) {
          status = "halted";
          message = "Halted due to unresolvable question (Tier 3)";
          console.log(
            chalk.red.bold(`\n  🛑 Application halted — manual intervention required`)
          );

          // Show the review screen even though we halted
          await pauseForReview(session.page, job, answers);

          // Close the modal cleanly
          await safeCloseModal(session.page);
        } else if (stepResult.reachedReview) {
          // HITL: Pause for human review
          await pauseForReview(session.page, job, answers);
          status = "applied";
          message = "User reviewed and submitted";
        } else if (stepResult.error) {
          status = "error";
          message = stepResult.error;
          console.log(
            chalk.red(`  ✖ Error: ${message}`)
          );

          // Capture screenshot for diagnosis
          await captureErrorScreenshot(
            session.page,
            paths.screenshotsDir,
            job.title
          );

          // Close modal safely
          await safeCloseModal(session.page);
        } else if (dryRun) {
          status = "skipped";
          message = "Dry run — no actions taken";
          console.log(
            chalk.gray(`  [DRY-RUN] Form scan complete`)
          );
        }
      } catch (err) {
        status = "error";
        message = err instanceof Error ? err.message : String(err);
        console.error(
          chalk.red(`  ✖ Unexpected error: ${message}`)
        );

        // Capture screenshot and clean up
        await captureErrorScreenshot(
          session.page,
          paths.screenshotsDir,
          job.title
        );
        await safeCloseModal(session.page);
      }

      // Record result
      const result: ApplicationResult = { job, status, message, answers };
      results.push(result);

      // Append to history (skip dry-run)
      if (!dryRun && status !== "skipped") {
        appendHistory({
          url: job.url,
          title: job.title,
          company: job.company,
          status,
          appliedAt: new Date().toISOString(),
          matchScore: job.matchScore,
        });
      }

      // Use the configurable job cooldown
      if (i < easyApplyJobs.length - 1) {
        console.log(
          chalk.gray(`\n  ⏳ Waiting before next job (safety cooldown)...`)
        );
        await jobCooldown();
      }
    }
  } finally {
    await closeBrowser(session);
  }

  return results;
}

// ============================================================
// Final Summary
// ============================================================

function printFinalSummary(results: ApplicationResult[]): void {
  if (results.length === 0) return;

  console.log(chalk.cyan.bold(`\n${"═".repeat(60)}`));
  console.log(chalk.cyan.bold(`  EASY APPLY FINAL SUMMARY`));
  console.log(chalk.cyan.bold(`${"═".repeat(60)}`));

  const applied = results.filter((r) => r.status === "applied");
  const skipped = results.filter((r) => r.status === "skipped");
  const errors = results.filter((r) => r.status === "error");
  const halted = results.filter((r) => r.status === "halted");

  console.log(
    chalk.green(`  ✔ Applied:  ${applied.length}`)
  );
  console.log(
    chalk.yellow(`  ↷ Skipped:  ${skipped.length}`)
  );
  console.log(
    chalk.red(`  ✖ Errors:   ${errors.length}`)
  );
  console.log(
    chalk.red(`  🛑 Halted:   ${halted.length}`)
  );

  console.log(chalk.cyan(`${"─".repeat(60)}`));

  for (const result of results) {
    const icon =
      result.status === "applied"
        ? chalk.green("✔")
        : result.status === "skipped"
          ? chalk.yellow("↷")
          : result.status === "halted"
            ? chalk.red("🛑")
            : chalk.red("✖");

    console.log(
      `  ${icon} ${result.job.company.substring(0, 20).padEnd(22)} ${result.job.title.substring(0, 30).padEnd(32)} ${result.message || ""}`
    );
  }

  console.log(chalk.cyan.bold(`${"═".repeat(60)}\n`));
}

// ============================================================
// Main Entry Point
// ============================================================

async function main(): Promise<void> {
  printBanner();

  const flags = parseCliFlags();
  ensureDirectories();

  // --- Phase 0: Upstream Toolkit Intercept ---
  const isPhase0 = flags.auditResume || flags.alignLinkedin || flags.prepInterview;
  if (isPhase0) {
    console.log(chalk.magenta.bold(`\n🚀 [PHASE 0] Upstream Preparation Toolkit Initialized\n`));
    
    const sourceOfTruth = await loadSourceOfTruth();
    const settings = loadSettings();

    if (flags.auditResume) {
      const jdText = await resolveJdText(flags.auditResume);
      await auditAndRefineResume(jdText, sourceOfTruth, settings.ai);
    }
    
    if (flags.alignLinkedin) {
      const jdText = await resolveJdText(flags.alignLinkedin);
      await alignLinkedInProfile(jdText, sourceOfTruth, settings.ai);
    }
    
    if (flags.prepInterview) {
      const jdText = await resolveJdText(flags.prepInterview);
      await prepInterview(jdText, sourceOfTruth, settings.ai);
    }

    console.log(chalk.magenta.bold(`\n✔ Phase 0 toolkit execution complete. Exiting.`));
    return;
  }

  // --- Normal Pipeline Start ---

  // Display mode
  if (flags.dryRun) {
    console.log(chalk.yellow.bold(`  🧪 DRY RUN MODE — no buttons will be clicked\n`));
  }
  if (flags.filterOnly) {
    console.log(chalk.blue.bold(`  📊 FILTER-ONLY MODE — Phase 1 only\n`));
  }
  if (flags.applyOnly) {
    console.log(chalk.blue.bold(`  🚀 APPLY-ONLY MODE — using existing jobs_approved.json\n`));
  }
  if (flags.openExternal) {
    console.log(chalk.magenta.bold(`  🌐 OPEN-EXTERNAL MODE — External jobs will open in tabs\n`));
  }

  // Load settings and resume text
  const settings = loadSettings();
  const resumeText = await loadResumeText(settings);
  initSafetyConfig(settings);

  let approvedJobs: ScoredJob[];

  // --- Phase 1: Offline Filtering ---
  if (flags.applyOnly) {
    // Skip Phase 1, load existing approved jobs
    approvedJobs = readApprovedJobs();
    console.log(
      chalk.green(`\n✔ Loaded ${approvedJobs.length} approved jobs from jobs_approved.json`)
    );
  } else {
    approvedJobs = await runPhase1(resumeText);
  }

  if (approvedJobs.length === 0) {
    console.log(chalk.yellow(`Exiting gracefully.`));
    return;
  }

  // --- Phase 1.5: External Job Handling ---
  const externalJobs = approvedJobs.filter(j => j.applyType === "EXTERNAL");
  const easyApplyJobs = approvedJobs.filter(j => j.applyType === "EASY_APPLY");

  if (!flags.applyOnly) {
    await exportExternalShortlist(externalJobs, resumeText, settings);
  }

  if (flags.openExternal) {
    await openExternalJobs(externalJobs, settings);
  }

  if (flags.filterOnly) {
    console.log(
      chalk.green.bold(`\n✔ Phase 1 complete.`)
    );
    console.log(chalk.gray(`  Easy Apply Jobs: ${easyApplyJobs.length}`));
    console.log(chalk.gray(`  External Jobs: ${externalJobs.length}`));
    return;
  }

  // --- Phase 2: Interactive CLI ---
  const selectedEasyApply = flags.autoConfirm ? easyApplyJobs : await confirmShortlist(easyApplyJobs);

  // --- Phase 3: Browser Automation ---
  if (selectedEasyApply.length === 0) {
    console.log(
      chalk.yellow.bold(`\n⚠ No Easy Apply jobs to process. Exiting.\n`)
    );
    return;
  }

  const results = await runPhase2And3(
    selectedEasyApply,
    resumeText,
    flags.dryRun
  );

  // --- Final Summary ---
  printFinalSummary(results);
}

// ============================================================
// Execute
// ============================================================

main().catch((err) => {
  console.error(
    chalk.red.bold(`\n✖ [FATAL ERROR]`),
    err instanceof Error ? err.message : String(err)
  );
  if (err instanceof Error && err.stack) {
    console.error(chalk.gray(err.stack));
  }
  process.exit(1);
});

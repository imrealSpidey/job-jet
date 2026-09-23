/**
 * cli.ts — Interactive Terminal Prompts
 *
 * Provides interactive menus for confirming job shortlists before automation begins,
 * using @inquirer/prompts.
 */

import chalk from "chalk";
import { checkbox, confirm, Separator } from "@inquirer/prompts";
import type { ScoredJob } from "./types.js";

// ============================================================
// Interactive Shortlist Confirmation
// ============================================================

/**
 * Displays an interactive checkbox prompt listing all Easy Apply jobs.
 * Users can use Space to deselect jobs they don't want to apply to.
 *
 * @param jobs The array of ScoredJobs (Easy Apply track)
 * @returns Array of jobs the user selected to keep
 */
export async function confirmShortlist(jobs: ScoredJob[]): Promise<ScoredJob[]> {
  if (jobs.length === 0) return [];

  console.log(chalk.cyan.bold(`\n📋 [SHORTLIST REVIEW]`));
  
  const choices = jobs.map((job) => {
    const title = job.title.substring(0, 40).padEnd(42);
    const company = job.company.substring(0, 25).padEnd(27);
    const score = `${job.matchScore}%`.padEnd(6);
    
    return {
      name: `[${score}] ${company} | ${title}`,
      value: job.url, // Use URL as unique identifier
      checked: true,  // Pre-selected by default
    };
  });

  const selectedUrls = await checkbox<string>({
    message: "Select jobs to automate (Space to toggle, Enter to confirm):",
    pageSize: 15,
    loop: false,
    choices,
  });

  const selectedJobs = jobs.filter((job) => selectedUrls.includes(job.url));
  
  if (selectedJobs.length < jobs.length) {
    console.log(
      chalk.yellow(`  ↳ Excluded ${jobs.length - selectedJobs.length} jobs from the queue.`)
    );
  }

  return selectedJobs;
}

// ============================================================
// Generic Confirm
// ============================================================

/**
 * Prompts the user with a simple Yes/No confirmation.
 */
export async function confirmProceed(message: string): Promise<boolean> {
  const result = await confirm({
    message,
    default: true,
  });
  return result;
}

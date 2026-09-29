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

import { input, select } from '@inquirer/prompts';
import { loadCandidateProfile, saveCandidateProfile } from './config.js';

// ============================================================
// Application Profile Baseline Check
// ============================================================

export async function ensureApplicationProfile(): Promise<void> {
  const profile = loadCandidateProfile();
  let updated = false;

  const prof = profile.professional || {};
  if (!prof.current_salary) prof.current_salary = { amount: null, currency: 'USD', period: 'yearly' };
  if (!prof.expected_salary) prof.expected_salary = { amount: null, currency: 'USD', period: 'yearly' };
  if (!prof.notice_period) prof.notice_period = { value: null, unit: 'days' };

  if (prof.current_salary.amount === null || prof.expected_salary.amount === null || (prof.notice_period.value === null && prof.notice_period.unit !== 'immediate')) {
    console.log(chalk.magenta.bold('\n📋 [APPLICATION PROFILE INCOMPLETE]'));
    console.log(chalk.gray('Job applications frequently require baseline data that cannot be extracted from a resume.'));
    console.log(chalk.gray('Please provide this information once to safely automate these fields.\n'));
  }

  // Current Salary
  if (prof.current_salary.amount === null) {
    const amountStr = await input({ message: 'Current Salary Amount (e.g. 80000, or 0 if N/A):' });
    prof.current_salary.amount = parseInt(amountStr.replace(/[^0-9]/g, ''), 10) || 0;
    prof.current_salary.currency = await input({ message: 'Currency Code (e.g. USD, INR):', default: 'USD' });
    prof.current_salary.period = (await select({
      message: 'Salary Period:',
      choices: [{ value: 'yearly' }, { value: 'monthly' }, { value: 'hourly' }],
      default: 'yearly'
    })) as any;
    updated = true;
  }

  // Expected Salary
  if (prof.expected_salary.amount === null) {
    const amountStr = await input({ message: 'Expected Salary Amount (e.g. 100000):' });
    prof.expected_salary.amount = parseInt(amountStr.replace(/[^0-9]/g, ''), 10) || 0;
    prof.expected_salary.currency = await input({ message: 'Currency Code (e.g. USD, INR):', default: prof.current_salary.currency });
    prof.expected_salary.period = (await select({
      message: 'Salary Period:',
      choices: [{ value: 'yearly' }, { value: 'monthly' }, { value: 'hourly' }],
      default: prof.current_salary.period
    })) as any;
    updated = true;
  }

  // Notice Period
  if (prof.notice_period.value === null && prof.notice_period.unit !== 'immediate') {
    prof.notice_period.unit = (await select({
      message: 'Notice Period Unit:',
      choices: [{ value: 'immediate' }, { value: 'days' }, { value: 'weeks' }, { value: 'months' }],
      default: 'days'
    })) as any;
    
    if (prof.notice_period.unit !== 'immediate') {
      const valStr = await input({ message: 'Notice Period Value (in ' + prof.notice_period.unit + '):' });
      prof.notice_period.value = parseInt(valStr.replace(/[^0-9]/g, ''), 10) || 0;
    }
    updated = true;
  }

  if (updated) {
    profile.professional = prof as any;
    saveCandidateProfile(profile);
    console.log(chalk.green('✔ Verified application profile saved.'));
  }
}
/**
 * automationRunner.ts — In-process Browser Automation Controller
 *
 * Manages the live Playwright browser session for Easy Apply jobs,
 * tracks step-by-step progress, answers, and human-in-the-loop review status,
 * and exposes real-time state for the Web UI.
 */

import chalk from "chalk";
import type { Page } from "playwright";
import type { ScoredJob, FormAnswer, ApplicationResult, ApplicationStatus, Settings, SolverContext } from "./types.js";
import { loadSettings, loadResumeText, paths, appendHistory } from "./config.js";
import { readApprovedJobs } from "./evaluator.js";
import { launchBrowser, closeBrowser, disconnectBrowser, type BrowserSession } from "./browser/session.js";
import {
  openEasyApply,
  stepThroughModal,
  pauseForReview,
  safeCloseModal,
  captureErrorScreenshot,
} from "./browser/easyApply.js";
import { initSafetyConfig, jobCooldown, skipCooldown, jitterDelay } from "./browser/humanize.js";

export interface AutomationProgress {
  isRunning: boolean;
  status: "idle" | "starting" | "waiting_login" | "navigating" | "filling" | "review" | "cooldown" | "completed" | "error" | "stopped";
  total: number;
  currentIndex: number;
  currentJob: {
    title: string;
    company: string;
    url: string;
    location?: string;
    matchScore?: number;
  } | null;
  currentStepMessage: string;
  appliedCount: number;
  skippedCount: number;
  haltedCount: number;
  errorCount: number;
  logs: Array<{ timestamp: string; message: string; type: "info" | "success" | "warn" | "error" }>;
  currentAnswers: FormAnswer[];
  error?: string;
}

let activeSession: BrowserSession | null = null;
let shouldStop = false;

const state: AutomationProgress = {
  isRunning: false,
  status: "idle",
  total: 0,
  currentIndex: 0,
  currentJob: null,
  currentStepMessage: "Ready to launch",
  appliedCount: 0,
  skippedCount: 0,
  haltedCount: 0,
  errorCount: 0,
  logs: [],
  currentAnswers: [],
};

function addLog(message: string, type: "info" | "success" | "warn" | "error" = "info") {
  const timestamp = new Date().toLocaleTimeString();
  state.logs.push({ timestamp, message, type });
  if (state.logs.length > 100) {
    state.logs.shift();
  }
}

export function getAutomationProgress(): AutomationProgress {
  return { ...state };
}

export async function stopAutomation(): Promise<void> {
  if (!state.isRunning) return;
  shouldStop = true;
  addLog("Stopping browser automation...", "warn");
  state.currentStepMessage = "Stopping automation and closing browser...";
  if (activeSession) {
    try {
      await closeBrowser(activeSession);
    } catch {
      // ignore
    }
    activeSession = null;
  }
  state.isRunning = false;
  state.status = "stopped";
  addLog("Browser automation stopped by user", "info");
}

export async function startAutomation(dryRun = false): Promise<void> {
  if (state.isRunning) {
    throw new Error("Automation is already in progress");
  }

  shouldStop = false;
  state.isRunning = true;
  state.status = "starting";
  state.total = 0;
  state.currentIndex = 0;
  state.currentJob = null;
  state.appliedCount = 0;
  state.skippedCount = 0;
  state.haltedCount = 0;
  state.errorCount = 0;
  state.currentAnswers = [];
  state.logs = [];
  state.error = undefined;
  state.currentStepMessage = "Initializing settings and loading jobs...";

  addLog("Browser automation initialized", "info");

  // Run in background
  (async () => {
    const readyTabs: Page[] = [];
    try {
      const settings = loadSettings();
      initSafetyConfig(settings);

      addLog("Loading resume text and approved jobs...", "info");
      const resumeText = await loadResumeText(settings);
      const approvedJobs = readApprovedJobs();
      const easyApplyJobs = approvedJobs.filter((j) => j.applyType === "EASY_APPLY");

      if (easyApplyJobs.length === 0) {
        state.status = "completed";
        state.isRunning = false;
        state.currentStepMessage = "No Easy Apply jobs found in approved list.";
        addLog("No Easy Apply jobs to apply to.", "warn");
        return;
      }

      state.total = easyApplyJobs.length;
      state.currentStepMessage = `Queued ${easyApplyJobs.length} Easy Apply jobs. Launching browser...`;
      addLog(`Queued ${easyApplyJobs.length} Easy Apply jobs`, "info");

      // Launch Browser
      activeSession = await launchBrowser(settings, (launchStatus, msg) => {
        if (launchStatus === "waiting_login") {
          state.status = "waiting_login";
          state.currentStepMessage = msg;
          addLog(msg, "warn");
        } else if (launchStatus === "session_active") {
          state.currentStepMessage = msg;
          addLog(msg, "success");
        } else {
          state.currentStepMessage = msg;
          addLog(msg, "info");
        }
      });

      // Attach lifecycle listener to detect if the user closes the entire browser window
      activeSession.context.on("close", () => {
        if (state.isRunning) {
          shouldStop = true;
          state.status = "stopped";
          state.currentStepMessage = "Automation stopped: Browser window closed.";
          addLog("Browser window closed. Halting automation.", "warn");
        }
      });

      addLog("Browser launched and authenticated. Starting multi-tab applications...", "success");

      // Track all tabs kept open for human review
      let initialTab: Page | null = activeSession.page;

      // Loop through jobs
      for (let i = 0; i < easyApplyJobs.length; i++) {
        if (shouldStop) break;

        // Check if browser was closed between iterations
        if (!activeSession || (activeSession.context.browser() && !activeSession.context.browser()?.isConnected())) {
          shouldStop = true;
          state.status = "stopped";
          state.currentStepMessage = "Automation stopped: Browser window closed.";
          addLog("Browser window was closed by user. Stopping automation.", "warn");
          break;
        }

        const job = easyApplyJobs[i];
        state.currentIndex = i + 1;
        const companyStr = job.company || (job as any).companyName || "Unknown Company";
        const titleStr = job.title || (job as any).jobTitle || "Unknown Title";
        const urlStr = job.url || (job as any).jobUrl || (job as any).applyUrl || "";

        state.currentJob = {
          title: titleStr,
          company: companyStr,
          url: urlStr,
          location: job.location,
          matchScore: job.matchScore,
        };
        state.currentAnswers = [];
        state.status = "navigating";
        state.currentStepMessage = `[Job ${i + 1}/${easyApplyJobs.length}] Opening new tab for ${titleStr} @ ${companyStr}...`;
        addLog(`[${i + 1}/${easyApplyJobs.length}] Opening new tab for ${titleStr} @ ${companyStr}...`, "info");

        // Open a new browser tab for this job
        const jobPage = await activeSession.context.newPage();

        // Close initial login tab once authenticated so it doesn't clutter the tabs
        if (initialTab && !initialTab.isClosed() && initialTab !== jobPage) {
          try {
            await initialTab.close();
          } catch {}
          initialTab = null;
        }

        let status: ApplicationStatus = "error";
        let message = "";
        let answers: FormAnswer[] = [];

        try {
          const openResult = await openEasyApply(jobPage, urlStr, (job as any).id);

          if (openResult.reason === "browser_closed") {
            shouldStop = true;
            state.status = "stopped";
            state.currentStepMessage = "Automation stopped: Browser window closed.";
            addLog("Browser window was closed by user. Stopping automation.", "warn");
            await jobPage.close().catch(() => {});
            break;
          }

          if (!openResult.opened) {
            status = "skipped";
            message = openResult.message;
            state.skippedCount++;
            state.currentStepMessage = `Skipped: ${titleStr} @ ${companyStr} (${openResult.message})`;
            addLog(`[Skipped] ${titleStr} @ ${companyStr}: ${openResult.message}`, "warn");

            // Close tab immediately so skipped / closed / external jobs don't clutter the browser
            await jobPage.close().catch(() => {});

            // Record history
            if (!dryRun) {
              appendHistory({
                url: urlStr,
                title: titleStr,
                company: companyStr,
                status: "skipped",
                appliedAt: new Date().toISOString(),
                matchScore: job.matchScore,
              });
            }

            // Settle pause so the user can see what happened, plus humanized skip delay
            state.status = "cooldown";
            state.currentStepMessage = "Safety cooldown (simulating human skipping job)...";
            addLog("Simulating human delay before moving to next job...", "info");
            await skipCooldown();
            continue;
          }

          if (shouldStop) {
            await jobPage.close().catch(() => {});
            break;
          }

          state.status = "filling";
          state.currentStepMessage = `AI pre-filling application form for ${titleStr}...`;
          addLog(`Pre-filling form fields with AI for ${companyStr}...`, "info");

          const solverContext: SolverContext = {
            settings,
            jobDescription: job.description,
            resumeText,
          };

          const stepResult = await stepThroughModal(
            jobPage,
            job,
            solverContext,
            settings,
            dryRun
          );

          answers = stepResult.answers;
          state.currentAnswers = answers;

          if (stepResult.halted) {
            status = "halted";
            message = "Halted: Unresolvable question required manual input";
            state.haltedCount++;
            state.status = "review";
            state.currentStepMessage = `🛑 Application halted on ${titleStr}. Tab left open for your review!`;
            addLog(`[Tab Left Open] Manual input needed on ${titleStr} @ ${companyStr}`, "warn");

            // Keep tab open for user review
            readyTabs.push(jobPage);
          } else if (stepResult.reachedReview) {
            status = "applied";
            message = "Pre-filled and ready for submission";
            state.appliedCount++;
            state.status = "review";
            state.currentStepMessage = `🎉 Pre-filled! Tab left open at review screen: ${titleStr} @ ${companyStr}`;
            addLog(`✔ [Tab ${state.appliedCount} Ready] Pre-filled application for ${titleStr} @ ${companyStr}! Waiting for 1-click submit in browser.`, "success");

            // Keep tab open for user at the final review/submit screen
            readyTabs.push(jobPage);
          } else if (stepResult.error) {
            status = "error";
            message = stepResult.error;
            state.errorCount++;
            addLog(`Error on ${titleStr}: ${message}`, "error");

            await captureErrorScreenshot(jobPage, paths.screenshotsDir, titleStr).catch(() => {});
            await safeCloseModal(jobPage).catch(() => {});
            await jobPage.close().catch(() => {});
          } else if (dryRun) {
            status = "skipped";
            message = "Dry run completed";
            state.skippedCount++;
            addLog(`[DRY RUN] Completed scan for ${titleStr}`, "info");
            await jobPage.close().catch(() => {});
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          if (errMsg.includes("closed")) {
            shouldStop = true;
            state.status = "stopped";
            state.currentStepMessage = "Automation stopped: Browser window closed.";
            addLog("Browser window was closed by user. Stopping automation.", "warn");
            break;
          }

          status = "error";
          message = errMsg;
          state.errorCount++;
          addLog(`Unexpected error on ${titleStr}: ${message}`, "error");

          if (!jobPage.isClosed()) {
            await captureErrorScreenshot(jobPage, paths.screenshotsDir, titleStr).catch(() => {});
            await safeCloseModal(jobPage).catch(() => {});
            await jobPage.close().catch(() => {});
          }
        }

        // Record history
        if (!dryRun && status !== "skipped") {
          appendHistory({
            url: urlStr,
            title: titleStr,
            company: companyStr,
            status,
            appliedAt: new Date().toISOString(),
            matchScore: job.matchScore,
          });
        }

        // Organic cooldown between applications
        if (i < easyApplyJobs.length - 1 && !shouldStop) {
          state.status = "cooldown";
          state.currentStepMessage = "Safety cooldown before opening next application tab...";
          addLog("Safety delay between applications...", "info");
          await jitterDelay(8000, 3000);
        }
      }

      if (shouldStop || state.status === "stopped") {
        state.status = "stopped";
        state.currentStepMessage = `Automation stopped by user. Tabs ready: ${readyTabs.length}, Skipped: ${state.skippedCount}.`;
        addLog("Automation run halted.", "warn");
      } else {
        state.status = "completed";
        if (readyTabs.length === 0 && state.skippedCount > 0) {
          state.currentStepMessage = `Finished: 0 applications pre-filled (${state.skippedCount} skipped: closed or external jobs). Tip: Scrape fresh Easy Apply jobs in Settings.`;
          addLog(`Finished run: 0 applications pre-filled (${state.skippedCount} skipped)`, "warn");
        } else {
          state.currentStepMessage = `🎉 All done! ${readyTabs.length} applications pre-filled and waiting in open browser tabs. Review each tab and click Submit!`;
          addLog(`🎉 Process complete! ${readyTabs.length} tabs open with pre-filled forms ready for your 1-click submission.`, "success");
        }
      }
    } catch (err: any) {
      state.status = "error";
      state.error = err?.message || String(err);
      state.currentStepMessage = `Automation error: ${state.error}`;
      addLog(`Fatal automation error: ${state.error}`, "error");
      console.error(chalk.red("Fatal error in startAutomation:"), err);
    } finally {
      if (activeSession) {
        try {
          if (readyTabs.length > 0) {
            // DO NOT close browser if tabs are waiting for user review!
            await disconnectBrowser(activeSession);
          } else {
            await closeBrowser(activeSession);
          }
        } catch {
          // ignore
        }
        activeSession = null;
      }
      state.isRunning = false;
    }
  })();
}

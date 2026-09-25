/**
 * session.ts — Persistent Playwright browser session manager
 *
 * Launches a visible Chromium instance using a persistent user data directory
 * so that existing authenticated LinkedIn sessions are reused across runs.
 *
 * On first run, the user logs into LinkedIn manually in the launched browser.
 * The cookies and session state persist in `browser_profile/` for subsequent runs.
 */

import fs from "node:fs";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import { chromium, type BrowserContext, type Page } from "playwright";
import { chromium as chromiumExtra } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Settings } from "../types.js";

// Apply stealth plugin
chromiumExtra.use(stealthPlugin());

// ============================================================
// Browser Session Management
// ============================================================

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

/**
 * Searches for an installed system browser on Windows (Chrome or Edge).
 */
function findSystemBrowser(): string | null {
  if (process.platform !== "win32") return null;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Launches a persistent browser context visible on the user's desktop.
 *
 * On Windows, spawns the real system Chrome/Edge via Windows ShellExecute
 * so the window opens directly onto the interactive desktop (winsta0\default)
 * without being trapped in background services, then controls it over CDP.
 */
export async function launchBrowser(
  settings: Settings,
  onStatus?: (status: "launching" | "waiting_login" | "session_active", message: string) => void
): Promise<BrowserSession> {
  const userDataDir = path.resolve(settings.browser.user_data_dir);

  onStatus?.("launching", "Opening browser window on your desktop...");

  let context: BrowserContext;
  const systemBrowser = findSystemBrowser();

  if (systemBrowser && !settings.browser.headless) {
    console.log(
      chalk.blue.bold(`\n🌐 [BROWSER]`),
      `Launching visible system browser via Windows Shell: ${systemBrowser}`
    );
    console.log(chalk.gray(`  Profile: ${userDataDir}`));

    const cdpUrl = "http://127.0.0.1:9222";
    let browser = null;

    try {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1500 });
      console.log(chalk.green(`  ✔ Connected to existing browser session on port 9222`));
    } catch {
      // Determine launch strategy based on whether we're in an interactive terminal
      const isInteractive = process.stdout.isTTY === true;
      
      if (isInteractive) {
        // Interactive terminal (e.g. run.bat) — direct spawn works fine
        console.log(chalk.gray(`  Using direct spawn (interactive terminal detected)...`));
        const { spawn } = await import('node:child_process');
        const child = spawn(systemBrowser, [
          `--remote-debugging-port=9222`,
          `--user-data-dir=${userDataDir}`,
          '--start-maximized',
          'https://www.linkedin.com/login'
        ], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        // Background service context — use Scheduled Tasks to break out of Session 0
        console.log(chalk.gray(`  Using Scheduled Task (background context detected)...`));
        const psScript = `
$taskName = "JobHuntLaunchChrome"
$chromePath = "${systemBrowser}"
$args = "--remote-debugging-port=9222 --user-data-dir=\`"${userDataDir}\`" --start-maximized https://www.linkedin.com/login"
$action = New-ScheduledTaskAction -Execute $chromePath -Argument $args
$principal = New-ScheduledTaskPrincipal -UserId (Get-CimInstance Win32_ComputerSystem).UserName -LogonType Interactive
$task = New-ScheduledTask -Action $action -Principal $principal
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
`;
        try {
          const scriptPath = path.join(os.tmpdir(), "launch_chrome.ps1");
          fs.writeFileSync(scriptPath, psScript);
          execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
        } catch (e: any) {
          console.warn(chalk.yellow(`⚠ Error triggering Scheduled Task: ${e.message}`));
        }
      }

      // Poll for CDP readiness
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 600));
        try {
          browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1500 });
          console.log(chalk.green(`  ✔ Browser window opened and connected on attempt ${i + 1}`));
          break;
        } catch {}
      }
    }

    if (browser) {
      context = browser.contexts()[0];
    } else {
      console.warn(chalk.yellow(`  ⚠ CDP connection timed out, falling back to bundled Chromium`));
      context = await chromiumExtra.launchPersistentContext(userDataDir, {
        headless: settings.browser.headless,
        slowMo: settings.browser.slow_mo,
        viewport: null,
        args: [
          "--start-maximized",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--no-first-run",
          "--no-default-browser-check",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
  } else {
    context = await chromiumExtra.launchPersistentContext(userDataDir, {
      headless: settings.browser.headless,
      slowMo: settings.browser.slow_mo,
      viewport: null,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  }

  // Use the default page or create a new one
  const page =
    context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  await page.bringToFront().catch(() => {});

  console.log(chalk.green.bold(`  ✔ Browser launched successfully`));

  // Check if LinkedIn session is active
  const isLoggedIn = await checkLinkedInSession(page);
  if (!isLoggedIn) {
    onStatus?.(
      "waiting_login",
      "LinkedIn login required. Please log into LinkedIn in the opened browser window. Automation will auto-resume once detected."
    );

    console.log(
      chalk.yellow.bold(`\n⚠ [SESSION]`),
      `LinkedIn session not detected.`
    );
    console.log(
      chalk.yellow(`  Please log into LinkedIn manually in the popped-up browser window.`)
    );
    console.log(
      chalk.gray(`  (Waiting and polling for authentication every 5 seconds...)\n`)
    );

    if (page.url() !== "https://www.linkedin.com/login" && !page.url().includes("linkedin.com/checkpoint")) {
      await page.goto("https://www.linkedin.com/login", {
        waitUntil: "domcontentloaded",
      }).catch(() => {});
    }

    // Polling loop for login (non-disruptive: does NOT navigate or reload while user types)
    let verified = false;
    let attempts = 0;
    while (!verified && attempts < 100) { // Up to 5 minutes
      await new Promise((resolve) => setTimeout(resolve, 3000));
      verified = await checkLinkedInSession(page, false);
      attempts++;
    }

    if (!verified) {
      console.error(
        chalk.red.bold(`✖ [SESSION ERROR]`),
        `LinkedIn login could not be verified after 5 minutes. Timing out.`
      );
      await context.close();
      throw new Error("LinkedIn login timeout (5 minutes expired).");
    }

    onStatus?.("session_active", "LinkedIn session verified! Resuming automation...");
    console.log(chalk.green.bold(`  ✔ LinkedIn session verified (Auto-resuming)`));
  } else {
    onStatus?.("session_active", "LinkedIn session active (reusing cookies)");
    console.log(chalk.green(`  ✔ LinkedIn session active (reusing cookies)`));
  }

  return { context, page };
}

// ============================================================
// Session Verification
// ============================================================

/**
 * Checks if the user is logged into LinkedIn.
 * When navigate=false, checks cookies and URL without reloading the page.
 */
async function checkLinkedInSession(page: Page, navigate = true): Promise<boolean> {
  try {
    // Check cookies first (non-disruptive)
    const cookies = await page.context().cookies();
    const hasLiAt = cookies.some((c) => c.name === "li_at" && c.value && c.value.length > 5);

    const currentUrl = page.url();

    if (hasLiAt) {
      if (!currentUrl.includes("/login") && !currentUrl.includes("/checkpoint") && !currentUrl.includes("/authwall")) {
        return true;
      }
    }

    if (navigate) {
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }

    const settledUrl = page.url();
    if (
      settledUrl.includes("/login") ||
      settledUrl.includes("/authwall") ||
      settledUrl.includes("/checkpoint")
    ) {
      return false;
    }

    if (settledUrl.includes("/feed") || settledUrl.includes("/jobs") || settledUrl.includes("/mynetwork")) {
      return true;
    }

    const navProfile = page.locator(
      'img[alt*="Photo" i], a[href*="/in/"], button[aria-label*="Account" i], .global-nav'
    );
    return await navProfile.first().isVisible({ timeout: 4000 }).catch(() => false);
  } catch {
    return false;
  }
}

// ============================================================
// Terminal Input Helper
// ============================================================

// ============================================================

// Cleanup
// ============================================================

/**
 * Gracefully closes the browser context.
 */
export async function closeBrowser(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
    console.log(chalk.gray(`\n🌐 [BROWSER] Session closed.`));
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Disconnects Playwright without terminating the browser process or closing tabs.
 * Keeps all prefilled application tabs alive on screen for user review and submission.
 */
export async function disconnectBrowser(session: BrowserSession): Promise<void> {
  try {
    // If connected via CDP, call disconnect() on the Browser object to release the Node process
    // while keeping the Chrome window and all tabs alive on the user's desktop.
    const browser = session.context.browser();
    if (browser && browser.isConnected()) {
      (browser as any).disconnect?.();
    }
    console.log(chalk.gray(`\n🌐 [BROWSER] Leaving pre-filled tabs open for human review and submission.`));
  } catch {
    // Ignore errors during cleanup
  }
}

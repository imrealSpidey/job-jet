/**
 * humanize.ts — Human-like interaction utilities
 *
 * Provides randomized delays, keystroke pacing, and click jitter
 * to make browser interactions appear organic. These mitigations
 * reduce the risk of LinkedIn detecting automation patterns.
 *
 * All values are now configurable via settings.yaml.safety.
 */

import type { Page } from "playwright";
import type { Settings } from "../types.js";

// ============================================================
// Safety Configuration State
// ============================================================

interface SafetyConfig {
  jobCooldownMin: number;
  jobCooldownMax: number;
  typingMin: number;
  typingMax: number;
  clickBase: number;
  clickVar: number;
}

let safety: SafetyConfig = {
  jobCooldownMin: 45000,
  jobCooldownMax: 120000,
  typingMin: 40,
  typingMax: 90,
  clickBase: 2500,
  clickVar: 1200,
};

export function initSafetyConfig(settings: Settings): void {
  const s = settings.safety;
  safety = {
    jobCooldownMin: s.job_cooldown_min_s * 1000,
    jobCooldownMax: s.job_cooldown_max_s * 1000,
    typingMin: s.typing_speed_min_ms,
    typingMax: s.typing_speed_max_ms,
    clickBase: s.click_jitter_base_ms,
    clickVar: s.click_jitter_variance_ms,
  };
}

/**
 * Returns a random integer between min and max (inclusive).
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
// Core Delay Utilities
// ============================================================

/**
 * Sleeps for a jittered duration: base ± variance milliseconds.
 */
export async function jitterDelay(
  baseMs: number = safety.clickBase,
  varianceMs: number = safety.clickVar
): Promise<void> {
  const delay = Math.max(
    200,
    baseMs + randomInt(-varianceMs, varianceMs)
  );
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Cooldown pause between jobs (45s–120s by default)
 */
export async function jobCooldown(): Promise<void> {
  const delay = randomInt(safety.jobCooldownMin, safety.jobCooldownMax);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Shorter cooldown (5s–15s) when a job is quickly skipped (e.g., closed or external).
 * Prevents rapid-fire bot behavior while navigating through skipped jobs.
 */
export async function skipCooldown(): Promise<void> {
  const delay = randomInt(5000, 15000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Short pause between rapid actions (e.g., between filling two fields).
 * Range: 400–900ms
 */
export async function shortPause(): Promise<void> {
  await jitterDelay(650, 250);
}

/**
 * Longer pause to simulate reading or thinking.
 * Range: 3000–6000ms
 */
export async function readingPause(): Promise<void> {
  await jitterDelay(4500, 1500);
}

// ============================================================
// Human-like Typing
// ============================================================

export function randomKeystrokeDelay(): number {
  return randomInt(safety.typingMin, safety.typingMax);
}

/**
 * Types text into an element character by character with random delays and occasional simulated typos.
 */
export async function humanType(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  // Click the field first to ensure focus
  await page.click(selector);
  await shortPause();

  // Clear any existing value
  await page.fill(selector, "");

  await humanTypeKeyboard(page, text);
}

/**
 * Types text into an already-focused element with occasional typo corrections.
 */
export async function humanTypeKeyboard(
  page: Page,
  text: string
): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // 2% chance to make a typo (if it's a letter)
    if (Math.random() < 0.02 && /[a-zA-Z]/.test(char)) {
      const typo = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(typo, { delay: randomKeystrokeDelay() });
      await jitterDelay(150, 50); // Realize mistake
      await page.keyboard.press("Backspace", { delay: randomKeystrokeDelay() });
      await jitterDelay(100, 50);
    }
    
    await page.keyboard.type(char, {
      delay: randomKeystrokeDelay(),
    });
  }
}

// ============================================================
// Human-like Clicking
// ============================================================

/**
 * Clicks an element with a small random positional offset and
 * a pre-click hover to simulate human mouse movement.
 */
export async function humanClick(
  page: Page,
  selector: string,
  options?: { timeout?: number }
): Promise<void> {
  const element = page.locator(selector).first();

  // Wait for the element to be visible
  await element.waitFor({
    state: "visible",
    timeout: options?.timeout ?? 10_000,
  });

  // Hover first
  await element.hover();
  await jitterDelay(300, 150);

  // Click with a small positional offset
  const box = await element.boundingBox();
  if (box) {
    const offsetX = randomInt(-3, 3);
    const offsetY = randomInt(-2, 2);
    await page.mouse.click(
      box.x + box.width / 2 + offsetX,
      box.y + box.height / 2 + offsetY
    );
  } else {
    // Fallback
    await element.click();
  }
}

// ============================================================
// Scroll & Reading Simulation
// ============================================================

/**
 * Simulates a user scrolling down the page to "read" content.
 */
export async function randomScrollPause(page: Page): Promise<void> {
  const scrollAmount = randomInt(200, 500);
  await page.mouse.wheel(0, scrollAmount);
  await jitterDelay(1500, 800);
}

/**
 * Scrolls an element into view with a smooth behavior simulation.
 */
export async function scrollIntoView(
  page: Page,
  selector: string
): Promise<void> {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await shortPause();
}

/**
 * easyApply.ts — LinkedIn Easy Apply DOM interaction engine
 *
 * Handles the full lifecycle of a LinkedIn Easy Apply submission:
 * 1. Navigate to the job posting
 * 2. Click the "Easy Apply" button
 * 3. Step through multi-page modal forms
 * 4. Upload resume (with pre-existing resume check)
 * 5. Handle text inputs, selects, radio buttons, typeahead/combobox fields
 * 6. Pause on the review screen for human approval
 * 7. Handle "Discard application?" confirmation on errors or skips
 *
 * All selectors use ARIA labels and semantic roles to avoid dependency
 * on LinkedIn's dynamic CSS classes.
 */

import path from "node:path";
import chalk from "chalk";
import type { Page } from "playwright";
import type { ScoredJob, FormAnswer, Settings, SolverContext } from "../types.js";
import { solveQuestion } from "../formSolver.js";
import { getResumeFilePath } from "../config.js";
import {
  jitterDelay,
  shortPause,
  humanType,
  humanClick,
  randomScrollPause,
  randomKeystrokeDelay,
} from "./humanize.js";

// ============================================================
// Constants
// ============================================================

const MODAL_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;

// ============================================================
// 1. Navigate to Job & Open Easy Apply
// ============================================================

export interface OpenEasyApplyResult {
  opened: boolean;
  reason?: "already_applied" | "closed" | "external_apply" | "not_found" | "modal_timeout" | "browser_closed" | "error";
  message: string;
}

/**
 * Converts any LinkedIn job URL to the clean canonical format:
 * https://www.linkedin.com/jobs/view/<jobId>/
 * This avoids regional subdomain redirects (uk.linkedin.com -> www.linkedin.com)
 * and tracking query parameters that trigger ERR_ABORTED.
 */
export function getCanonicalLinkedInUrl(url: string, id?: string): string {
  if (id && /^\d+$/.test(id)) {
    return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  const viewMatch = url.match(/\/view\/(?:[a-zA-Z0-9_-]+-)?(\d{8,14})/);
  if (viewMatch && viewMatch[1]) {
    return `https://www.linkedin.com/jobs/view/${viewMatch[1]}/`;
  }
  const currentJobIdMatch = url.match(/[?&]currentJobId=(\d{8,14})/);
  if (currentJobIdMatch && currentJobIdMatch[1]) {
    return `https://www.linkedin.com/jobs/view/${currentJobIdMatch[1]}/`;
  }
  return url;
}

/**
 * Navigates to a LinkedIn job posting URL and clicks the Easy Apply button.
 * Validates whether the job is closed, already applied, or external-apply only.
 * @returns OpenEasyApplyResult with status details
 */
export async function openEasyApply(
  page: Page,
  url: string,
  id?: string
): Promise<OpenEasyApplyResult> {
  if (page.isClosed()) {
    return { opened: false, reason: "browser_closed", message: "Browser window closed" };
  }

  const targetUrl = getCanonicalLinkedInUrl(url, id);
  console.log(chalk.blue(`\n  📄 Navigating to job posting: ${targetUrl}`));

  try {
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT,
      });
    } catch (gotoErr: any) {
      const errMsg = gotoErr?.message || String(gotoErr);
      if (page.isClosed() || errMsg.includes("Target page, context or browser has been closed") || errMsg.includes("browser has been closed")) {
        return { opened: false, reason: "browser_closed", message: "Browser window closed" };
      }
      if (errMsg.includes("ERR_ABORTED")) {
        // LinkedIn redirected or aborted subrequest. Wait and check current page URL
        await new Promise((r) => setTimeout(r, 1500));
        if (page.isClosed()) {
          return { opened: false, reason: "browser_closed", message: "Browser window closed" };
        }
        console.log(chalk.gray(`    ↳ Navigation was redirected/settled (ERR_ABORTED recovered)`));
      } else {
        throw gotoErr;
      }
    }

    // Quick pause to let dynamic content settle
    await jitterDelay(1800, 600);
    if (page.isClosed()) {
      return { opened: false, reason: "browser_closed", message: "Browser window closed" };
    }
    await page.evaluate(() => window.scrollTo(0, 200)).catch(() => {});

    // 1. Check for CLOSED / EXPIRED job (e.g. "No longer accepting applications")
    const closedSelectors = [
      'div.jobs-details__closed-banner',
      '.jobs-details-top-card__apply-error',
      'button:disabled:has-text("No longer accepting applications")',
      'p:has-text("No longer accepting applications")',
      'div:has-text("No longer accepting applications")',
      'span:has-text("No longer accepting applications")',
      'div:has-text("This job is closed")',
      'span:has-text("This job is closed")',
      'text=/No longer accepting applications/i',
      'text=/This job is closed/i',
      'text=/The job you.*looking for is no longer open/i',
    ];

    for (const sel of closedSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(chalk.yellow(`    ⚠ Job is no longer accepting applications (closed by poster).`));
        return {
          opened: false,
          reason: "closed",
          message: "Job is no longer accepting applications",
        };
      }
    }

    // 2. Check if job is already applied
    const alreadyAppliedSelectors = [
      'button:has-text("Applied")',
      '.jobs-s-apply button:disabled:has-text("Applied")',
      'button:disabled:has-text("Applied")',
      'text=/Application submitted/i',
    ];
    for (const sel of alreadyAppliedSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(chalk.yellow(`    ⚠ Already applied to this job previously.`));
        return {
          opened: false,
          reason: "already_applied",
          message: "Already applied previously",
        };
      }
    }

    // 3. Look for explicit external apply indicators to save time
    const explicitExternalSelectors = [
      'span:has-text("Apply on company website")',
      'a:has-text("Apply on company website")',
      'button:has-text("Apply on company website")',
    ];
    for (const sel of explicitExternalSelectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
        console.log(chalk.yellow(`    ⚠ Job requires external application on company website.`));
        return { opened: false, reason: "external_apply", message: "External apply only (Apply on company website)" };
      }
    }

    // 4. Find the primary Apply CTA element (supports both new SDUI <a> tags and classic <button> tags)
    const applySelectors = [
      'a[aria-label*="LinkedIn Apply" i]',
      'a[href*="/apply/"]',
      'a[aria-label*="Apply to this job" i]',
      'button[aria-label*="Apply to this job" i]',
      'button[aria-label*="Easy Apply" i]',
      'a[aria-label*="Easy Apply" i]',
      'button.jobs-apply-button',
      'a.jobs-apply-button',
      '.jobs-s-apply a',
      '.jobs-s-apply button',
      'div[class*="top-card"] a[href*="/apply/"]',
      'div[class*="top-card"] button:has-text("Apply")',
      'div[class*="top-card"] a:has-text("Apply")',
      'div[class*="topcard"] button:has-text("Apply")',
      'div[class*="topcard"] a:has-text("Apply")',
      'button:has-text("Easy Apply")',
      'a:has-text("Easy Apply")',
      'button.apply-button',
      'a.apply-button',
      'button[aria-label*="Apply" i]',
      'a[aria-label*="Apply" i]',
      'button:has-text("Apply")',
      'a:has-text("Apply")',
    ];

    let applyBtn = null;
    for (const sel of applySelectors) {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 600 }).catch(() => false)) {
        applyBtn = b;
        break;
      }
    }

    if (!applyBtn) {
      console.log(chalk.yellow(`    ⚠ Apply button not found — job may be closed or external-apply only`));
      return { opened: false, reason: "not_found", message: "Apply button not found" };
    }

    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await jitterDelay(300, 150);

    // 5. Intercept new tabs. If clicking Apply opens a new tab, it's an external job.
    let newPageOpened = false;
    const pageHandler = (newPage: any) => {
      newPageOpened = true;
      newPage.close().catch(() => {});
    };
    page.context().on('page', pageHandler);

    try {
      await applyBtn.click({ force: true });
    } catch (e: any) {
      page.context().off('page', pageHandler);
      if (e.message?.includes("closed")) {
        return { opened: false, reason: "browser_closed", message: "Browser closed during click" };
      }
    }

    // Wait for the modal dialog to appear
    const modal = page.locator('div[role="dialog"], .jobs-easy-apply-modal, div.artdeco-modal').first();
    try {
      if (newPageOpened) {
        page.context().off('page', pageHandler);
        console.log(chalk.yellow(`    ⚠ Clicking Apply opened a new tab. This is an external application.`));
        return { opened: false, reason: "external_apply", message: "External apply only (opened new tab)" };
      }

      await modal.waitFor({ state: "visible", timeout: MODAL_TIMEOUT });
    } catch {
      page.context().off('page', pageHandler);
      
      if (newPageOpened) {
        console.log(chalk.yellow(`    ⚠ Clicking Apply opened a new tab. This is an external application.`));
        return { opened: false, reason: "external_apply", message: "External apply only (opened new tab)" };
      }

      console.warn(chalk.yellow(`    ⚠ Apply clicked, but application modal did not appear.`));
      return { opened: false, reason: "modal_timeout", message: "Application modal did not appear after clicking Apply" };
    }
    
    page.context().off('page', pageHandler);
    
    await jitterDelay(800, 300);
    console.log(chalk.green(`    ✔ Easy Apply modal opened`));
    return {
      opened: true,
      message: "Easy Apply modal opened",
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (page.isClosed() || errMsg.includes("Target page, context or browser has been closed") || errMsg.includes("browser has been closed")) {
      return {
        opened: false,
        reason: "browser_closed",
        message: "Browser window closed",
      };
    }
    console.error(chalk.red(`    ✖ Failed to open Easy Apply: ${errMsg}`));
    return {
      opened: false,
      reason: "error",
      message: errMsg,
    };
  }
}

// ============================================================
// 2. Form Field Detection & Processing
// ============================================================

interface DetectedField {
  type: "text" | "textarea" | "select" | "radio" | "file" | "combobox" | "checkbox";
  label: string;
  selector: string;
  fieldsetIndex?: number;
  checkboxIndex?: number;
  /** For radio/select: available options */
  options?: string[];
  /** Whether field is required */
  required: boolean;
}

/**
 * Scans the current modal step for form fields and returns a list
 * of detected fields with their types, labels, and selectors.
 */
async function detectFormFields(page: Page): Promise<DetectedField[]> {
  const modal = page.locator('div[role="dialog"]').first();
  const fields: DetectedField[] = [];

  // --- Text Inputs ---
  const textInputs = modal.locator(
    'input[type="text"], input[type="tel"], input[type="email"], input[type="url"], input[type="number"], input:not([type])'
  );
  const textCount = await textInputs.count();

  for (let i = 0; i < textCount; i++) {
    const input = textInputs.nth(i);
    const isVisible = await input.isVisible().catch(() => false);
    if (!isVisible) continue;

    // Skip file inputs and hidden fields
    const type = await input.getAttribute("type");
    if (type === "file" || type === "hidden") continue;

    const label = await getFieldLabel(page, input);
    const id = await input.getAttribute("id");
    const role = await input.getAttribute("role");
    const ariaHasPopup = await input.getAttribute("aria-haspopup");

    // Check if this is a typeahead/combobox
    if (role === "combobox" || ariaHasPopup === "listbox") {
      fields.push({
        type: "combobox",
        label,
        selector: id ? `#${id}` : `input[role="combobox"]`,
        required: (await input.getAttribute("required")) !== null ||
                  (await input.getAttribute("aria-required")) === "true",
      });
    } else {
      fields.push({
        type: "text",
        label,
        selector: id ? `#${id}` : `input[type="${type || "text"}"]`,
        required: (await input.getAttribute("required")) !== null ||
                  (await input.getAttribute("aria-required")) === "true",
      });
    }
  }

  // --- Textareas ---
  const textareas = modal.locator("textarea");
  const taCount = await textareas.count();
  for (let i = 0; i < taCount; i++) {
    const ta = textareas.nth(i);
    const isVisible = await ta.isVisible().catch(() => false);
    if (!isVisible) continue;

    const label = await getFieldLabel(page, ta);
    const id = await ta.getAttribute("id");

    fields.push({
      type: "textarea",
      label,
      selector: id ? `#${id}` : "textarea",
      required: (await ta.getAttribute("required")) !== null ||
                (await ta.getAttribute("aria-required")) === "true",
    });
  }

  // --- Select Dropdowns ---
  const selects = modal.locator("select");
  const selCount = await selects.count();
  for (let i = 0; i < selCount; i++) {
    const sel = selects.nth(i);
    const isVisible = await sel.isVisible().catch(() => false);
    if (!isVisible) continue;

    const label = await getFieldLabel(page, sel);
    const id = await sel.getAttribute("id");
    const options = await sel.locator("option").allTextContents();

    fields.push({
      type: "select",
      label,
      selector: id ? `#${id}` : "select",
      options: options.filter((o) => o.trim() !== "" && o !== "Select an option"),
      required: (await sel.getAttribute("required")) !== null,
    });
  }

  // --- Radio Button Groups ---
  const fieldsets = modal.locator("fieldset");
  const fsCount = await fieldsets.count();
  for (let i = 0; i < fsCount; i++) {
    const fs = fieldsets.nth(i);
    const isVisible = await fs.isVisible().catch(() => false);
    if (!isVisible) continue;

    const legend = await fs.locator("legend").first().textContent().catch(() => null);
    const label = legend?.trim() || await getFieldLabel(page, fs);
    const radios = fs.locator('input[type="radio"]');
    const radioCount = await radios.count();

    if (radioCount > 0) {
      const options: string[] = [];
      for (let j = 0; j < radioCount; j++) {
        const radio = radios.nth(j);
        const rId = await radio.getAttribute("id").catch(() => null);
        let radioLabel = "";
        if (rId) {
          const lEl = modal.locator(`label[for="${rId}"]`);
          radioLabel = (await lEl.textContent().catch(() => "")) || "";
        }
        if (!radioLabel) {
          radioLabel = (await getFieldLabel(page, radio)) || "";
        }
        if (radioLabel.trim()) options.push(radioLabel.trim());
      }

      fields.push({
        type: "radio",
        label,
        selector: `fieldset:nth-of-type(${i + 1})`,
        fieldsetIndex: i,
        options,
        required: true,
      });
    }
  }

  // --- Checkboxes ---
  const checkboxes = modal.locator('input[type="checkbox"]');
  const cbCount = await checkboxes.count();
  for (let i = 0; i < cbCount; i++) {
    const cb = checkboxes.nth(i);
    const isVisible = await cb.isVisible().catch(() => false);
    if (!isVisible) continue;

    const label = await getFieldLabel(page, cb);
    const isRequired = (await cb.getAttribute("required")) !== null ||
                       (await cb.getAttribute("aria-required")) === "true";

    fields.push({
      type: "checkbox",
      label,
      selector: `input[type="checkbox"]`,
      checkboxIndex: i,
      required: isRequired,
    });
  }

  // --- File Upload ---
  const fileInputs = modal.locator('input[type="file"]');
  const fileCount = await fileInputs.count();
  for (let i = 0; i < fileCount; i++) {
    const fileInput = fileInputs.nth(i);
    fields.push({
      type: "file",
      label: "Resume Upload",
      selector: 'input[type="file"]',
      required: true,
    });
  }

  return fields;
}

/**
 * Extracts the label text for a form field by checking:
 * 1. aria-label attribute
 * 2. Associated <label> element (via for/id or wrapping)
 * 3. Preceding text/label in the DOM
 */
async function getFieldLabel(
  page: Page,
  element: ReturnType<Page["locator"]>
): Promise<string> {
  // Check aria-label
  const ariaLabel = await element.getAttribute("aria-label").catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // Check aria-labelledby
  const labelledBy = await element
    .getAttribute("aria-labelledby")
    .catch(() => null);
  if (labelledBy) {
    const labelEl = page.locator(`#${labelledBy}`);
    const text = await labelEl.textContent().catch(() => null);
    if (text?.trim()) return text.trim();
  }

  // Check associated <label> via id
  const id = await element.getAttribute("id").catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id}"]`);
    const text = await label.textContent().catch(() => null);
    if (text?.trim()) return text.trim();
  }

  // Check wrapping <label>
  const parentLabel = element.locator("xpath=ancestor::label");
  const parentText = await parentLabel.textContent().catch(() => null);
  if (parentText?.trim()) return parentText.trim();

  // Check placeholder as last resort
  const placeholder = await element
    .getAttribute("placeholder")
    .catch(() => null);
  if (placeholder?.trim()) return placeholder.trim();

  return "Unknown field";
}

// ============================================================
// 3. Fill Form Fields
// ============================================================

/**
 * Fills a single detected form field using the form solver.
 * Returns the FormAnswer used, or null if skipped.
 */
async function fillField(
  page: Page,
  field: DetectedField,
  context: SolverContext,
  settings: Settings,
  dryRun: boolean
): Promise<FormAnswer | null> {
  const answer = await solveQuestion(
    field.label,
    field.options || [],
    context.resumeText,
    settings
  );

  // If answer is halt or null:
  if (answer.tier === "halt" || answer.answer === null) {
    if (!field.required) {
      console.log(chalk.gray(`    ↳ Optional field "${field.label}" skipped`));
      return {
        tier: "optional_skip" as any,
        question: field.label,
        answer: null,
      };
    }
    return answer;
  }

  if (dryRun) {
    console.log(
      chalk.gray(
        `    [DRY-RUN] Would fill "${field.label}" with "${answer.answer}"`
      )
    );
    return answer;
  }

  const modal = page.locator('div[role="dialog"]').first();

  try {
    switch (field.type) {
      case "text": {
        const input = modal.locator(field.selector).first();
        // Check if field already has a value
        const currentValue = await input.inputValue().catch(() => "");
        if (currentValue.trim() === "") {
          let textToType = answer.answer;
          const inputType = await input.getAttribute("type").catch(() => "");
          const inputMode = await input.getAttribute("inputmode").catch(() => "");
          const inputId = await input.getAttribute("id").catch(() => "");
          if (inputType === "number" || inputMode === "numeric") {
            textToType = textToType.replace(/[^0-9.]/g, "");
          }
          if ((inputId || "").includes("nationalNumber") || /national.*number/i.test(field.label) || /phone|mobile/i.test(field.label)) {
            // Strip leading country code if present (e.g. +91 8910598758 -> 8910598758)
            textToType = textToType.replace(/^\s*\+\d{1,4}\s*/, "").replace(/[^0-9]/g, "");
          }
          await input.click().catch(() => {});
          await shortPause();
          await input.fill("");
          await input.pressSequentially(textToType, { delay: randomKeystrokeDelay() });
          await input.dispatchEvent("input").catch(() => {});
          await input.dispatchEvent("change").catch(() => {});
        }
        break;
      }

      case "textarea": {
        const textarea = modal.locator(field.selector).first();
        const currentValue = await textarea.inputValue().catch(() => "");
        if (currentValue.trim() === "") {
          await textarea.click().catch(() => {});
          await shortPause();
          await textarea.fill("");
          await textarea.pressSequentially(answer.answer, { delay: randomKeystrokeDelay() });
          await textarea.dispatchEvent("input").catch(() => {});
          await textarea.dispatchEvent("change").catch(() => {});
        }
        break;
      }

      case "select": {
        const select = modal.locator(field.selector).first();
        // Find the best matching option
        const bestOption = findBestOption(answer.answer, field.options || []);
        if (bestOption) {
          await select.selectOption({ label: bestOption }).catch(async () => {
            await select.selectOption({ value: bestOption }).catch(() => {});
          });
        }
        break;
      }

      case "radio": {
        const fieldsets = modal.locator("fieldset");
        const fs = typeof field.fieldsetIndex === "number"
          ? fieldsets.nth(field.fieldsetIndex)
          : modal.locator(field.selector).first();

        const bestOption = findBestOption(answer.answer, field.options || []);
        if (bestOption && (await fs.isVisible().catch(() => false))) {
          // 1. Try clicking label matching the option inside this specific fieldset
          const targetLabel = fs
            .locator("label")
            .filter({
              hasText: new RegExp(
                `^\\s*${bestOption.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
                "i"
              ),
            })
            .first();

          if (await targetLabel.isVisible().catch(() => false)) {
            await targetLabel.click({ force: true });
          } else {
            // 2. Try partial text on label
            const partialLabel = fs.locator(`label:has-text("${bestOption}")`).first();
            if (await partialLabel.isVisible().catch(() => false)) {
              await partialLabel.click({ force: true });
            } else {
              // 3. Fallback to radio input index
              const optIndex = (field.options || []).indexOf(bestOption);
              if (optIndex >= 0) {
                const radioInput = fs.locator('input[type="radio"]').nth(optIndex);
                await radioInput.check({ force: true }).catch(() => radioInput.click({ force: true }));
              }
            }
          }
        }
        break;
      }

      case "checkbox": {
        const cb = typeof field.checkboxIndex === "number"
          ? modal.locator('input[type="checkbox"]').nth(field.checkboxIndex)
          : modal.locator(field.selector).first();

        if (field.required) {
          const isChecked = await cb.isChecked().catch(() => false);
          if (!isChecked) {
            await cb.check({ force: true }).catch(() => cb.click({ force: true }));
          }
        }
        break;
      }

      case "combobox": {
        await handleCombobox(page, modal, field, answer.answer);
        break;
      }

      case "file": {
        // File uploads are handled separately in handleResumeUpload
        break;
      }

      default:
        break;
    }

    await shortPause();
  } catch (err) {
    console.warn(
      chalk.yellow(
        `    ⚠ Could not fill "${field.label}": ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  return answer;
}

/**
 * Handles typeahead/combobox fields:
 * 1. Type the answer text to trigger the dropdown
 * 2. Wait for the listbox to appear
 * 3. Select the best matching option from the dropdown
 */
async function handleCombobox(
  page: Page,
  modal: ReturnType<Page["locator"]>,
  field: DetectedField,
  answerText: string
): Promise<void> {
  const input = modal.locator(field.selector).first();

  // Clear and type to trigger suggestions
  await input.click();
  await shortPause();
  await input.fill("");
  await input.type(answerText, { delay: randomKeystrokeDelay() });

  // Wait for the dropdown listbox to appear
  await jitterDelay(1200, 500);

  const listbox = page.locator('[role="listbox"], [role="list"]').first();
  const isListVisible = await listbox
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (isListVisible) {
    // Get all options in the dropdown
    const options = listbox.locator(
      '[role="option"], [role="listitem"], li'
    );
    const optionCount = await options.count();

    if (optionCount > 0) {
      // Find the best matching option
      let bestIndex = 0;
      let bestScore = -1;
      const normalizedAnswer = answerText.toLowerCase();

      for (let i = 0; i < optionCount; i++) {
        const optText = (await options.nth(i).textContent()) || "";
        const normalizedOpt = optText.toLowerCase().trim();

        // Score by similarity
        let score = 0;
        if (normalizedOpt === normalizedAnswer) score = 100;
        else if (normalizedOpt.includes(normalizedAnswer)) score = 80;
        else if (normalizedAnswer.includes(normalizedOpt)) score = 60;
        else {
          // Word overlap scoring
          const answerWords = normalizedAnswer.split(/\s+/);
          const optWords = normalizedOpt.split(/\s+/);
          const overlap = answerWords.filter((w) => optWords.includes(w)).length;
          score = (overlap / Math.max(answerWords.length, 1)) * 50;
        }

        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      // Click the best matching option
      await options.nth(bestIndex).click();
      await shortPause();
      console.log(
        chalk.gray(
          `      ↳ Combobox: selected option #${bestIndex + 1} (score: ${bestScore})`
        )
      );
    }
  } else {
    // No dropdown appeared — the typed text will remain as-is
    console.log(
      chalk.gray(`      ↳ Combobox: no dropdown appeared, using typed value`)
    );
  }
}

// ============================================================
// 4. Resume Upload Handling
// ============================================================

/**
 * Handles resume upload in the Easy Apply modal.
 * Checks if a resume is already uploaded (pre-existing) before uploading.
 */
async function handleResumeUpload(
  page: Page,
  settings: Settings
): Promise<void> {
  const modal = page.locator('div[role="dialog"]').first();

  // Check if a resume is already uploaded (LinkedIn may pre-fill from profile)
  const existingResume = modal.locator(
    [
      '[aria-label*="resume" i]',
      '[aria-label*="cv" i]',
      'text=/resume.*uploaded/i',
      'text=/\\.pdf$/i',
      'text=/\\.docx$/i',
    ].join(", ")
  );

  const hasExisting = await existingResume
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (hasExisting) {
    console.log(
      chalk.green(`    ✔ Resume already uploaded (pre-existing)`)
    );

    // Check if there's an option to replace it
    const replaceBtn = modal.locator(
      'button:has-text("Replace"), button:has-text("Upload"), button[aria-label*="upload" i]'
    );
    const canReplace = await replaceBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (canReplace) {
      // User might want their latest resume — upload the new one
      const resumePath = getResumeFilePath();
      try {
        const fileInput = modal.locator('input[type="file"]').first();
        await fileInput.setInputFiles(resumePath);
        await jitterDelay(1500, 600);
        console.log(
          chalk.green(`    ✔ Replaced with latest resume: ${path.basename(resumePath)}`)
        );
      } catch {
        console.log(
          chalk.yellow(`    ⚠ Could not replace resume — keeping existing`)
        );
      }
    }
    return;
  }

  // No existing resume — upload ours
  const fileInput = modal.locator('input[type="file"]');
  const hasFileInput = await fileInput
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!hasFileInput) {
    // Sometimes the file input is hidden; try clicking an upload button first
    const uploadBtn = modal.locator(
      'button:has-text("Upload"), button[aria-label*="upload" i], label:has-text("Upload")'
    );
    const hasBtnUpload = await uploadBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasBtnUpload) {
      // Wait for file chooser when clicking the button
      const fileChooserPromise = page.waitForEvent("filechooser", {
        timeout: 5000,
      });
      await uploadBtn.first().click();
      const fileChooser = await fileChooserPromise;
      const resumePath = getResumeFilePath();
      await fileChooser.setFiles(resumePath);
      await jitterDelay(1500, 600);
      console.log(
        chalk.green(`    ✔ Resume uploaded: ${path.basename(resumePath)}`)
      );
      return;
    }

    // No upload mechanism found on this step — not necessarily an error
    return;
  }

  const resumePath = getResumeFilePath();
  await fileInput.first().setInputFiles(resumePath);
  await jitterDelay(1500, 600);
  console.log(
    chalk.green(`    ✔ Resume uploaded: ${path.basename(resumePath)}`)
  );
}

// ============================================================
// 5. Modal Navigation — Step Through
// ============================================================

export interface StepResult {
  answers: FormAnswer[];
  reachedReview: boolean;
  halted: boolean;
  error?: string;
}

/**
 * Steps through the entire Easy Apply modal form:
 * - Detects and fills fields on each page
 * - Handles resume upload
 * - Clicks "Next" until reaching the review page
 * - Returns all answers collected and whether the review screen was reached
 */
export async function stepThroughModal(
  page: Page,
  job: ScoredJob,
  context: SolverContext,
  settings: Settings,
  dryRun: boolean
): Promise<StepResult> {
  const allAnswers: FormAnswer[] = [];
  let stepNum = 0;
  const maxSteps = 10; // Safety limit to prevent infinite loops

  while (stepNum < maxSteps) {
    stepNum++;
    console.log(chalk.blue(`\n  📝 Form Step ${stepNum}:`));

    const modal = page.locator('div[role="dialog"]').first();
    const isModalVisible = await modal
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!isModalVisible) {
      return {
        answers: allAnswers,
        reachedReview: false,
        halted: false,
        error: "Modal closed unexpectedly",
      };
    }

    // Handle resume upload on this step
    await handleResumeUpload(page, settings);

    // Detect and fill form fields
    const fields = await detectFormFields(page);

    if (fields.length > 0) {
      console.log(chalk.gray(`    Found ${fields.length} field(s)`));
      let stepNeedsReview = false;

      for (const field of fields) {
        if (field.type === "file") continue; // Already handled above

        const answer = await fillField(page, field, context, settings, dryRun);
        if (answer) {
          allAnswers.push(answer);

          // Only halt if a REQUIRED field could not be solved
          if (answer.tier === "halt" && field.required) {
            stepNeedsReview = true;
          }
        }
      }

      if (stepNeedsReview) {
        console.warn(
          chalk.yellow(`    ⚠ Required field(s) need human review on this step.`)
        );
        return {
          answers: allAnswers,
          reachedReview: false,
          halted: true,
        };
      }
    } else {
      console.log(chalk.gray(`    No fillable fields detected on this step`));
    }

    await jitterDelay(1500, 600);

    // --- Determine next action ---

    // Check if we're on the review page
    const reviewBtn = modal.locator(
      'button[aria-label*="Review" i], button:has-text("Review your application"), button:has-text("Review")'
    );
    const isReviewStep = await reviewBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (isReviewStep && !dryRun) {
      // Click Review to go to the final review screen
      await reviewBtn.first().click();
      await jitterDelay(1800, 600);
      console.log(chalk.green(`    ✔ Navigated to review screen`));
      return {
        answers: allAnswers,
        reachedReview: true,
        halted: false,
      };
    }

    // Check for Submit button (some applications skip the review page)
    const submitBtn = modal.locator(
      'button[aria-label*="Submit" i], button:has-text("Submit application")'
    );
    const isSubmitStep = await submitBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (isSubmitStep) {
      console.log(
        chalk.green(`    ✔ Reached submit screen (no separate review page)`)
      );
      return {
        answers: allAnswers,
        reachedReview: true,
        halted: false,
      };
    }

    // Click Next to proceed
    const nextBtn = modal.locator(
      'button[aria-label*="Next" i], button[aria-label*="Continue" i], button:has-text("Next"), button:has-text("Continue"), footer button.artdeco-button--primary'
    );
    const hasNext = await nextBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasNext && !dryRun) {
      await nextBtn.first().click({ force: true });
      await jitterDelay(2000, 800);

      // Check if validation error prevented advancing
      const errorEl = modal
        .locator(
          '.artdeco-inline-feedback--error, [data-test-form-element-error-messages]'
        )
        .first();
      const hasValidationError = await errorEl
        .isVisible({ timeout: 1500 })
        .catch(() => false);

      if (hasValidationError) {
        const errText = (await errorEl.textContent().catch(() => "")) || "";
        console.warn(
          chalk.yellow(`    ⚠ Validation error on step: ${errText.trim()}`)
        );
        return {
          answers: allAnswers,
          reachedReview: false,
          halted: true,
        };
      }
    } else if (!hasNext) {
      // No Next, Review, or Submit — might be stuck
      console.warn(
        chalk.yellow(`    ⚠ No navigation button found — form may be complete or stuck`)
      );
      return {
        answers: allAnswers,
        reachedReview: false,
        halted: false,
        error: "No navigation button found on form step",
      };
    }

    if (dryRun) {
      console.log(chalk.gray(`    [DRY-RUN] Would click Next`));
      return {
        answers: allAnswers,
        reachedReview: false,
        halted: false,
      };
    }
  }

  return {
    answers: allAnswers,
    reachedReview: false,
    halted: false,
    error: `Exceeded maximum form steps (${maxSteps})`,
  };
}

// ============================================================
// 6. Human-in-the-Loop: Pause for Review
// ============================================================

/**
 * Pauses execution on the final review screen and displays all pre-filled
 * answers in the terminal. Waits indefinitely for the user to:
 * - Inspect the application in the browser
 * - Manually click "Submit" if satisfied
 * - Press ENTER in the terminal to advance to the next job
 * - Press Ctrl+C to abort the pipeline
 */
export async function pauseForReview(
  page: Page,
  job: ScoredJob,
  answers: FormAnswer[]
): Promise<void> {
  console.log(chalk.blue.bold(`\n${"═".repeat(70)}`));
  console.log(
    chalk.blue.bold(`  ⏸️  REVIEW MODE — Human Approval Required`)
  );
  console.log(chalk.blue.bold(`${"═".repeat(70)}`));
  console.log(
    chalk.white(
      `  Job:     ${job.title} @ ${job.company}`
    )
  );
  console.log(
    chalk.white(`  Score:   ${job.matchScore}%`)
  );
  console.log(
    chalk.white(`  URL:     ${job.url}`)
  );
  console.log(chalk.blue(`${"─".repeat(70)}`));

  // Display all answers
  if (answers.length > 0) {
    console.log(chalk.white.bold(`  Pre-filled Answers:`));
    for (const a of answers) {
      const tierLabel =
        a.tier === "deterministic" || a.tier === "tier1_deterministic"
          ? chalk.green("[T1]")
          : a.tier === "ai_context" || a.tier === "tier2_ai"
            ? chalk.cyan("[T2]")
            : chalk.red("[T3]");
      const answerStr = a.answer
        ? `"${a.answer.substring(0, 50)}${a.answer.length > 50 ? "..." : ""}"`
        : chalk.red("UNANSWERED");
      console.log(`  ${tierLabel} ${chalk.gray(a.question)}`);
      console.log(`       → ${answerStr}`);
    }
  }

  console.log(chalk.blue(`${"─".repeat(70)}`));
  console.log(
    chalk.yellow.bold(
      `\n  👆 Review the application in the browser window.`
    )
  );
  console.log(
    chalk.yellow(
      `     Click "Submit application" in the browser when ready.`
    )
  );
  console.log(
    chalk.gray(`     (Waiting for you to close or submit the modal...)`)
  );

  // Poll until the modal disappears
  // Using page.locator('div[role="dialog"]').isVisible()
  while (true) {
    try {
      const isModalVisible = await page.locator('div[role="dialog"]').first().isVisible().catch(() => false);
      if (!isModalVisible) break;
    } catch {
      break; // Page might have closed or navigated
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(chalk.green(`  ✔ Modal closed. Moving to next job.`));
}

// ============================================================
// 7. Discard Application Handling
// ============================================================

/**
 * Handles LinkedIn's "Discard application?" confirmation dialog.
 * This appears when the user closes the modal or navigates away
 * from an in-progress application.
 */
export async function handleDiscardModal(page: Page): Promise<void> {
  try {
    // Look for the discard confirmation dialog
    const discardModal = page.locator(
      'div[role="alertdialog"], div[data-test-modal]:has-text("Discard")'
    );

    const isVisible = await discardModal
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (!isVisible) return;

    console.log(chalk.gray(`    ↳ Dismissing "Discard application?" dialog`));

    // Click "Discard" to confirm dismissal
    const discardBtn = discardModal.locator(
      'button:has-text("Discard"), button[data-test-dialog-primary-btn]'
    );

    const hasDiscard = await discardBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasDiscard) {
      await discardBtn.first().click();
      await jitterDelay(1000, 400);
    }
  } catch {
    // Ignore errors — discard modal may not always appear
  }
}

/**
 * Safely closes any open Easy Apply modal, handling the discard
 * confirmation if it appears.
 */
export async function safeCloseModal(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    const modal = page.locator('div[role="dialog"]').first();
    const isVisible = await modal
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (!isVisible) return;

    // Click the dismiss/close button
    const closeBtn = page.locator(
      'button[aria-label="Dismiss" i], button[aria-label="Close" i], div[role="dialog"] button:has(svg[data-test-icon="close"])'
    );

    const hasClose = await closeBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasClose) {
      await closeBtn.first().click();
      await jitterDelay(800, 300);
    }

    // Handle the "Discard application?" confirmation
    await handleDiscardModal(page);
  } catch {
    // Best-effort cleanup
  }
}

// ============================================================
// 8. Screenshot on Error
// ============================================================

/**
 * Captures a screenshot for error diagnosis.
 */
export async function captureErrorScreenshot(
  page: Page,
  screenshotsDir: string,
  jobTitle: string
): Promise<string | null> {
  if (page.isClosed()) return null;
  try {
    const sanitized = jobTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `error_${sanitized}_${timestamp}.png`;
    const filepath = path.join(screenshotsDir, filename);

    await page.screenshot({ path: filepath, fullPage: false });
    console.log(chalk.gray(`    📸 Screenshot saved: ${filename}`));
    return filepath;
  } catch {
    return null;
  }
}

// ============================================================
// Utility Helpers
// ============================================================

/**
 * Finds the best matching option from a list given an answer string.
 * Uses case-insensitive substring matching with fallback to first option.
 */
function findBestOption(answer: string, options: string[]): string | null {
  if (options.length === 0) return null;

  // Filter out placeholder options like "Select an option", "Choose..."
  const nonPlaceholders = options.filter((o) => !/^\s*(select|choose|--)/i.test(o.trim()));
  const candidateOptions = nonPlaceholders.length > 0 ? nonPlaceholders : options;

  const normalized = answer.toLowerCase().trim();

  // Exact match
  const exact = candidateOptions.find((o) => o.toLowerCase().trim() === normalized);
  if (exact) return exact;

  // Phone country code match (e.g. answer has +91 and option has (+91) or India)
  const countryCodeMatch = normalized.match(/\+(\d{1,4})/);
  if (countryCodeMatch) {
    const code = countryCodeMatch[1];
    const byCode = candidateOptions.find(
      (o) => new RegExp(`\\(\\+?${code}\\)`).test(o) || o.includes(`+${code}`)
    );
    if (byCode) return byCode;
  }

  // Substring match
  const partial = candidateOptions.find(
    (o) =>
      o.toLowerCase().includes(normalized) ||
      normalized.includes(o.toLowerCase())
  );
  if (partial) return partial;

  // Word overlap match (best effort)
  const answerWords = normalized.split(/[\s,()+-]+/).filter(Boolean);
  let bestOption: string | null = null;
  let bestScore = 0;

  for (const opt of candidateOptions) {
    const optWords = opt.toLowerCase().split(/[\s,()+-]+/).filter(Boolean);
    const overlap = answerWords.filter((w) => optWords.includes(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestOption = opt;
    }
  }

  if (bestScore > 0 && bestOption) return bestOption;

  // Common affirmative matching
  if (["yes", "true", "1", "authorized", "y"].includes(normalized)) {
    const yesOpt = candidateOptions.find((o) => /^yes/i.test(o.trim()));
    if (yesOpt) return yesOpt;
  }

  if (["no", "false", "0", "n"].includes(normalized)) {
    const noOpt = candidateOptions.find((o) => /^no/i.test(o.trim()));
    if (noOpt) return noOpt;
  }

  return candidateOptions[0];
}

/**
 * Waits for the user to press ENTER in the terminal.
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = process.stdin;
    rl.setRawMode?.(false);
    rl.resume();
    rl.once("data", () => {
      resolve();
    });
  });
}

/**
 * ingestion.ts — Job JSON parser, blacklist filter, and history deduplication
 *
 * Reads the raw JSON output from a cloud scraper (e.g., Apify), normalizes
 * field names to a canonical shape, validates each entry, applies blacklist
 * filtering, and removes jobs the user has already applied to in prior runs.
 *
 * Supports fetching directly from Apify if mode='api', or reading local JSON if mode='manual'.
 */

import fs from "node:fs";
import chalk from "chalk";
import { ApifyClient } from "apify-client";
import {
  RawJobSchema,
  normalizeRawJobInput,
  type RawJob,
  type Blacklist,
  type Settings,
} from "./types.js";
import { paths, loadHistory, getApifyToken, loadCandidateProfile } from "./config.js";

// ============================================================
// Apify API Fetch
// ============================================================

async function fetchFromApify(settings: Settings): Promise<void> {
  const token = getApifyToken();
  const client = new ApifyClient({ token });
  const actorId = settings.ingestion.apify_actor_id;

  if (!actorId) {
    console.error(chalk.red.bold(`✖ [INGEST ERROR] apify_actor_id is required in mode 'api'.`));
    throw new Error('apify_actor_id is required in mode "api"');
  }

  console.log(chalk.blue.bold(`\n🌍 [APIFY]`), `Triggering actor: ${actorId}...`);

  try {
    const input = settings.ingestion.apify_input || {};
    
    // Inject dynamic search terms from the AI Candidate Profile
    const profile = loadCandidateProfile();
    if (profile.search?.titles?.length > 0) {
      input.titles = profile.search.titles;
    }
    if (profile.search?.locations?.length > 0) {
      input.locations = profile.search.locations;
    }

    const run = await client.actor(actorId).call(input);
    
    console.log(chalk.gray(`  Actor run finished (ID: ${run.id}). Fetching dataset...`));

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    
    fs.writeFileSync(paths.jobsRaw, JSON.stringify(items, null, 2), "utf-8");
    console.log(chalk.green(`  ✔ Saved ${items.length} raw jobs to data/jobs_raw.json`));
  } catch (err) {
    console.error(
      chalk.red.bold(`✖ [APIFY ERROR]`),
      `Failed to fetch from Apify: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}

// ============================================================
// JSON Ingestion
// ============================================================

/**
 * Reads and parses `data/jobs_raw.json`, normalizing field names
 * and validating each entry. Malformed entries are logged and skipped.
 */
export function ingestRawJobs(): RawJob[] {
  if (!fs.existsSync(paths.jobsRaw)) {
    console.error(
      chalk.red.bold(`✖ [INGEST ERROR]`),
      `File not found: ${paths.jobsRaw}`
    );
    console.error(
      chalk.red(
        `  Export your Apify scraper results to data/jobs_raw.json and retry.`
      )
    );
    throw new Error('File not found: data/jobs_raw.json');
  }

  let rawArray: unknown[];
  try {
    const content = fs.readFileSync(paths.jobsRaw, "utf-8");
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      console.error(
        chalk.red.bold(`✖ [INGEST ERROR]`),
        `jobs_raw.json must contain a JSON array. Got: ${typeof parsed}`
      );
      throw new Error('jobs_raw.json must contain a JSON array');
    }

    rawArray = parsed;
  } catch (err) {
    console.error(
      chalk.red.bold(`✖ [INGEST ERROR]`),
      `Failed to parse jobs_raw.json: ${err instanceof Error ? err.message : String(err)}`
    );
    throw new Error('Failed to parse jobs_raw.json');
  }

  console.log(
    chalk.blue.bold(`\n📥 [INGEST]`),
    `Read ${rawArray.length} entries from jobs_raw.json`
  );

  const validJobs: RawJob[] = [];
  let skipped = 0;

  for (let i = 0; i < rawArray.length; i++) {
    const entry = rawArray[i];
    if (typeof entry !== "object" || entry === null) {
      console.warn(
        chalk.yellow(`  ⚠ Entry #${i + 1}: not an object, skipping`)
      );
      skipped++;
      continue;
    }

    // Normalize field names from various scraper conventions
    const normalized = normalizeRawJobInput(
      entry as Record<string, unknown>
    );

    const result = RawJobSchema.safeParse(normalized);
    if (!result.success) {
      const issues = result.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      console.warn(
        chalk.yellow(`  ⚠ Entry #${i + 1}: validation failed (${issues})`)
      );
      skipped++;
      continue;
    }

    validJobs.push(result.data);
  }

  if (skipped > 0) {
    console.log(
      chalk.yellow(`  ↳ Skipped ${skipped} invalid entries`)
    );
  }

  console.log(
    chalk.green(`  ↳ ${validJobs.length} valid jobs ingested`)
  );

  return validJobs;
}

// ============================================================
// Blacklist Filter
// ============================================================

/**
 * Filters out jobs where the company name or job description
 * matches entries in the blacklist. All matching is case-insensitive.
 */
export function applyBlacklist(
  jobs: RawJob[],
  blacklist: Blacklist
): RawJob[] {
  const blockedCompanies = blacklist.companies.map((c) => c.toLowerCase());
  const blockedKeywords = blacklist.keywords.map((k) => k.toLowerCase());

  const passed: RawJob[] = [];
  let blocked = 0;

  for (const job of jobs) {
    const companyLower = job.company.toLowerCase();
    const descLower = job.description.toLowerCase();
    const titleLower = job.title.toLowerCase();

    // Check company name (substring match)
    const companyBlocked = blockedCompanies.some(
      (bc) => companyLower.includes(bc)
    );
    if (companyBlocked) {
      console.log(
        chalk.red(`  ✗ Blocked (company): ${job.company} — "${job.title}"`)
      );
      blocked++;
      continue;
    }

    // Check keywords against description AND title
    const keywordMatch = blockedKeywords.find(
      (kw) => descLower.includes(kw) || titleLower.includes(kw)
    );
    if (keywordMatch) {
      console.log(
        chalk.red(
          `  ✗ Blocked (keyword: "${keywordMatch}"): ${job.company} — "${job.title}"`
        )
      );
      blocked++;
      continue;
    }

    passed.push(job);
  }

  console.log(
    chalk.blue.bold(`\n🚫 [BLACKLIST]`),
    `${blocked} jobs blocked, ${passed.length} passed`
  );

  return passed;
}

// ============================================================
// History Deduplication
// ============================================================

/**
 * Removes jobs that the user has already applied to in previous runs.
 * Checks against `data/history.json`.
 */
export function deduplicateHistory(jobs: RawJob[]): RawJob[] {
  const history = loadHistory();
  if (history.length === 0) {
    return jobs;
  }

  const appliedUrls = new Set(history.map((h) => h.url));
  const fresh: RawJob[] = [];
  let dupes = 0;

  for (const job of jobs) {
    if (appliedUrls.has(job.url)) {
      console.log(
        chalk.gray(
          `  ↻ Already applied: ${job.company} — "${job.title}"`
        )
      );
      dupes++;
      continue;
    }
    fresh.push(job);
  }

  if (dupes > 0) {
    console.log(
      chalk.blue.bold(`\n📋 [HISTORY]`),
      `${dupes} duplicates removed, ${fresh.length} new jobs remain`
    );
  }

  return fresh;
}

// ============================================================
// Combined Pipeline
// ============================================================

/**
 * Runs the full ingestion pipeline: parse → blacklist → deduplicate.
 * Returns the filtered array of jobs ready for Gemini scoring.
 */
export async function runIngestionPipeline(
  blacklist: Blacklist,
  settings: Settings
): Promise<RawJob[]> {
  if (settings.ingestion.mode === "api") {
    await fetchFromApify(settings);
  }

  const raw = ingestRawJobs();
  const filtered = applyBlacklist(raw, blacklist);
  const deduped = deduplicateHistory(filtered);

  if (deduped.length === 0) {
    console.log(
      chalk.yellow.bold(`\n⚠ [INGEST]`),
      `No jobs remaining after filtering. Nothing to score.`
    );
  }

  return deduped;
}

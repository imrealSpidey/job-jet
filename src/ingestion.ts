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
    const input: Record<string, any> = { ...settings.ingestion.apify_input };
    
    // Default to at least 40 jobs if not configured or too small
    if (!input.rows || input.rows <= 10) {
      input.rows = 40;
    }
    // Default easyApply to true if not explicitly false
    if (input.easyApply === undefined) {
      input.easyApply = true;
    }

    // Inject dynamic search terms from the AI Candidate Profile
    const profile = loadCandidateProfile();
    if (profile.search?.titles?.length > 0) {
      input.titles = profile.search.titles;
    }
    if (profile.search?.locations?.length > 0) {
      input.locations = profile.search.locations;
    }

    console.log(chalk.gray(`  Searching titles: ${JSON.stringify(input.titles || [])}`));
    console.log(chalk.gray(`  Searching locations: ${JSON.stringify(input.locations || [])}`));
    console.log(chalk.gray(`  Max rows requested: ${input.rows}, Easy Apply: ${input.easyApply}`));

    const run = await client.actor(actorId).call(input);
    
    console.log(chalk.gray(`  Actor run finished (ID: ${run.id}). Fetching dataset...`));

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    
    // Merge new items with existing raw jobs by URL/ID so previous scrapes are not lost
    let existingJobs: any[] = [];
    if (fs.existsSync(paths.jobsRaw)) {
      try {
        existingJobs = JSON.parse(fs.readFileSync(paths.jobsRaw, "utf-8"));
      } catch {}
    }

    const seenUrls = new Set(existingJobs.map((j: any) => j.url || j.jobUrl || j.applyUrl || j.id));
    let newItemsCount = 0;
    for (const item of items) {
      const url = (item as any).url || (item as any).jobUrl || (item as any).applyUrl || (item as any).id;
      if (url && !seenUrls.has(url)) {
        existingJobs.push(item);
        seenUrls.add(url);
        newItemsCount++;
      }
    }

    // If existing jobs was empty, just write items
    const toSave = existingJobs.length > 0 ? existingJobs : items;
    fs.writeFileSync(paths.jobsRaw, JSON.stringify(toSave, null, 2), "utf-8");
    console.log(chalk.green(`  ✔ Ingested ${items.length} jobs (${newItemsCount} new, total ${toSave.length} in jobs_raw.json)`));
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
 * Removes jobs that the user has already successfully applied to in previous runs.
 * Only filters entries with status === "applied" (temporary skips/errors are not permanently blocked).
 */
export function deduplicateHistory(jobs: RawJob[]): RawJob[] {
  const history = loadHistory();
  if (history.length === 0) {
    return jobs;
  }

  // ONLY drop jobs that have actually been submitted / applied to
  const appliedUrls = new Set(history.filter((h) => h.status === "applied").map((h) => h.url));
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
      `${dupes} already-applied jobs excluded, ${fresh.length} fresh jobs remain`
    );
  }

  return fresh;
}

// ============================================================
// Intelligent Role Relevance Filter
// ============================================================

/**
 * Filters out jobs whose primary role category conflicts with the candidate's target roles.
 * For example, if candidate targets are UI/UX Designer, Product Designer (Design track),
 * jobs like Frontend Developer, Software Engineer, Backend Engineer are filtered out.
 */
export function filterByRoleRelevance(jobs: RawJob[], targetTitles: string[]): RawJob[] {
  if (!targetTitles || targetTitles.length === 0) return jobs;

  const targetsLower = targetTitles.map((t) => t.toLowerCase());
  const isDesignCandidate = targetsLower.some((t) =>
    t.includes("design") || t.includes("ux") || t.includes("ui") || t.includes("product designer")
  );
  const isDeveloperCandidate = targetsLower.some((t) =>
    t.includes("developer") || t.includes("engineer") || t.includes("programmer") || t.includes("coder")
  );

  const devRoleKeywords = [
    "frontend developer", "front end developer", "backend developer", "back end developer",
    "full stack developer", "fullstack developer", "full stack engineer", "software engineer",
    "software developer", "react developer", "web developer", "java developer", "python developer",
    "devops engineer", "qa engineer", "test engineer", "mobile developer", "ios developer", "android developer"
  ];

  const designRoleKeywords = [
    "ux designer", "ui designer", "product designer", "interaction designer", "visual designer",
    "user experience designer", "user interface designer", "ui/ux", "ux/ui"
  ];

  const passed: RawJob[] = [];
  let filteredCount = 0;

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();

    // Candidate is in Design track, but scraped job is purely Engineering/Development
    if (isDesignCandidate && !isDeveloperCandidate) {
      const isDevRole = devRoleKeywords.some((kw) => titleLower.includes(kw));
      const hasDesignInTitle = titleLower.includes("designer") || titleLower.includes("design") ||
                               titleLower.includes("ux") || titleLower.includes("ui") ||
                               titleLower.includes("creative");

      if (isDevRole && !hasDesignInTitle) {
        console.log(
          chalk.red(`  ✗ Role Filtered (Mismatch): "${job.title}" at ${job.company} is a developer/engineering role (seeking Design)`)
        );
        filteredCount++;
        continue;
      }
    }

    // Candidate is Developer track, but scraped job is purely Design
    if (isDeveloperCandidate && !isDesignCandidate) {
      const isDesignRole = designRoleKeywords.some((kw) => titleLower.includes(kw));
      const hasDevInTitle = titleLower.includes("developer") || titleLower.includes("engineer") || titleLower.includes("software");

      if (isDesignRole && !hasDevInTitle) {
        console.log(
          chalk.red(`  ✗ Role Filtered (Mismatch): "${job.title}" at ${job.company} is a design role (seeking Engineering)`)
        );
        filteredCount++;
        continue;
      }
    }

    passed.push(job);
  }

  if (filteredCount > 0) {
    console.log(
      chalk.blue.bold(`\n🎯 [ROLE FILTER]`),
      `${filteredCount} off-target discipline jobs filtered out, ${passed.length} relevant jobs retained.`
    );
  }

  return passed;
}

// ============================================================
// Combined Pipeline
// ============================================================

/**
 * Runs the full ingestion pipeline: parse → blacklist → role relevance → deduplicate.
 * Returns the filtered array of jobs ready for AI scoring.
 */
export async function runIngestionPipeline(
  blacklist: Blacklist,
  settings: Settings
): Promise<RawJob[]> {
  if (settings.ingestion.mode === "api") {
    await fetchFromApify(settings);
  }

  const raw = ingestRawJobs();
  const blacklisted = applyBlacklist(raw, blacklist);

  // Apply intelligent role relevance filter against candidate profile target titles
  const profile = loadCandidateProfile();
  const roleFiltered = filterByRoleRelevance(blacklisted, profile.search?.titles || []);

  const deduped = deduplicateHistory(roleFiltered);

  if (deduped.length === 0) {
    console.log(
      chalk.yellow.bold(`\n⚠ [INGEST]`),
      `No jobs remaining after filtering. Nothing to score.`
    );
  }

  return deduped;
}

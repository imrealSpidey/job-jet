import OpenAI from "openai";
import chalk from "chalk";
import { modelRegistry } from "./registry.js";
import { tryGetApiKeys } from "../config.js";
import type { Settings, AiTaskType } from "../types.js";

let isAborted = false;

export function abortAiOperations(aborted: boolean = true) {
  isAborted = aborted;
}
export function isAiAborted(): boolean {
  return isAborted;
}

export function getBaseUrl(provider: string, settings: Settings): string {
  const custom = settings.ai?.providers?.[provider]?.baseUrl;
  if (custom) return custom;
  
  switch(provider) {
    case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai/';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'groq': return 'https://api.groq.com/openai/v1';
    case 'mistral': return 'https://api.mistral.ai/v1';
    default: return 'https://openrouter.ai/api/v1';
  }
}

const TRANSIENT_ERRORS = new Set([500, 502, 503, 504, 408]);

export async function executeTask<T>(
  settings: Settings,
  task: AiTaskType,
  action: (client: OpenAI, model: string) => Promise<T>
): Promise<T> {
  const priorityList = settings.ai?.priority_list || [];
  if (priorityList.length === 0) {
    throw new Error("AI priority list is empty.");
  }

  const errors: Error[] = [];

  for (const candidate of priorityList) {
    const { provider, model } = candidate;
    
    if (settings.ai?.providers?.[provider]?.enabled === false) continue;

    const apiKeys = tryGetApiKeys(provider as any);
    if (!apiKeys || apiKeys.length === 0) continue;

    const metadata = modelRegistry.getModel(provider, model);
    if (metadata?.status === 'cooling_down') {
      if (metadata.lastFailure && Date.now() - metadata.lastFailure > 5 * 60 * 1000) {
        metadata.status = 'available';
      } else {
        continue;
      }
    }
    if (metadata?.status === 'unsupported') continue;

    const client = new OpenAI({
      apiKey: apiKeys[0],
      baseURL: getBaseUrl(provider, settings),
      timeout: 30000,
      defaultHeaders: provider === 'openrouter' ? {
        'HTTP-Referer': 'https://github.com/imrealSpidey/job-jet',
        'X-Title': 'Job Jet'
      } : undefined
    });

    try {
      console.log(chalk.blue(`\n  -> [${task}] Trying ${provider}/${model}...`));
      let attempts = 0;
      while (attempts < 3) {
        if (isAborted) throw new Error("Aborted by user");
        try {
          const result = await action(client, model);
          modelRegistry.reportSuccess(provider, model);
          return result;
        } catch (error: any) {
          attempts++;
          const status = error?.status;
          const msg = error?.message || String(error);
          
          if (status === 429) {
            const retryAfter = error?.headers?.['retry-after'];
            if (retryAfter && parseInt(retryAfter) > 15) {
               console.warn(chalk.yellow(`  ⚠ [${provider}] Long rate limit (${retryAfter}s). Skipping to fallback.`));
               break;
            } else if (msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('limit exceeded') || msg.toLowerCase().includes('perday')) {
               console.warn(chalk.red(`  ✖ [${provider}] Quota exceeded for ${model}.`));
               modelRegistry.reportFailure(provider, model);
               break;
            }
            console.warn(chalk.yellow(`  ⚠ Rate limited. Retrying attempt ${attempts}/3 in 5s...`));
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          
          if (status === 400 || status === 401 || status === 403 || status === 404) {
             console.warn(chalk.red(`  ✖ [${provider}] Fatal error ${status}: ${msg}`));
             if (status === 400 && msg.includes('schema')) {
               if (metadata) metadata.status = 'unsupported';
             }
             break;
          }
          
          if (TRANSIENT_ERRORS.has(status)) {
             console.warn(chalk.yellow(`  ⚠ [${provider}] Server error ${status}. Retrying...`));
             await new Promise(r => setTimeout(r, 2000 * attempts));
             continue;
          }
          throw error;
        }
      }
    } catch (err: any) {
       errors.push(err);
    }
  }

  throw new Error(`All AI candidates failed. Errors:\n${errors.map(e => e.message).join('\n')}`);
}

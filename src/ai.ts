import OpenAI from "openai";
import chalk from "chalk";
import type { Settings, AiTaskType } from "./types.js";
import { getApiKeys, tryGetApiKeys } from "./config.js";

export interface AiConfig {
  provider: "gemini" | "openrouter";
  model: string;
}

export const RECOMMENDED_MODELS = {
  gemini: {
    extraction: "gemini-2.5-flash",
    scoring: "gemini-2.5-flash",
    form_filling: "gemini-2.5-flash",
  },
  openrouter: {
    extraction: "google/gemini-2.0-flash-exp:free",
    scoring: "meta-llama/llama-3.3-70b-instruct:free",
    form_filling: "meta-llama/llama-3.3-70b-instruct:free",
  },
} as const;

export interface TaskModelResolved {
  config: AiConfig;
  apiKeys: string[];
  fallbackConfig?: AiConfig;
  fallbackApiKeys?: string[];
}

/**
 * Resolves the correct provider + model + API keys for a given AI task.
 * Automatically checks key availability and sets up cross-provider fallback
 * if both Gemini and OpenRouter are configured.
 */
export function getModelForTask(settings: Settings, task: AiTaskType): TaskModelResolved {
  const taskModel = settings.ai?.models?.[task];
  let provider = taskModel?.provider || settings.ai?.provider || "gemini";
  let model = taskModel?.model || settings.ai?.model || (provider === "openrouter" ? RECOMMENDED_MODELS.openrouter[task] : RECOMMENDED_MODELS.gemini[task]);

  const geminiKeys = tryGetApiKeys("gemini");
  const openrouterKeys = tryGetApiKeys("openrouter");

  // If selected provider has no keys, check if alternate provider has keys
  if (provider === "gemini" && geminiKeys.length === 0 && openrouterKeys.length > 0) {
    console.log(chalk.cyan(`  ℹ [AI ADAPT] Gemini keys not configured. Automatically routing ${task} to OpenRouter.`));
    provider = "openrouter";
    model = RECOMMENDED_MODELS.openrouter[task];
  } else if (provider === "openrouter" && openrouterKeys.length === 0 && geminiKeys.length > 0) {
    console.log(chalk.cyan(`  ℹ [AI ADAPT] OpenRouter keys not configured. Automatically routing ${task} to Gemini.`));
    provider = "gemini";
    model = RECOMMENDED_MODELS.gemini[task];
  }

  const primaryKeys = provider === "gemini" ? geminiKeys : openrouterKeys;
  const alternateProvider: "gemini" | "openrouter" = provider === "gemini" ? "openrouter" : "gemini";
  const alternateKeys = alternateProvider === "gemini" ? geminiKeys : openrouterKeys;

  let fallbackConfig: AiConfig | undefined;
  let fallbackApiKeys: string[] | undefined;

  if (alternateKeys.length > 0) {
    fallbackConfig = {
      provider: alternateProvider,
      model: RECOMMENDED_MODELS[alternateProvider][task],
    };
    fallbackApiKeys = alternateKeys;
  }

  return {
    config: { provider, model },
    apiKeys: primaryKeys,
    fallbackConfig,
    fallbackApiKeys,
  };
}

// In-memory state to rotate keys if we hit a 429
const keyState = {
  gemini: 0,
  openrouter: 0,
};

// Transient HTTP status codes that should be retried with backoff
const TRANSIENT_ERRORS = new Set([500, 502, 503, 504]);

function getBaseUrl(provider: "gemini" | "openrouter"): string {
  if (provider === "gemini") {
    // Gemini OpenAI compatibility endpoint
    return "https://generativelanguage.googleapis.com/v1beta/openai/";
  }
  return "https://openrouter.ai/api/v1";
}

async function executeSingleProvider<T>(
  config: AiConfig,
  apiKeys: string[],
  action: (client: OpenAI) => Promise<T>
): Promise<T> {
  const MAX_TRANSIENT_RETRIES = 3;
  let keyRotations = 0;
  const maxKeyRotations = Math.max(apiKeys.length, 1);

  if (apiKeys.length === 0) {
    throw new Error(`No API keys configured for ${config.provider}.`);
  }

  while (keyRotations < maxKeyRotations) {
    const currentKeyIndex = keyState[config.provider] % apiKeys.length;
    const activeKey = apiKeys[currentKeyIndex];

    const client = new OpenAI({
      apiKey: activeKey,
      baseURL: getBaseUrl(config.provider),
    });

    for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
      try {
        return await action(client);
      } catch (error: any) {
        const status = error?.status;

        // 429 Too Many Requests / 402 Payment Required → rotate to next key
        if (status === 429 || status === 402) {
          console.warn(
            chalk.yellow(
              `\n⚠ [AI FAILOVER] Key ${currentKeyIndex + 1}/${maxKeyRotations} for ${config.provider} exhausted or rate-limited (${status}). Rotating...`
            )
          );
          keyState[config.provider] = (currentKeyIndex + 1) % apiKeys.length;
          keyRotations++;
          if (keyRotations >= maxKeyRotations) {
            throw new Error(`All ${maxKeyRotations} keys for ${config.provider} have hit rate limits or quota issues (${status}).`);
          }
          await new Promise((res) => setTimeout(res, 1000));
          break;
        }

        // Transient server errors (500, 502, 503, 504) → retry same key with exponential backoff
        if (TRANSIENT_ERRORS.has(status)) {
          if (retry < MAX_TRANSIENT_RETRIES) {
            const backoffMs = Math.min(2000 * Math.pow(2, retry), 15000);
            console.warn(
              chalk.yellow(
                `\n⚠ [AI RETRY] Server error ${status} from ${config.provider} (${config.model}). Retrying in ${(backoffMs / 1000).toFixed(0)}s (attempt ${retry + 1}/${MAX_TRANSIENT_RETRIES})...`
              )
            );
            await new Promise((res) => setTimeout(res, backoffMs));
            continue;
          }
          // Exhausted transient retries on this key, rotate if possible
          if (apiKeys.length > 1) {
            console.warn(
              chalk.yellow(
                `\n⚠ [AI FAILOVER] Transient retries exhausted on key ${currentKeyIndex + 1}. Rotating key...`
              )
            );
            keyState[config.provider] = (currentKeyIndex + 1) % apiKeys.length;
            keyRotations++;
            break;
          }
          throw error;
        }

        // Non-transient errors (400, 401, 404, etc.)
        throw error;
      }
    }
  }
  throw new Error(`Failed to execute AI request on ${config.provider} (${config.model}) after key rotation.`);
}

async function executeWithFailover<T>(
  config: AiConfig,
  apiKeys: string[],
  action: (client: OpenAI) => Promise<T>,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<T> {
  try {
    return await executeSingleProvider(config, apiKeys, action);
  } catch (primaryError: any) {
    if (fallbackConfig && fallbackApiKeys && fallbackApiKeys.length > 0) {
      console.warn(
        chalk.magenta.bold(
          `\n🔄 [CROSS-PROVIDER FAILOVER] Primary ${config.provider} (${config.model}) failed (${primaryError.message || primaryError}). Switching to fallback: ${fallbackConfig.provider} (${fallbackConfig.model})...`
        )
      );
      try {
        return await executeSingleProvider(fallbackConfig, fallbackApiKeys, action);
      } catch (fallbackError: any) {
        throw new Error(
          `Both primary (${config.provider}: ${primaryError.message}) and fallback (${fallbackConfig.provider}: ${fallbackError.message}) failed.`
        );
      }
    }
    throw primaryError;
  }
}

export async function generateTextResponse(
  config: AiConfig,
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<string> {
  return executeWithFailover(
    config,
    apiKeys,
    async (client) => {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
      });
      return response.choices[0]?.message?.content?.trim() || "";
    },
    fallbackConfig,
    fallbackApiKeys
  );
}

export async function generateStructuredResponse(
  config: AiConfig,
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<any> {
  return executeWithFailover(
    config,
    apiKeys,
    async (client) => {
      const augmentedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: You must return the output as a raw, valid JSON object. Do not wrap it in markdown code blocks.`;

      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: augmentedSystemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      
      const text = response.choices[0]?.message?.content || "{}";
      
      let cleanText = text.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/^```json\n/, "").replace(/\n```$/, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```\n/, "").replace(/\n```$/, "");
      }

      try {
        return JSON.parse(cleanText);
      } catch (e) {
        console.error(chalk.red("Failed to parse JSON response from model:"), cleanText);
        throw new Error("Model returned invalid JSON.");
      }
    },
    fallbackConfig,
    fallbackApiKeys
  );
}

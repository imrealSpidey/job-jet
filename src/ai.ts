import { executeTask, abortAiOperations, isAiAborted } from "./ai/router.js";
import type { Settings, AiTaskType } from "./types.js";
import { loadSettings } from "./config.js";

export interface AiConfig {
  provider: "gemini" | "openrouter";
  model: string;
}

export interface TaskModelResolved {
  config: AiConfig;
  apiKeys: string[];
  fallbackConfig?: AiConfig;
  fallbackApiKeys?: string[];
}

export { abortAiOperations, isAiAborted };

export async function generateTextResponse(
  configOrSettings: AiConfig | Settings,
  apiKeysOrTask: string[] | AiTaskType,
  systemPrompt: string,
  userPrompt: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<string> {
  let settings: Settings;
  let task: AiTaskType;
  if ('ai' in configOrSettings) {
    settings = configOrSettings as Settings;
    task = apiKeysOrTask as AiTaskType;
  } else {
    settings = loadSettings();
    // Guess task based on the system prompt or caller context, but default to extraction
    task = systemPrompt.includes('evaluate') ? 'scoring' : (systemPrompt.includes('cover note') ? 'form_filling' : 'extraction');
  }

  return executeTask(settings, task, async (client, model) => {
    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from AI");
    return content;
  });
}

export async function generateStructuredResponse(
  configOrSettings: AiConfig | Settings,
  apiKeysOrTask: string[] | AiTaskType,
  systemPrompt: string,
  userPrompt: string,
  fallbackConfig?: AiConfig,
  fallbackApiKeys?: string[]
): Promise<any> {
  let settings: Settings;
  let task: AiTaskType;
  if ('ai' in configOrSettings) {
    settings = configOrSettings as Settings;
    task = apiKeysOrTask as AiTaskType;
  } else {
    settings = loadSettings();
    task = systemPrompt.includes('strict hiring match evaluator') ? 'scoring' : 'extraction';
  }

  return executeTask(settings, task, async (client, model) => {
    const augmentedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: You must return the output as a raw, valid JSON object. Do not wrap it in markdown code blocks.`;

    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: augmentedSystemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from AI");

    try {
      return JSON.parse(content);
    } catch (e: any) {
      const match = content.match(/\{.*\}/s);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error("Failed to parse AI output as JSON");
    }
  });
}

export function getModelForTask(settings: Settings, task?: AiTaskType | string): TaskModelResolved {
  const modelConfig = task && (settings.ai?.models as any)?.[task] 
    ? (settings.ai.models as any)[task] 
    : { provider: "gemini", model: "gemini-3.1-flash-lite" };

  return {
    config: { provider: modelConfig.provider as any, model: modelConfig.model },
    apiKeys: ["dummy"],
    fallbackConfig: { provider: "openrouter", model: "openrouter/free" },
    fallbackApiKeys: ["dummy"]
  };
}

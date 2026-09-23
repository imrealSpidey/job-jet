import OpenAI from "openai";
import chalk from "chalk";

export interface AiConfig {
  provider: "gemini" | "openrouter";
  model: string;
}

// In-memory state to rotate keys if we hit a 429
const keyState = {
  gemini: 0,
  openrouter: 0,
};

function getBaseUrl(provider: "gemini" | "openrouter"): string {
  if (provider === "gemini") {
    // Gemini OpenAI compatibility endpoint
    return "https://generativelanguage.googleapis.com/v1beta/openai/";
  }
  return "https://openrouter.ai/api/v1";
}

async function executeWithFailover<T>(
  config: AiConfig,
  apiKeys: string[],
  action: (client: OpenAI) => Promise<T>
): Promise<T> {
  let attempts = 0;
  const maxAttempts = apiKeys.length;

  while (attempts < maxAttempts) {
    const currentKeyIndex = keyState[config.provider];
    const activeKey = apiKeys[currentKeyIndex];

    const client = new OpenAI({
      apiKey: activeKey,
      baseURL: getBaseUrl(config.provider),
    });

    try {
      return await action(client);
    } catch (error: any) {
      // 429 Too Many Requests / Quota Exceeded
      // 402 Payment Required
      if (error?.status === 429 || error?.status === 402) {
        console.warn(
          chalk.yellow(
            `\n⚠ [AI FAILOVER] Key ${currentKeyIndex + 1}/${maxAttempts} for ${config.provider} exhausted or rate-limited (${error.status}). Rotating...`
          )
        );
        // Rotate to the next key
        keyState[config.provider] = (currentKeyIndex + 1) % apiKeys.length;
        attempts++;
        // If we've looped through all keys, we break and throw
        if (attempts >= maxAttempts) {
          throw new Error(`All ${maxAttempts} keys for ${config.provider} have hit rate limits or quota issues.`);
        }
        // Small backoff before retry
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      
      // If it's another error (404, 500, etc), throw immediately
      throw error;
    }
  }
  throw new Error("Failed to execute AI request after key rotation.");
}

export async function generateTextResponse(
  config: AiConfig,
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  return executeWithFailover(config, apiKeys, async (client) => {
    const response = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
    });
    return response.choices[0]?.message?.content?.trim() || "";
  });
}

export async function generateStructuredResponse(
  config: AiConfig,
  apiKeys: string[],
  systemPrompt: string,
  userPrompt: string
): Promise<any> {
  return executeWithFailover(config, apiKeys, async (client) => {
    // OpenRouter and Gemini compatibility mode both highly respect JSON formatting 
    // when prompted, and standard 'json_object' response format is universally safer than 'json_schema' on some open models.
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
    
    // Attempt to strip markdown code blocks if the model ignored instructions
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
  });
}

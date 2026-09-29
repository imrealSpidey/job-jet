import { modelRegistry, ModelMetadata } from './registry.js';
import { getApiKeys, tryGetApiKeys } from '../config.js';

export async function discoverModels() {
  await modelRegistry.loadCache();
  
  const openRouterKeys = tryGetApiKeys('openrouter' as any);
  if (openRouterKeys && openRouterKeys.length > 0) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${openRouterKeys[0]}` }
      });
      if (res.ok) {
        const data = await res.json();
        for (const model of data.data) {
          modelRegistry.registerModel({
            provider: 'openrouter',
            model: model.id,
            reported: {
              id: model.id,
              name: model.name,
              context_length: model.context_length
            },
            verified: {
              supportsStructuredOutput: true,
              canFollowInstructions: true
            },
            status: 'available'
          });
        }
      }
    } catch (e) {
      console.warn("Failed to discover OpenRouter models:", e);
    }
  }

  const geminiKeys = tryGetApiKeys('gemini' as any);
  if (geminiKeys && geminiKeys.length > 0) {
    try {
      const defaultGemini = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
      for (const m of defaultGemini) {
        modelRegistry.registerModel({
          provider: 'gemini',
          model: m,
          reported: {
            id: m,
            name: m,
            context_length: 128000
          },
          verified: {
            supportsStructuredOutput: true,
            canFollowInstructions: true
          },
          status: 'available'
        });
      }
    } catch (e) {
      console.warn("Failed to discover Gemini models:", e);
    }
  }

  await modelRegistry.saveCache();
}

import fs from 'fs/promises';
import path from 'path';
import type { TaskModelConfig } from '../types.js';

export interface ProviderReportedCapability {
  id: string;
  name: string;
  context_length: number;
}

export interface JobJetVerifiedCapabilities {
  supportsStructuredOutput: boolean;
  canFollowInstructions: boolean;
}

export interface ModelMetadata {
  provider: string;
  model: string;
  reported: ProviderReportedCapability;
  verified: JobJetVerifiedCapabilities;
  status: 'available' | 'cooling_down' | 'unsupported';
  lastFailure?: number;
  lastSuccessfulUse?: number;
}

const CACHE_FILE = path.join(process.cwd(), 'data', 'model_cache.json');

export class ModelRegistry {
  private models: Map<string, ModelMetadata> = new Map();

  async loadCache() {
    try {
      const data = await fs.readFile(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          this.models.set(`${m.provider}:${m.model}`, m);
        }
      }
    } catch {
      // ignore
    }
  }

  async saveCache() {
    try {
      const arr = Array.from(this.models.values());
      await fs.writeFile(CACHE_FILE, JSON.stringify(arr, null, 2));
    } catch {
      // ignore
    }
  }

  registerModel(metadata: ModelMetadata) {
    this.models.set(`${metadata.provider}:${metadata.model}`, metadata);
  }

  getModel(provider: string, model: string): ModelMetadata | undefined {
    return this.models.get(`${provider}:${model}`);
  }

  getAllModels(): ModelMetadata[] {
    return Array.from(this.models.values());
  }

  reportFailure(provider: string, model: string) {
    const meta = this.getModel(provider, model);
    if (meta) {
      meta.status = 'cooling_down';
      meta.lastFailure = Date.now();
    }
  }

  reportSuccess(provider: string, model: string) {
    const meta = this.getModel(provider, model);
    if (meta) {
      meta.status = 'available';
      meta.lastSuccessfulUse = Date.now();
    }
  }
}

export const modelRegistry = new ModelRegistry();

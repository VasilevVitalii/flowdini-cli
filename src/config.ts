// Конфиг LLM-провайдеров (fd.providers.yaml) + маппинг model → провайдер.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface TFdProviderConfig {
  baseUrl: string;      // напр. https://api.deepseek.com/v1
  apiKeyEnv: string;    // имя переменной окружения с ключом
  models: string[];     // какие модели обслуживает провайдер
}

export interface TFdProvidersConfig {
  providers: Record<string, TFdProviderConfig>;
}

export interface TFdResolvedProvider {
  baseUrl: string;
  apiKey: string;
}

export function parseProvidersConfig(text: string): TFdProvidersConfig {
  const raw = parseYaml(text) as unknown;
  if (raw === null || raw === undefined) return { providers: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('providers: корень должен быть объектом (mapping)');
  }
  const obj = raw as Record<string, unknown>;
  const providers = obj.providers ?? {};
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    throw new Error('providers: поле providers должно быть объектом');
  }
  const cfg: TFdProvidersConfig = { providers: providers as Record<string, TFdProviderConfig> };
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new Error(`providers.${name}: провайдер должен быть объектом`);
    }
    if (typeof p.baseUrl !== 'string' || p.baseUrl === '') {
      throw new Error(`providers.${name}.baseUrl: обязателен`);
    }
    if (typeof p.apiKeyEnv !== 'string' || p.apiKeyEnv === '') {
      throw new Error(`providers.${name}.apiKeyEnv: обязателен`);
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      throw new Error(`providers.${name}.models: обязателен (непустой список моделей)`);
    }
    for (const m of p.models) {
      if (typeof m !== 'string' || m === '') {
        throw new Error(`providers.${name}.models: каждая модель должна быть непустой строкой`);
      }
    }
  }
  return cfg;
}

export function loadProvidersConfig(path: string): TFdProvidersConfig {
  return parseProvidersConfig(readFileSync(path, 'utf8'));
}

/** Найти провайдера по имени модели (`roles[].model`). null — модель не закреплена ни за одним провайдером. */
export function resolveProvider(cfg: TFdProvidersConfig, model: string): TFdResolvedProvider | null {
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.models.includes(model)) {
      const apiKey = process.env[p.apiKeyEnv];
      if (!apiKey) {
        throw new Error(`providers.${name}: переменная окружения ${p.apiKeyEnv} не задана`);
      }
      return { baseUrl: p.baseUrl.replace(/\/+$/, ''), apiKey };
    }
  }
  return null;
}

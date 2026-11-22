import { describe, it, expect, beforeEach } from 'vitest';
import { parseProvidersConfig, resolveProvider } from '../src/config.js';

describe('parseProvidersConfig', () => {
  it('парсит валидный конфиг', () => {
    const cfg = parseProvidersConfig(
      'providers:\n  deepseek:\n    baseUrl: https://api.deepseek.com/v1\n    apiKeyEnv: DEEPSEEK_API_KEY\n    models: [deepseek-v4-pro]\n',
    );
    expect(cfg.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg.providers.deepseek.models).toEqual(['deepseek-v4-pro']);
  });

  it('пустой текст → пустые провайдеры', () => {
    expect(parseProvidersConfig('').providers).toEqual({});
  });

  it('без baseUrl → ошибка', () => {
    expect(() =>
      parseProvidersConfig('providers:\n  x:\n    apiKeyEnv: K\n    models: [m]\n'),
    ).toThrow(/baseUrl/);
  });

  it('пустой models → ошибка', () => {
    expect(() =>
      parseProvidersConfig('providers:\n  x:\n    baseUrl: u\n    apiKeyEnv: K\n    models: []\n'),
    ).toThrow(/models/);
  });

  it('корень не объект → ошибка', () => {
    expect(() => parseProvidersConfig('- a\n')).toThrow(/корень/);
  });
});

describe('resolveProvider', () => {
  beforeEach(() => {
    process.env.TEST_KEY = 'secret';
    delete process.env.MISSING_KEY;
  });

  it('находит провайдера по модели и обрезает трейлинг-слеш baseUrl', () => {
    const cfg = parseProvidersConfig(
      'providers:\n  p:\n    baseUrl: https://x/v1/\n    apiKeyEnv: TEST_KEY\n    models: [m1]\n',
    );
    expect(resolveProvider(cfg, 'm1')).toEqual({ baseUrl: 'https://x/v1', apiKey: 'secret' });
  });

  it('модель не закреплена → null', () => {
    const cfg = parseProvidersConfig(
      'providers:\n  p:\n    baseUrl: https://x\n    apiKeyEnv: TEST_KEY\n    models: [m1]\n',
    );
    expect(resolveProvider(cfg, 'm2')).toBeNull();
  });

  it('переменная ключа не задана → ошибка', () => {
    const cfg = parseProvidersConfig(
      'providers:\n  p:\n    baseUrl: https://x\n    apiKeyEnv: MISSING_KEY\n    models: [m1]\n',
    );
    expect(() => resolveProvider(cfg, 'm1')).toThrow(/MISSING_KEY/);
  });
});

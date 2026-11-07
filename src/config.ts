import {resolve} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import type {AppConfig} from './types.js';

export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret.length >= 4) message = message.split(secret).join('[скрыто]');
  return safeText(message).slice(0, 1000);
}

export function normalizeNumber(input: string): string {
  if (!/^[+\d\s().-]+$/.test(input)) throw new Error('Номер должен содержать только цифры, + и разделители.');
  let number = input.replace(/[\s().-]/g, '');
  if (/^8\d{10}$/.test(number)) number = '+7' + number.slice(1);
  if (/^7\d{10}$/.test(number)) number = '+' + number;
  if (!/^\+7\d{10}$/.test(number)) throw new Error('Введите российский номер: +7 и ещё 10 цифр.');
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = env.PHONE_MODE ?? 'demo';
  if (mode !== 'demo' && mode !== 'live') throw new Error('PHONE_MODE: допустимы demo или live.');
  const maxCallSeconds = Number(env.MAX_CALL_SECONDS ?? 600);
  if (!Number.isInteger(maxCallSeconds) || maxCallSeconds < 10 || maxCallSeconds > 3600) throw new Error('MAX_CALL_SECONDS: целое число от 10 до 3600.');
  const ariUrl = env.ASTERISK_ARI_URL || 'http://127.0.0.1:8088';
  const parsed = new URL(ariUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('ASTERISK_ARI_URL: нужен HTTP(S) адрес без пароля и параметров.');
  const webSearch = env.OPENAI_WEB_SEARCH ?? 'true';
  if (!['true','false'].includes(webSearch)) throw new Error('OPENAI_WEB_SEARCH: true или false.');
  const talkingThreshold=Number(env.ASTERISK_TALKING_THRESHOLD??256),talkingSilenceMs=Number(env.ASTERISK_TALKING_SILENCE_MS??250);
  if(!Number.isInteger(talkingThreshold)||talkingThreshold<1||talkingThreshold>32768)throw new Error('ASTERISK_TALKING_THRESHOLD: целое число от 1 до 32768.');
  if(!Number.isInteger(talkingSilenceMs)||talkingSilenceMs<100||talkingSilenceMs>2500)throw new Error('ASTERISK_TALKING_SILENCE_MS: целое число от 100 до 2500.');
  return {
    mode, apiKey: env.OPENAI_API_KEY?.trim() || '',
    liveModel: env.OPENAI_LIVE_MODEL || 'gpt-live-1',
    backendModel: env.OPENAI_BACKEND_MODEL || 'gpt-6-luna',
    voice: env.OPENAI_VOICE || 'marin', webSearch: webSearch === 'true',
    plusofonToken:env.PLUSOFON_API_TOKEN?.trim()||'',
    gateway: {
      ariUrl: parsed.toString().replace(/\/$/, ''),
      ariUsername: env.ASTERISK_ARI_USERNAME || 'phone',
      ariPassword: env.ASTERISK_ARI_PASSWORD || '',
      app: env.ASTERISK_APP || 'gpt-live-phone', trunk: env.ASTERISK_TRUNK || 'plusofon',
      callerNumber: env.PLUSOFON_CALLER_NUMBER?.trim() || '',
      talkingThreshold,talkingSilenceMs,
    },
    maxCallSeconds,
    allowedNumbers: (env.ALLOWED_NUMBERS || '').split(',').filter(s=>s.trim()).map(normalizeNumber),
    callsDir: resolve(env.CALLS_DIR || './calls'),
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || '',
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || '',
  };
}

export function liveIssues(config: AppConfig): string[] {
  const issues: string[] = [];
  if (!config.apiKey) issues.push('Заполните OPENAI_API_KEY в .env.');
  if (!config.gateway.ariPassword) issues.push('Заполните ASTERISK_ARI_PASSWORD в .env.');
  try { normalizeNumber(config.gateway.callerNumber); } catch { issues.push('Заполните PLUSOFON_CALLER_NUMBER: активный номер +7.'); }
  if (!/^[\w-]+$/.test(config.gateway.app) || !/^[\w-]+$/.test(config.gateway.trunk)) issues.push('Имена ASTERISK_APP и ASTERISK_TRUNK должны содержать буквы, цифры, _ или -.');
  return issues;
}

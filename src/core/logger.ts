// src/core/logger.ts
import winston from 'winston';
import { config } from '../config';

const SENSITIVE_KEYS = new Set([
  'bottoken',
  'encryptionkey',
  'sessionid',
  'clientid',
  'pairingcode',
  'privatekey',
  'seedphrase',
  'cookie',
  'authorization',
]);

const BOT_TOKEN_PATTERN = /\b\d{7,}:[A-Za-z0-9_-]{30,}\b/g;

function scrubSecretStrings(str: string): string {
  return str.replace(BOT_TOKEN_PATTERN, '[REDACTED_BOT_TOKEN]');
}

function redactValue(val: unknown, depth = 0): unknown {
  if (depth > 5 || val === null || val === undefined) return val;
  if (typeof val === 'string') return scrubSecretStrings(val);
  if (typeof val !== 'object') return val;
  if (val instanceof Error) {
    return {
      name: val.name,
      message: scrubSecretStrings(val.message),
    };
  }
  if (Array.isArray(val)) return val.map((v) => redactValue(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactValue(v, depth + 1);
  }
  return out;
}

// Preserve Winston internal Symbols (LEVEL, MESSAGE, SPLAT) by mutating string keys in place
const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = scrubSecretStrings(info.message);
  }
  for (const k of Object.keys(info)) {
    if (k === 'level' || k === 'message' || k === 'timestamp') continue;
    info[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactValue(info[k]);
  }
  return info;
});

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

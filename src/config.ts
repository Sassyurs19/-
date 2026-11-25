// src/config.ts
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key]?.trim();
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function parsePositiveInt(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer for environment variable ${key}: ${raw}`);
  }
  return n;
}

function requireValidEncryptionKey(): string {
  const hex = requireEnv('ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  if (/^0{64}$/.test(hex) && process.env.NODE_ENV !== 'test') {
    throw new Error('ENCRYPTION_KEY cannot be the default all-zero placeholder from .env.example');
  }
  return hex;
}

function requireHttpsUrl(raw: string, key: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${key}: ${raw}`);
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(isLocal && process.env.NODE_ENV !== 'production')) {
    throw new Error(`${key} must use HTTPS: ${raw}`);
  }
  return raw;
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  adminId: parsePositiveInt(requireEnv('ADMIN_ID'), 'ADMIN_ID'),
  adminRef: requireEnv('ADMIN_REF'),
  encryptionKey: requireValidEncryptionKey(),

  jagerApiBase: requireHttpsUrl(process.env.JAGER_API_BASE ?? 'https://jager.live/api', 'JAGER_API_BASE'),
  bscRpcUrl: requireHttpsUrl(process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com', 'BSC_RPC_URL'),
  bscFallbackRpcs: [
    process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com',
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed1.binance.org',
    'https://bsc.drpc.org',
  ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i),
  dbPath: path.resolve(process.env.DB_PATH ?? './data/jagent.db'),
  sessionsDir: path.resolve(process.env.SESSIONS_DIR ?? './sessions'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  apiMaxRetries: parseInt(process.env.API_MAX_RETRIES ?? '3', 10),
  jagerRateLimitRpm: parseInt(process.env.JAGER_RATE_LIMIT_RPM ?? '30', 10),
  nodeEnv: process.env.NODE_ENV ?? 'production',
  botTimezone: process.env.BOT_TIMEZONE ?? 'Asia/Kolkata',
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES ?? '20', 10),
  port: parseInt(process.env.PORT ?? '0', 10),

  // Contract addresses (BSC)
  MINT_CONTRACT: '0x3643A907f875fA9B740e1C0747E91b5aA5222aB8',
  JAGENT_TOKEN: '0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15',
  USDT_BSC: '0x55d398326f99059fF775485246999027B3197955',
  BNB_NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  BSC_CHAIN_ID: 56,
  BINANCE_CHAIN_ID: '56',

  // Limits & versions
  MIN_BNB_GAS: 0.0005,
  SLIPPAGE_BUFFER_MULTIPLIER: 1.02,
  SELL_MAX_SLIPPAGE_PCT: '5',
  BAW_REQUIRED_VERSION: '1.12.0',
} as const;

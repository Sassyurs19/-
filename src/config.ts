// src/config.ts
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  adminId: parseInt(requireEnv('ADMIN_ID'), 10),
  adminRef: requireEnv('ADMIN_REF'),
  encryptionKey: requireEnv('ENCRYPTION_KEY'),

  jagerApiBase: process.env.JAGER_API_BASE ?? 'https://jager.live/api',
  bscRpcUrl: process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com',
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

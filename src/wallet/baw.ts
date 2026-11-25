// src/wallet/baw.ts
// BAW CLI v1.12.0 wrapper with per-wallet isolated session directories,
// keytar bypass (so OS keychain never leaks/shares sessions), per-dir mutex,
// and encryption at rest.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../config';
import { decryptDir, encryptDir, wipeDir } from '../core/crypto';
import { WalletError } from '../core/errors';
import { logger } from '../core/logger';

// ---- Types matching baw CLI v1.12.0 JSON output ----

export interface BawSigninResult {
  urlForWeb: string;
  qrCodeId: string;
  expireAt: string;
  pairingCode: string;
}

export interface BawVerifyResult {
  status: 'SUCCESS' | string;
}

export interface BawWalletStatus {
  status: 'CONNECTED' | 'UNCONNECTED' | 'CREATING';
}

export interface BawWalletAddress {
  binanceChainId: string;
  chainName: string;
  address: string;
}

export interface BawAgentIdResult {
  claimed: boolean;
  handle?: string;
  agentId?: string;
}

export interface BawWalletSettings {
  maxSigninDuration?: string;
  inactiveSignoutDuration?: string;
  dailyLimit: number;
  quotaUsed?: number;
  quotaLeft: number;
  sessionExpireTime: string | null;
  devMode: {
    enabled: boolean;
    expiresAt: string | number | null;
    dailyLimit: number;
    balanceExceeded: boolean;
  } | null;
}

export interface BawBalance {
  symbol: string;
  address: string;
  binanceChainId: string;
  balance: string;
  price: string;
  value: string;
}

export interface BawTxHistoryResponse {
  transactions: Array<{
    txType: string;
    txHash: string;
    txTime: string | null;
    binanceChainId: string;
    status: string;
  }>;
  hasMore: boolean;
  nextCursor?: string;
}

export interface BawTxStatusResult {
  binanceChainId: string;
  txHash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  txTime: string | null;
}

export interface BawGasPriceLevel {
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  waitTimeEstimate?: number;
}

export interface BawGasPrice {
  baseFeePerGas?: string;
  low: BawGasPriceLevel;
  medium: BawGasPriceLevel;
  high: BawGasPriceLevel;
}

export interface BawContractCallPreview {
  requestId: string;
  parsedTx: Record<string, unknown>;
  simulationResult: {
    simulationCode: string;
    simulationErrorDetail: string | null;
    gasTokenFromData?: number;
    balanceChanges?: unknown[];
    allowanceChanges?: unknown[];
    authorityChanges?: unknown[];
  };
  risks: {
    riskDetails: Array<{ code?: string; title: string; description: string; riskType: string }>;
    addresses: Record<string, { riskLevel: number; riskDetails: Array<{ title: string; description: string }> }>;
  };
  requireConfirmation: boolean;
  expiresAt: number;
}

export interface BawContractCallExecute {
  orderId: string;
  status: 'BROADCASTED' | 'PENDING_CONFIRMATION';
  txHash: string | null;
  message: string | null;
}

export interface BawMarketQuote {
  fromCoinSymbol: string;
  fromCoinAmount: string;
  toCoinSymbol: string;
  toCoinAmount: string;
  slippage: number;
}

export interface BawMarketSwapSubmit {
  orderId: string;
  clientOrderId?: string;
}

export interface BawMarketOrderRecord {
  orderType: string;
  orderId: string;
  chain: string;
  fromToken: string;
  fromTokenName: string;
  fromTokenQty: string;
  toToken: string;
  toTokenName: string;
  toTokenActualQty?: string;
  status: 'PENDING' | 'FINISHED' | 'FAILED';
  slippage?: string;
  txHash?: string | null;
  bookTime?: string | null;
  updatedTime?: string | null;
  refund?: Array<{ tokenAddress: string; amount: string; symbol: string }>;
}

export interface BawMarketOrderList {
  total: number;
  page: number;
  pageSize: number;
  list: BawMarketOrderRecord[];
}

export interface BawErrorInfo {
  code: number;
  name: string;
  message: string;
  data?: Record<string, unknown>;
}

export type BawResult<T> =
  | { success: true; data: T }
  | { success: false; error: BawErrorInfo };

// ---- Per-directory mutex & isolation helpers ----

const dirLocks = new Map<string, Promise<void>>();

export async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const prev = dirLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((res) => {
    release = res;
  });
  dirLocks.set(key, prev.then(() => current, () => current));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (dirLocks.get(key) === current) {
      dirLocks.delete(key);
    }
  }
}

function getBawEntryPath(): string {
  return require.resolve('@binance/agentic-wallet/dist/index.js');
}

function ensureNoKeytarHook(): string {
  if (!fs.existsSync(config.sessionsDir)) {
    fs.mkdirSync(config.sessionsDir, { recursive: true });
  }
  const hookPath = path.join(config.sessionsDir, '.baw_no_keytar.mjs');
  const hookSource = `import { registerHooks } from 'node:module';
try {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@github/keytar') {
        return { url: 'data:text/javascript,export default undefined;', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
} catch {
  // Ignore if unsupported
}
`;
  if (!fs.existsSync(hookPath) || fs.readFileSync(hookPath, 'utf8') !== hookSource) {
    fs.writeFileSync(hookPath, hookSource, 'utf8');
  }
  return hookPath;
}

/**
 * Derive a deterministic per-Telegram-user instance ID so tempDir -> finalDir
 * renames keep decryptable baw session files while isolating per user.
 */
function deriveInstanceId(sessionDir: string): string {
  const base = path.basename(sessionDir);
  const ownerPrefix = base.split('_')[0] || base;
  return crypto
    .createHmac('sha256', config.encryptionKey)
    .update(`baw-instance:${ownerPrefix}`)
    .digest('hex');
}

/** Derive a deterministic isolated session dir for a wallet */
export function getSessionDir(telegramId: number, addressOrTag: string): string {
  const clean = addressOrTag.startsWith('new_')
    ? addressOrTag.replace(/[^a-zA-Z0-9_]/g, '')
    : addressOrTag.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16);
  return path.join(config.sessionsDir, `${telegramId}_${clean}`);
}

/** Safely move temp session dir into final wallet session dir under lock */
export async function promoteSessionDir(fromDir: string, toDir: string): Promise<void> {
  if (path.resolve(fromDir) === path.resolve(toDir)) return;
  await withDirLock(fromDir, async () => {
    await withDirLock(toDir, async () => {
      if (fs.existsSync(toDir)) {
        wipeDir(toDir);
      }
      fs.renameSync(fromDir, toDir);
    });
  });
}

function redactArgs(args: string[]): string[] {
  const SENSITIVE_FLAGS = new Set(['--qrCodeId', '--requestId']);
  return args.map((arg, idx) => {
    if (idx > 0 && SENSITIVE_FLAGS.has(args[idx - 1])) return '***';
    return arg;
  });
}

/**
 * Execute baw CLI command with --json inside an isolated BINANCE_BAW_DIR.
 * Decrypts sessionDir before running and re-encrypts afterwards under a per-dir lock.
 */
export async function runBaw<T>(
  args: string[],
  sessionDir?: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<BawResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const execCore = async (): Promise<BawResult<T>> => {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (sessionDir) {
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      } else {
        decryptDir(sessionDir);
      }
      env.BINANCE_BAW_DIR = sessionDir;
      env.BINANCE_INSTANCE_ID = deriveInstanceId(sessionDir);
    }

    const hookPath = ensureNoKeytarHook();
    const bawEntry = getBawEntryPath();
    const nodeArgs = ['--import', pathToFileURL(hookPath).href, bawEntry, ...args, '--json'];

    logger.debug('Running baw', { args: redactArgs(args) });

    try {
      const { stdout, stderr, exitCode, aborted } = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        aborted: boolean;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, nodeArgs, {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';
        let finished = false;
        let isAborted = false;

        const cleanup = () => {
          clearTimeout(timer);
          if (opts.signal) {
            opts.signal.removeEventListener('abort', onAbort);
          }
        };

        const onAbort = () => {
          if (finished) return;
          isAborted = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        };

        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort();
          } else {
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        const timer = setTimeout(() => {
          if (finished) return;
          isAborted = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          if (out.length < 10 * 1024 * 1024) out += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (err.length < 1024 * 1024) err += chunk.toString('utf8');
        });
        child.on('error', (spawnErr) => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(spawnErr);
        });
        child.on('close', (code) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ stdout: out, stderr: err, exitCode: code, aborted: isAborted });
        });
      });

      if (aborted) {
        throw new WalletError(opts.signal?.aborted ? 'Operation cancelled by user' : 'baw command timed out');
      }

      if (stderr && !stderr.includes('ExperimentalWarning')) {
        logger.warn('baw stderr', { stderr: stderr.slice(0, 500) });
      }

      const raw = stdout.trim();
      if (!raw) {
        throw new WalletError(`baw exited with code ${exitCode} and empty output`);
      }

      return JSON.parse(raw) as BawResult<T>;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        throw new WalletError('baw returned non-JSON output');
      }
      throw err;
    } finally {
      if (sessionDir && fs.existsSync(sessionDir)) {
        encryptDir(sessionDir);
      }
    }
  };

  if (sessionDir) {
    return withDirLock(sessionDir, execCore);
  }
  return execCore();
}

// ---- Auth commands ----

export async function bawSignin(sessionDir: string): Promise<BawResult<BawSigninResult | { status: string }>> {
  return runBaw<BawSigninResult | { status: string }>(['auth', 'signin'], sessionDir, { timeoutMs: 30_000 });
}

export async function bawVerify(
  qrCodeId: string,
  sessionDir: string,
  signal?: AbortSignal
): Promise<BawResult<BawVerifyResult>> {
  return runBaw<BawVerifyResult>(['auth', 'verify', '--qrCodeId', qrCodeId], sessionDir, {
    timeoutMs: 360_000, // ~6 min
    signal,
  });
}

export async function bawSignout(sessionDir: string): Promise<BawResult<{ status: string }>> {
  return runBaw<{ status: string }>(['auth', 'signout'], sessionDir, { timeoutMs: 20_000 });
}

// ---- Wallet commands ----

export async function bawStatus(sessionDir: string): Promise<BawResult<BawWalletStatus>> {
  return runBaw<BawWalletStatus>(['wallet', 'status'], sessionDir, { timeoutMs: 20_000 });
}

export async function bawAddress(sessionDir: string): Promise<BawResult<{ addresses: BawWalletAddress[] }>> {
  return runBaw<{ addresses: BawWalletAddress[] }>(['wallet', 'address'], sessionDir, { timeoutMs: 20_000 });
}

export async function bawAgentId(sessionDir: string): Promise<BawResult<BawAgentIdResult>> {
  return runBaw<BawAgentIdResult>(['wallet', 'agent-id'], sessionDir, { timeoutMs: 20_000 });
}

export async function bawSettings(sessionDir: string): Promise<BawResult<BawWalletSettings>> {
  return runBaw<BawWalletSettings>(['wallet', 'settings'], sessionDir, { timeoutMs: 20_000 });
}

export async function bawTxLock(sessionDir: string, binanceChainId: string = config.BINANCE_CHAIN_ID): Promise<BawResult<{ status: 'LOCKED' | 'UNLOCKED' }>> {
  return runBaw<{ status: 'LOCKED' | 'UNLOCKED' }>(
    ['wallet', 'tx-lock', '--binanceChainId', binanceChainId],
    sessionDir,
    { timeoutMs: 20_000 }
  );
}

export async function bawGasPrice(sessionDir: string, binanceChainId: string = config.BINANCE_CHAIN_ID): Promise<BawResult<BawGasPrice>> {
  return runBaw<BawGasPrice>(
    ['wallet', 'gas-price', '--binanceChainId', binanceChainId],
    sessionDir,
    { timeoutMs: 20_000 }
  );
}

export async function bawTxHistory(
  sessionDir: string,
  opts: { type?: 'all' | 'pending' | 'confirmed'; size?: number; tx?: string; binanceChainId?: string } = {}
): Promise<BawResult<BawTxHistoryResponse | BawTxStatusResult | null>> {
  const args = ['wallet', 'tx-history'];
  if (opts.type) args.push('--type', opts.type);
  if (opts.size) args.push('--size', String(opts.size));
  if (opts.tx) args.push('--tx', opts.tx);
  if (opts.binanceChainId) args.push('--binanceChainId', opts.binanceChainId);
  return runBaw(args, sessionDir, { timeoutMs: 30_000 });
}

export async function bawBalance(
  sessionDir: string,
  opts: { symbol?: string; tokenAddress?: string; binanceChainId?: string; hideLowValue?: boolean } = {}
): Promise<BawResult<BawBalance[]>> {
  const args = ['wallet', 'balance'];
  if (opts.symbol) args.push('--symbol', opts.symbol);
  if (opts.tokenAddress) args.push('--tokenAddress', opts.tokenAddress);
  if (opts.binanceChainId) args.push('--binanceChainId', opts.binanceChainId);
  args.push('--hideLowValue', String(opts.hideLowValue ?? false));
  return runBaw<BawBalance[]>(args, sessionDir, { timeoutMs: 30_000 });
}

// ---- Contract call ----

export async function bawContractCallPreview(
  sessionDir: string,
  params: {
    from: string;
    to: string;
    value?: string;
    inputData?: string;
    gasLimit?: number;
  }
): Promise<BawResult<BawContractCallPreview>> {
  const args = [
    'contract-call', 'preview',
    '--binanceChainId', config.BINANCE_CHAIN_ID,
    '--from', params.from,
    '--to', params.to,
    '--value', params.value ?? '0',
  ];
  if (params.inputData) args.push('--inputData', params.inputData);
  if (params.gasLimit !== undefined && params.gasLimit >= 21000 && params.gasLimit <= 15_000_000) {
    args.push('--gasLimit', String(Math.floor(params.gasLimit)));
  }
  return runBaw<BawContractCallPreview>(args, sessionDir, { timeoutMs: 60_000 });
}

export async function bawContractCallExecute(
  sessionDir: string,
  requestId: string
): Promise<BawResult<BawContractCallExecute>> {
  return runBaw<BawContractCallExecute>(
    ['contract-call', 'execute', '--requestId', requestId],
    sessionDir,
    { timeoutMs: 90_000 }
  );
}

// ---- Market order (for sell) ----

export async function bawMarketQuote(
  sessionDir: string,
  params: {
    fromToken: string;
    toToken: string;
    fromTokenQty: string;
    slippage?: string;
    binanceChainId?: string;
  }
): Promise<BawResult<BawMarketQuote>> {
  const args = [
    'market-order', 'quote',
    '--fromTokenQty', params.fromTokenQty,
    '--fromToken', params.fromToken,
    '--toToken', params.toToken,
    '--binanceChainId', params.binanceChainId ?? config.BINANCE_CHAIN_ID,
  ];
  if (params.slippage) args.push('--slippage', params.slippage);
  return runBaw<BawMarketQuote>(args, sessionDir, { timeoutMs: 30_000 });
}

export async function bawMarketSwap(
  sessionDir: string,
  params: {
    fromToken: string;
    toToken: string;
    fromTokenQty: string;
    slippage?: string;
    binanceChainId?: string;
  }
): Promise<BawResult<BawMarketSwapSubmit>> {
  const args = [
    'market-order', 'swap',
    '--fromTokenQty', params.fromTokenQty,
    '--fromToken', params.fromToken,
    '--toToken', params.toToken,
    '--slippage', params.slippage ?? config.SELL_MAX_SLIPPAGE_PCT,
    '--binanceChainId', params.binanceChainId ?? config.BINANCE_CHAIN_ID,
  ];
  return runBaw<BawMarketSwapSubmit>(args, sessionDir, { timeoutMs: 60_000 });
}

export async function bawMarketOrderList(
  sessionDir: string,
  params: { orderId?: string; status?: 'PENDING' | 'FINISHED' | 'FAILED'; binanceChainId?: string } = {}
): Promise<BawResult<BawMarketOrderList>> {
  const args = ['market-order', 'list'];
  if (params.orderId) args.push('--orderId', params.orderId);
  if (params.status) args.push('--status', params.status);
  if (params.binanceChainId) args.push('--binanceChainId', params.binanceChainId);
  return runBaw<BawMarketOrderList>(args, sessionDir, { timeoutMs: 30_000 });
}

// ---- Skill / CLI version check ----

export async function bawCliCheck(requiredVersion: string): Promise<BawResult<{ currentCliVersion: string; needUpdateCli: boolean }>> {
  return runBaw<{ currentCliVersion: string; needUpdateCli: boolean }>(
    ['cli-check', '--required-version', requiredVersion]
  );
}

/** Convenience logout + wipe for a session dir */
export async function logoutAndWipeSession(sessionDir: string): Promise<void> {
  if (!sessionDir || !fs.existsSync(sessionDir)) return;
  try {
    await bawSignout(sessionDir);
  } catch (err) {
    logger.warn('baw signout error during cleanup (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    wipeDir(sessionDir);
  }
}

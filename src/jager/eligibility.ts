// src/jager/eligibility.ts
// Runs all 6 eligibility checks for a wallet and exports pure validation helpers for testing.
import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../core/logger';
import { EligibilityCheck } from '../core/errors';
import { brandHeader, esc } from '../i18n';
import { getAgentStatus, getJagerStats } from './api';
import { withBscRpc } from './rpc';
import {
  bawAgentId,
  bawBalance,
  bawSettings,
  bawStatus,
  bawTxHistory,
  BawBalance,
  BawTxHistoryResponse,
  BawWalletSettings,
} from '../wallet/baw';

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
// Mint contract event emitted per mint: Mint(address indexed minter, bytes32 indexed refHash, uint256 index, uint256 shares, uint256 costUsdt)
const MINT_EVENT_TOPIC = '0x19f5f791ee407773427bf7b970bbbc3375065c32edd1ab142e23a84f94b0719b';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EligibilityResult {
  checks: EligibilityCheck[];
  allPassed: boolean;
  alreadyMinted: boolean;
  canMintViaUsdt: boolean;
  canMintViaBnb: boolean;
  sessionConnected: boolean;
  agentId: string | null;
  priceUsdtPerShare: string;
  sharesPerMint: number;
  quotaRemaining: number;
  usdtBalance: string;
  bnbBalance: string;
  jagentBalance: string;
  bnbRequiredForMint: string | null;
  devModeExpiry: number | null;
  inviteStats: {
    invited: number;
    reachedTenShares: number;
    pendingUsdt: string;
    paidUsdt: string;
  };
  prevMint: {
    minted: boolean;
    shares: number;
    date: string | null;
    txHashes: string[];
    referrer: string | null;
    onChain: boolean;
  };
}

// ---- Pure exported logic (used by unit tests directly) ----

export function checkAgentId(agentId: string | null | undefined): boolean {
  return Boolean(agentId && agentId.trim().length > 0);
}

export function checkNotAlreadyMinted(apiMintedCount: number, onChainFound: boolean): boolean {
  return (!Number.isFinite(apiMintedCount) || apiMintedCount <= 0) && !onChainFound;
}

/**
 * Parse baw devMode.expiresAt which may be an ISO 8601 string,
 * Unix seconds, Unix milliseconds, or null/undefined. Returns Unix seconds or null.
 */
export function parseDevModeExpiry(expiresAt: string | number | null | undefined): number | null {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return null;
  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : Math.floor(expiresAt);
  }
  const trimmed = expiresAt.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

export function checkDevMode(
  enabled: boolean,
  expiresAt: string | number | null | undefined,
  nowEpochSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!enabled) return false;
  const expirySec = parseDevModeExpiry(expiresAt);
  if (expirySec === null) return true;
  return expirySec > nowEpochSec;
}

export function checkQuota(remaining: number, minSharesRequired = 1): boolean {
  return Number.isFinite(remaining) && remaining >= minSharesRequired && remaining > 0;
}

export function calcUsdtNeeded(pricePerShare: string | number, shares: number): string {
  const p = typeof pricePerShare === 'number' ? pricePerShare : parseFloat(pricePerShare);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(shares) || shares <= 0) {
    return '0.0000';
  }
  return (p * shares * config.SLIPPAGE_BUFFER_MULTIPLIER).toFixed(4);
}

export function checkUsdtSufficient(
  balance: string,
  pricePerShare: string | number,
  shares: number
): boolean {
  const bal = parseFloat(balance);
  const p = typeof pricePerShare === 'number' ? pricePerShare : parseFloat(pricePerShare);
  if (!Number.isFinite(bal) || !Number.isFinite(p) || p <= 0 || shares <= 0) return false;
  const needed = p * shares * config.SLIPPAGE_BUFFER_MULTIPLIER;
  return bal >= needed;
}

export function checkBnbGas(balance: string): boolean {
  const bnb = parseFloat(balance);
  return Number.isFinite(bnb) && bnb >= config.MIN_BNB_GAS;
}

export function formatTimestampInTz(epochMsOrSec: number, isSeconds = true): string {
  const ms = isSeconds ? epochMsOrSec * 1000 : epochMsOrSec;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: config.botTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Compact single-line date for mobile cards, e.g. "25 Nov · 09:33" */
export function formatShortTimestamp(epochMsOrSec: number, isSeconds = true): string {
  const ms = isSeconds ? epochMsOrSec * 1000 : epochMsOrSec;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: config.botTimezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

/** Compact time only, e.g. "09:33:18" */
export function formatClockInTz(epochMsOrSec: number, isSeconds = false): string {
  const ms = isSeconds ? epochMsOrSec * 1000 : epochMsOrSec;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: config.botTimezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

/**
 * Decode known mint contract calldata to extract shares & referrer address if present.
 */
export function decodeMintCalldata(data: string): {
  method: 'mintWithUSDT' | 'mintWithBNB' | 'unknown';
  shares?: number;
  referrer?: string;
} {
  if (!data || !data.startsWith('0x') || data.length < 10) {
    return { method: 'unknown' };
  }
  const selector = data.slice(0, 10).toLowerCase();
  const payload = '0x' + data.slice(10);
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    if (selector === '0x836a1040' && data.length >= 10 + 192) {
      const [shares, referrer] = coder.decode(['uint256', 'address', 'uint256'], payload);
      const refStr = String(referrer);
      return {
        method: 'mintWithUSDT',
        shares: Number(shares),
        referrer: refStr.toLowerCase() !== ZERO_ADDRESS ? refStr : undefined,
      };
    }
    if (selector === '0xe38fd349' && data.length >= 10 + 128) {
      const [shares, referrer] = coder.decode(['uint256', 'address'], payload);
      const refStr = String(referrer);
      return {
        method: 'mintWithBNB',
        shares: Number(shares),
        referrer: refStr.toLowerCase() !== ZERO_ADDRESS ? refStr : undefined,
      };
    }
  } catch {
    // fallback below
  }
  return { method: 'unknown' };
}

export interface OnChainMintScan {
  found: boolean;
  txHashes: string[];
  totalShares: number;
  lastMintDate: string | null;
  referrer: string | null;
}

/**
 * Scan on-chain mint events on both MINT_CONTRACT (custom Mint log) and
 * JAGENT_TOKEN (Transfer from 0x0 -> wallet) over bounded recent block chunks,
 * plus Binance tx-history when sessionDir is active so older mints are also found.
 */
export async function scanOnChainMints(
  address: string,
  sessionDir?: string
): Promise<OnChainMintScan> {
  const txHashSet = new Set<string>();
  const paddedWallet = ethers.zeroPadValue(address.toLowerCase(), 32);

  // 1. Bounded recent RPC scan across MINT_CONTRACT and JAGENT_TOKEN
  try {
    await withBscRpc(async (provider) => {
      const head = await provider.getBlockNumber();
      // Scan recent ~40,000 blocks (~33 hours) in 1 query; safe on public BSC RPCs
      const fromBlock = Math.max(0, head - 40_000);
      const [mintLogs, tokenLogs] = await Promise.all([
        provider.getLogs({
          address: config.MINT_CONTRACT,
          topics: [MINT_EVENT_TOPIC, paddedWallet],
          fromBlock,
          toBlock: 'latest',
        }),
        provider.getLogs({
          address: config.JAGENT_TOKEN,
          topics: [TRANSFER_TOPIC, ethers.zeroPadValue(ethers.ZeroAddress, 32), paddedWallet],
          fromBlock,
          toBlock: 'latest',
        }),
      ]);
      for (const l of mintLogs) txHashSet.add(l.transactionHash);
      for (const l of tokenLogs) txHashSet.add(l.transactionHash);
    });
  } catch (err) {
    logger.debug('RPC bounded log scan skipped/partial (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Check baw indexed tx-history (finds older mint txs beyond RPC pruning window)
  if (sessionDir) {
    try {
      const hist = await bawTxHistory(sessionDir, {
        type: 'confirmed',
        size: 50,
        binanceChainId: config.BINANCE_CHAIN_ID,
      });
      if (hist.success && hist.data && 'transactions' in hist.data) {
        const list = (hist.data as BawTxHistoryResponse).transactions ?? [];
        for (const item of list) {
          if (item.txHash && /^0x[0-9a-fA-F]{64}$/.test(item.txHash)) {
            txHashSet.add(item.txHash);
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Inspect candidate txs (limit to 10 most recent) to verify MINT_CONTRACT interaction,
  // shares minted, date, and referrer.
  const verifiedHashes: string[] = [];
  let totalShares = 0;
  let latestBlockNum = 0;
  let lastMintDate: string | null = null;
  let referrer: string | null = null;

  for (const hash of [...txHashSet].slice(0, 10)) {
    try {
      const details = await withBscRpc(async (provider) => {
        const tx = await provider.getTransaction(hash);
        if (!tx || !tx.to || tx.to.toLowerCase() !== config.MINT_CONTRACT.toLowerCase()) {
          return null;
        }
        const receipt = await provider.getTransactionReceipt(hash);
        if (!receipt || receipt.status !== 1) return null;
        const block = receipt.blockNumber ? await provider.getBlock(receipt.blockNumber) : null;
        return { tx, receipt, block };
      });

      if (!details) continue;
      verifiedHashes.push(hash);

      // Parse MINT_EVENT_TOPIC log for share count
      let txShares = 0;
      for (const log of details.receipt.logs) {
        if (
          log.address.toLowerCase() === config.MINT_CONTRACT.toLowerCase() &&
          log.topics[0]?.toLowerCase() === MINT_EVENT_TOPIC &&
          log.data.length >= 194
        ) {
          try {
            const [, shares] = ethers.AbiCoder.defaultAbiCoder().decode(
              ['uint256', 'uint256', 'uint256'],
              log.data
            );
            txShares += Number(shares);
          } catch {
            // fallback to calldata
          }
        }
      }

      const decoded = decodeMintCalldata(details.tx.data);
      if (txShares === 0 && decoded.shares) txShares = decoded.shares;
      totalShares += txShares;
      if (decoded.referrer && !referrer) referrer = decoded.referrer;

      const blkNum = details.receipt.blockNumber ?? 0;
      if (details.block && blkNum >= latestBlockNum) {
        latestBlockNum = blkNum;
        lastMintDate = formatTimestampInTz(Number(details.block.timestamp), true);
      }
    } catch {
      // skip errored tx inspect
    }
  }

  return {
    found: verifiedHashes.length > 0,
    txHashes: verifiedHashes,
    totalShares,
    lastMintDate,
    referrer,
  };
}

export interface EligibilityProgress {
  percent: number;
  stage: string;
  agentId?: string | null;
}

export async function runEligibilityChecks(
  walletAddress: string,
  sessionDir: string,
  requestedShares?: number,
  onProgress?: (info: EligibilityProgress) => Promise<void> | void
): Promise<EligibilityResult> {
  const checks: EligibilityCheck[] = [];
  let knownAgentId: string | null | undefined = undefined;
  let maxPct = 0;
  let progressChain: Promise<void> = Promise.resolve();

  const emitProgress = (percent: number, stage: string, agentOverride?: string | null): void => {
    if (agentOverride !== undefined) knownAgentId = agentOverride;
    if (!onProgress) return;
    if (percent > maxPct) maxPct = percent;
    const pct = maxPct;
    const aid = knownAgentId;
    progressChain = progressChain
      .then(() => Promise.resolve(onProgress({ percent: pct, stage, agentId: aid })))
      .catch(() => {});
  };

  // Check if baw session is currently connected
  let sessionConnected = false;
  try {
    const st = await bawStatus(sessionDir);
    sessionConnected = st.success && st.data.status === 'CONNECTED';
  } catch {
    sessionConnected = false;
  }

  emitProgress(25, 'Resolving .ai Agent ID & mint quota...');

  const agentStatusPromise = getAgentStatus(walletAddress).then((s) => {
    emitProgress(45, 'Checking Developer Mode & mint history...', s.agentId ?? null);
    return s;
  });

  const bawAgentPromise = sessionConnected
    ? bawAgentId(sessionDir).then((res) => {
        if (res.success && res.data.claimed && res.data.agentId && !knownAgentId) {
          emitProgress(55, 'Verifying Developer Mode & balances...', res.data.agentId);
        }
        return res;
      })
    : Promise.reject(new Error('Session not connected'));

  const settingsPromise = sessionConnected
    ? bawSettings(sessionDir).then((res) => {
        emitProgress(70, 'Checking USDT & BNB balances...');
        return res;
      })
    : Promise.reject(new Error('Session not connected'));

  const onChainPromise = scanOnChainMints(walletAddress, sessionConnected ? sessionDir : undefined).then(
    (res) => {
      emitProgress(85, 'Finalizing on-chain checks...');
      return res;
    }
  );

  const [
    agentStatusRes,
    statsRes,
    onChainRes,
    settingsRes,
    bawAgentRes,
    usdtBalRes,
    bnbBalRes,
    jagentBalRes,
  ] = await Promise.allSettled([
    agentStatusPromise,
    getJagerStats(),
    onChainPromise,
    settingsPromise,
    bawAgentPromise,
    sessionConnected
      ? bawBalance(sessionDir, { tokenAddress: config.USDT_BSC, binanceChainId: config.BINANCE_CHAIN_ID })
      : Promise.reject(new Error('Session not connected')),
    sessionConnected
      ? bawBalance(sessionDir, { symbol: 'BNB', binanceChainId: config.BINANCE_CHAIN_ID })
      : Promise.reject(new Error('Session not connected')),
    sessionConnected
      ? bawBalance(sessionDir, { tokenAddress: config.JAGENT_TOKEN, binanceChainId: config.BINANCE_CHAIN_ID })
      : Promise.reject(new Error('Session not connected')),
  ]);

  // Extract live Jager status + stats
  let agentId: string | null = null;
  let priceUsdtPerShare = '5.55';
  let sharesPerMint = 10;
  let quotaRemaining = 0;
  let apiMinted = 0;
  let apiUsdtBal: string | null = null;
  let apiBnbBal: string | null = null;
  let apiJagentBal: string | null = null;
  let siteEntryOpen = true;
  let inviteStats = { invited: 0, reachedTenShares: 0, pendingUsdt: '0', paidUsdt: '0' };

  if (statsRes.status === 'fulfilled') {
    const st = statsRes.value;
    if (st.priceUsdtPerShare) priceUsdtPerShare = String(st.priceUsdtPerShare);
    if (st.sharesPerMint) sharesPerMint = st.sharesPerMint;
  }
  const bnbRequiredForMint =
    statsRes.status === 'fulfilled' && statsRes.value.bnb?.[0]?.sendBnb
      ? statsRes.value.bnb[0].sendBnb
      : null;

  if (agentStatusRes.status === 'fulfilled') {
    const s = agentStatusRes.value;
    agentId = s.agentId ?? null;
    if (s.mint?.priceUsdtPerShare) priceUsdtPerShare = String(s.mint.priceUsdtPerShare);
    if (s.mint?.sharesPerMint) sharesPerMint = s.mint.sharesPerMint;
    if (typeof s.mint?.siteEntryOpen === 'boolean') siteEntryOpen = s.mint.siteEntryOpen;
    quotaRemaining = s.mint?.remaining ?? 0;
    apiMinted = s.mint?.minted ?? 0;
    apiUsdtBal = s.balances?.usdt ?? null;
    apiBnbBal = s.balances?.bnb ?? null;
    apiJagentBal = s.balances?.jagent ?? null;
    if (s.invite) {
      inviteStats = {
        invited: s.invite.invited ?? 0,
        reachedTenShares: s.invite.reachedTenShares ?? 0,
        pendingUsdt: String(s.invite.pendingUsdt ?? '0'),
        paidUsdt: String(s.invite.paidUsdt ?? '0'),
      };
    }
  }

  // Cross-check agentId via baw if API returned null or API failed
  if (!agentId && bawAgentRes.status === 'fulfilled' && bawAgentRes.value.success) {
    const d = bawAgentRes.value.data;
    if (d.claimed && d.agentId) agentId = d.agentId;
  }

  // 1. .ai Agent ID
  if (agentStatusRes.status === 'rejected' && !agentId) {
    checks.push({
      name: 'check_agent_id',
      passed: false,
      value: 'API error',
      required: true,
      message: agentStatusRes.reason instanceof Error ? agentStatusRes.reason.message : String(agentStatusRes.reason),
    });
  } else {
    const hasAgentId = checkAgentId(agentId);
    checks.push({
      name: 'check_agent_id',
      passed: hasAgentId,
      value: agentId ?? 'None',
      required: true,
      message: hasAgentId
        ? undefined
        : 'Claim your .ai Agent ID in Binance App (Web3 Wallet → Agent ID) before minting.',
    });
  }

  // 2. Developer Mode + expiry
  let devModeExpiry: number | null = null;
  if (settingsRes.status === 'fulfilled' && settingsRes.value.success) {
    const settings = settingsRes.value.data as BawWalletSettings;
    const dm = settings.devMode;
    const enabled = Boolean(dm?.enabled);
    devModeExpiry = parseDevModeExpiry(dm?.expiresAt);
    const active = checkDevMode(enabled, dm?.expiresAt);
    const shortExp = devModeExpiry
      ? formatShortTimestamp(devModeExpiry, true).split(',')[0] ?? ''
      : '';

    let msg: string | undefined;
    if (!active) {
      msg = 'Enable Dev Mode in Binance App Settings';
    } else if (dm?.balanceExceeded) {
      msg = 'Wallet balance exceeds Dev Mode cap';
    }

    checks.push({
      name: 'check_devmode',
      passed: active && !dm?.balanceExceeded,
      value: active
        ? shortExp
          ? `Active · ${shortExp}`
          : 'Active'
        : enabled
          ? shortExp
            ? `Expired · ${shortExp}`
            : 'Expired'
          : 'Disabled',
      required: true,
      message: msg,
    });
  } else {
    checks.push({
      name: 'check_devmode',
      passed: false,
      value: sessionConnected ? 'Unavailable' : 'Logged out',
      required: true,
      message: 'Reconnect wallet to verify Dev Mode',
    });
  }

  // 3. Previous Jager mint (required: fresh unminted wallets only; if minted -> log out)
  const onChain =
    onChainRes.status === 'fulfilled'
      ? onChainRes.value
      : { found: false, txHashes: [], totalShares: 0, lastMintDate: null, referrer: null };
  const alreadyMinted = !checkNotAlreadyMinted(apiMinted, onChain.found);
  const totalPrevShares = apiMinted > 0 ? apiMinted : onChain.totalShares;

  checks.push({
    name: 'check_prev_mint',
    passed: !alreadyMinted,
    value: alreadyMinted ? `Minted (${totalPrevShares || '?'} sh)` : 'Clean',
    required: true,
    message: alreadyMinted ? 'Already minted — session logged out' : undefined,
  });

  // 4. Remaining mint quota
  const sharesNeededForCheck = requestedShares ?? sharesPerMint;
  const quotaOk = checkQuota(quotaRemaining, sharesNeededForCheck) && siteEntryOpen;
  let quotaMsg: string | undefined;
  if (!siteEntryOpen) {
    quotaMsg = 'Mint entry closed on ＪＡＧΞＲ';
  } else if (quotaRemaining < sharesNeededForCheck) {
    quotaMsg = `Need ${sharesNeededForCheck} quota left (invite or do tasks)`;
  }
  checks.push({
    name: 'check_quota',
    passed: quotaOk,
    value: `${quotaRemaining} / ${sharesNeededForCheck} left`,
    required: true,
    message: quotaMsg,
  });

  // 5. USDT balance vs needed: shares * live price * 1.02
  let usdtBalance = apiUsdtBal ?? '0';
  if (usdtBalRes.status === 'fulfilled' && usdtBalRes.value.success) {
    const bals = usdtBalRes.value.data as BawBalance[];
    const match = bals.find((b) => b.address?.toLowerCase() === config.USDT_BSC.toLowerCase()) ?? bals[0];
    if (match?.balance) usdtBalance = match.balance;
  }

  // 6. BNB for gas: at least 0.0005 BNB
  let bnbBalance = apiBnbBal ?? '0';
  if (bnbBalRes.status === 'fulfilled' && bnbBalRes.value.success) {
    const bals = bnbBalRes.value.data as BawBalance[];
    const match = bals.find((b) => b.symbol?.toUpperCase() === 'BNB') ?? bals[0];
    if (match?.balance) bnbBalance = match.balance;
  }

  let jagentBalance = apiJagentBal ?? '0';
  if (jagentBalRes.status === 'fulfilled' && jagentBalRes.value.success) {
    const bals = jagentBalRes.value.data as BawBalance[];
    const match = bals.find((b) => b.address?.toLowerCase() === config.JAGENT_TOKEN.toLowerCase()) ?? bals[0];
    if (match?.balance) jagentBalance = match.balance;
  }

  const usdtNeeded = calcUsdtNeeded(priceUsdtPerShare, sharesNeededForCheck);
  const usdtOk = checkUsdtSufficient(usdtBalance, priceUsdtPerShare, sharesNeededForCheck);
  const bnbMinForMint = bnbRequiredForMint ? parseFloat(bnbRequiredForMint) + config.MIN_BNB_GAS : Infinity;
  const canMintViaBnb = parseFloat(bnbBalance) >= bnbMinForMint;

  const cleanUsdt = Number.isFinite(parseFloat(usdtBalance)) ? parseFloat(usdtBalance).toFixed(2) : '0.00';
  const cleanUsdtNeed = Number.isFinite(parseFloat(usdtNeeded)) ? parseFloat(usdtNeeded).toFixed(2) : '0.00';
  checks.push({
    name: 'check_usdt',
    passed: usdtOk,
    value: `${cleanUsdt} / ${cleanUsdtNeed}`,
    required: true,
    message: usdtOk
      ? undefined
      : canMintViaBnb
        ? 'USDT low — BNB balance covers BNB pay'
        : `Add USDT (>= ${cleanUsdtNeed})${bnbRequiredForMint ? ` or ~${bnbMinForMint.toFixed(3)} BNB` : ''}`,
  });

  const bnbOk = checkBnbGas(bnbBalance);
  const bnbNum = parseFloat(bnbBalance);
  const cleanBnb =
    !Number.isFinite(bnbNum) || bnbNum === 0 ? '0' : bnbNum.toFixed(6).replace(/\.?0+$/, '');
  checks.push({
    name: 'check_bnb',
    passed: bnbOk,
    value: `${cleanBnb} / ${config.MIN_BNB_GAS}`,
    required: true,
    message: bnbOk ? undefined : `Add >= ${config.MIN_BNB_GAS} BNB for BSC gas`,
  });

  // Core required checks pass if AgentID, DevMode, Quota, Gas pass AND at least one payment method (USDT or BNB) is funded
  const corePassed = checks
    .filter((c) => c.required !== false && c.name !== 'check_usdt')
    .every((c) => c.passed);
  const allPassed = !alreadyMinted && corePassed && (usdtOk || canMintViaBnb);

  emitProgress(100, 'Eligibility checks complete!', agentId);
  await progressChain;

  return {
    checks,
    allPassed,
    alreadyMinted,
    canMintViaUsdt: usdtOk,
    canMintViaBnb,
    sessionConnected,
    agentId,
    priceUsdtPerShare,
    sharesPerMint,
    quotaRemaining,
    usdtBalance,
    bnbBalance,
    jagentBalance,
    bnbRequiredForMint,
    devModeExpiry,
    inviteStats,
    prevMint: {
      minted: alreadyMinted,
      shares: totalPrevShares,
      date: onChain.lastMintDate,
      txHashes: onChain.txHashes,
      referrer: onChain.referrer,
      onChain: onChain.found,
    },
  };
}

export function formatEligibilityChecks(
  result: EligibilityResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, ...args: any[]) => string,
  timerNote?: string,
  walletLabel?: string | null
): string {
  const rows: string[] = [];
  for (const c of result.checks) {
    const icon = c.passed
      ? '✅'
      : c.name === 'check_usdt' && result.canMintViaBnb
        ? '⚠️'
        : '❌';
    rows.push(`${icon} <b>${esc(t(c.name))}</b> — <code>${esc(c.value)}</code>`);
    if (c.name === 'check_prev_mint' && result.prevMint.txHashes.length > 0) {
      const links = result.prevMint.txHashes
        .slice(0, 2)
        .map((h) => `<a href="https://bscscan.com/tx/${esc(h)}">${esc(h.slice(0, 8))}...</a>`)
        .join(' · ');
      rows.push(`  ↳ <b>TX:</b> ${links}`);
    }
    if (!result.alreadyMinted && !c.passed && c.message) {
      rows.push(`  ↳ ${esc(c.message)}`);
    }
  }

  const subTitle = walletLabel ? `${t('eligibility_title')} · ${walletLabel}` : t('eligibility_title');
  const lines = [brandHeader(subTitle), '', `<blockquote>${rows.join('\n')}</blockquote>`];

  if (result.alreadyMinted) {
    const sh = result.prevMint.shares ? `<b>${result.prevMint.shares} shares</b>` : 'previously';
    lines.push('', `<blockquote>🔒 <b>Logged Out</b> — Already minted (${sh}).</blockquote>`);
  } else {
    const footer = result.allPassed ? t('eligibility_passed') : t('eligibility_failed');
    lines.push('', footer);
    if (timerNote) {
      lines.push(`⏱ <code>${esc(timerNote)}</code>`);
    }
  }

  return lines.join('\n');
}

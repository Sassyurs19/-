// tests/eligibility.test.ts
// Unit tests importing REAL functions from src/jager/eligibility.ts, src/core/errors.ts,
// src/admin/admin.ts, and src/bot/handlers/wallets.ts
import { ethers } from 'ethers';

jest.mock('../src/config', () => ({
  config: {
    MINT_CONTRACT: '0x3643A907f875fA9B740e1C0747E91b5aA5222aB8',
    JAGENT_TOKEN: '0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15',
    USDT_BSC: '0x55d398326f99059fF775485246999027B3197955',
    BNB_NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    BINANCE_CHAIN_ID: '56',
    BSC_CHAIN_ID: 56,
    MIN_BNB_GAS: 0.0005,
    SLIPPAGE_BUFFER_MULTIPLIER: 1.02,
    SELL_MAX_SLIPPAGE_PCT: '5',
    bscRpcUrl: 'https://bsc-rpc.publicnode.com',
    bscFallbackRpcs: ['https://bsc-rpc.publicnode.com'],
    jagerApiBase: 'https://jager.live/api',
    jagerRateLimitRpm: 30,
    apiMaxRetries: 3,
    logLevel: 'error',
    botToken: 'test',
    adminId: 123,
    adminRef: 'TEST',
    encryptionKey: 'a'.repeat(64),
    dbPath: ':memory:',
    sessionsDir: '/tmp/test-sessions',
    botTimezone: 'Asia/Kolkata',
    sessionTimeoutMinutes: 20,
    port: 0,
    nodeEnv: 'test',
    BAW_REQUIRED_VERSION: '1.12.0',
  },
}));

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ContractAddressMismatchError, JagentError, WalletError } from '../src/core/errors';
import {
  calcUsdtNeeded,
  checkAgentId,
  checkBnbGas,
  checkDevMode,
  checkNotAlreadyMinted,
  checkQuota,
  checkUsdtSufficient,
  decodeMintCalldata,
  parseDevModeExpiry,
} from '../src/jager/eligibility';
import { parseReferralInput } from '../src/admin/admin';
import { formatCleanNum } from '../src/bot/handlers/wallets';
import { formatRewardReason } from '../src/jager/rewards';
import {
  clearSessionTimer,
  clearTransientMsgs,
  clearWelcomeMsg,
  ensureSessionTimer,
  getSessionExpiryMs,
  renderProgressBar,
  trackTransientMsg,
  trackWelcomeMsg,
  untrackWelcomeMsg,
} from '../src/bot/sessionLifecycle';
import { assertSafeSessionPath, buildSanitizedBawEnv } from '../src/wallet/baw';
import { releaseWalletOp, tryAcquireWalletOp } from '../src/core/rateLimit';

describe('Eligibility Check Logic (Production Functions)', () => {
  describe('USDT sufficiency & 1.02x cost calculation', () => {
    it('calculates exact USDT cost with 1.02x buffer', () => {
      expect(calcUsdtNeeded('5.55', 10)).toBe('56.6100');
      expect(calcUsdtNeeded('10', 1)).toBe('10.2000');
    });

    it('passes when balance equals exact buffered requirement', () => {
      expect(checkUsdtSufficient('56.61', '5.55', 10)).toBe(true);
      expect(checkUsdtSufficient('10.2', '10', 1)).toBe(true);
    });

    it('passes when balance exceeds needed', () => {
      expect(checkUsdtSufficient('100', '5.55', 10)).toBe(true);
    });

    it('fails when balance is below needed', () => {
      expect(checkUsdtSufficient('56.60', '5.55', 10)).toBe(false);
      expect(checkUsdtSufficient('0', '5.55', 10)).toBe(false);
    });
  });

  describe('BNB gas check', () => {
    it('passes with >= 0.0005 BNB', () => {
      expect(checkBnbGas('0.0005')).toBe(true);
      expect(checkBnbGas('0.5')).toBe(true);
    });

    it('fails with < 0.0005 BNB or invalid string', () => {
      expect(checkBnbGas('0.00049')).toBe(false);
      expect(checkBnbGas('0')).toBe(false);
      expect(checkBnbGas('NaN')).toBe(false);
    });
  });

  describe('Developer Mode expiry parsing (ISO strings & Unix timestamps)', () => {
    it('parses ISO 8601 strings returned by baw wallet settings --json', () => {
      const futureIso = new Date(Date.now() + 86_400_000).toISOString();
      const parsed = parseDevModeExpiry(futureIso);
      expect(parsed).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(checkDevMode(true, futureIso)).toBe(true);
    });

    it('detects expired ISO 8601 string', () => {
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      expect(checkDevMode(true, pastIso)).toBe(false);
    });

    it('supports numeric Unix seconds and milliseconds', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(checkDevMode(true, nowSec + 3600, nowSec)).toBe(true);
      expect(checkDevMode(true, nowSec - 10, nowSec)).toBe(false);
      expect(checkDevMode(true, (nowSec + 3600) * 1000, nowSec)).toBe(true);
    });

    it('fails when disabled regardless of expiry', () => {
      const futureIso = new Date(Date.now() + 86_400_000).toISOString();
      expect(checkDevMode(false, futureIso)).toBe(false);
    });
  });

  describe('Quota check', () => {
    it('validates against minSharesRequired (e.g. 10 shares/mint)', () => {
      expect(checkQuota(10, 10)).toBe(true);
      expect(checkQuota(15, 10)).toBe(true);
      expect(checkQuota(9, 10)).toBe(false);
      expect(checkQuota(0, 1)).toBe(false);
    });
  });

  describe('Agent ID check', () => {
    it('passes for non-empty .ai ID and fails for null/empty', () => {
      expect(checkAgentId('sassy19.ai')).toBe(true);
      expect(checkAgentId(null)).toBe(false);
      expect(checkAgentId('')).toBe(false);
      expect(checkAgentId('   ')).toBe(false);
    });
  });

  describe('Already-minted guard', () => {
    it('passes for fresh wallet with 0 API mints and no on-chain logs', () => {
      expect(checkNotAlreadyMinted(0, false)).toBe(true);
    });

    it('fails when API reports minted > 0 or on-chain scan found mint', () => {
      expect(checkNotAlreadyMinted(10, false)).toBe(false);
      expect(checkNotAlreadyMinted(0, true)).toBe(false);
      expect(checkNotAlreadyMinted(20, true)).toBe(false);
    });
  });

  describe('Mint calldata decoding (for on-chain referrer & shares check)', () => {
    it('decodes mintWithUSDT calldata with shares and referrer', () => {
      const ref = '0xD08f132905Cdfedbb0f57E13b61378AC0b5dFbf4';
      const args = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'uint256'],
        [10, ref, 56610000000000000000n]
      );
      const decoded = decodeMintCalldata('0x836a1040' + args.slice(2));
      expect(decoded.method).toBe('mintWithUSDT');
      expect(decoded.shares).toBe(10);
      expect(decoded.referrer?.toLowerCase()).toBe(ref.toLowerCase());
    });

    it('omits zero-address referrer', () => {
      const args = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'uint256'],
        [10, ethers.ZeroAddress, 56610000000000000000n]
      );
      const decoded = decodeMintCalldata('0x836a1040' + args.slice(2));
      expect(decoded.shares).toBe(10);
      expect(decoded.referrer).toBeUndefined();
    });
  });
});

describe('Admin referral input parsing & CSV export', () => {
  it('accepts .ai domain and full jager.live invite link', () => {
    expect(parseReferralInput('sassy19.ai')).toBe('sassy19.ai');
    expect(parseReferralInput('https://jager.live/?ref=alice.ai')).toBe('alice.ai');
    expect(parseReferralInput('clear')).toBe('');
    expect(parseReferralInput('bad space input')).toBeNull();
  });

  it('formats live balance numbers cleanly for mobile status cards', () => {
    expect(formatCleanNum('54.99000000337289185', 2)).toBe('54.99');
    expect(formatCleanNum('0.0000983463', 6)).toBe('0.000098');
    expect(formatCleanNum('0', 4)).toBe('0');
  });

  it('formats invite reward claim reasons clearly', () => {
    expect(formatRewardReason('nothing')).toContain('No pending rewards');
    expect(formatRewardReason('too-soon')).toContain('Cooldown');
    expect(formatRewardReason('paused')).toContain('paused');
  });
});

describe('Progress bar, transient cleanup & 20-min timer lifecycle', () => {
  it('renders clean progress bars', () => {
    expect(renderProgressBar(20)).toContain('██░░░░░░░░');
    expect(renderProgressBar(100)).toContain('██████████');
    expect(renderProgressBar(100)).toContain('100%');
  });

  it('tracks and deletes transient messages without deleting untracked ones', async () => {
    const deleteMessage = jest.fn().mockResolvedValue(true);
    const fakeApi = { deleteMessage } as unknown as import('grammy').Api;
    trackTransientMsg(500, 101);
    trackTransientMsg(500, 102);
    await clearTransientMsgs(fakeApi, 500);
    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith(500, 101);
    expect(deleteMessage).toHaveBeenCalledWith(500, 102);
    await clearTransientMsgs(fakeApi, 500);
    expect(deleteMessage).toHaveBeenCalledTimes(2);
  });

  it('starts and clears 20-minute wallet session timer cleanly', () => {
    const fakeApi = { sendMessage: jest.fn() } as unknown as import('grammy').Api;
    const expires = ensureSessionTimer({
      api: fakeApi,
      walletId: 777,
      chatId: 500,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      sessionDir: '/tmp/none',
      lang: 'en',
    });
    expect(expires).toBeGreaterThan(Date.now() + 19 * 60_000);
    expect(getSessionExpiryMs(777)).toBe(expires);
    clearSessionTimer(777);
    expect(getSessionExpiryMs(777)).toBeNull();
  });
});

describe('Security guards & welcome auto-cleanup', () => {
  it('blocks malicious referral inputs inside URLs and oversize payloads', () => {
    expect(parseReferralInput('https://jager.live/?ref=evil<script>')).toBeNull();
    expect(parseReferralInput('https://jager.live/?ref=alice%20space')).toBeNull();
    expect(parseReferralInput('a'.repeat(300))).toBeNull();
    expect(parseReferralInput('https://jager.live/?ref=sassy19.ai')).toBe('sassy19.ai');
    expect(parseReferralInput('0xD08f132905Cdfedbb0f57E13b61378AC0b5dFbf4')).toBe(
      '0xD08f132905Cdfedbb0f57E13b61378AC0b5dFbf4'
    );
  });

  it('strips secret bot env vars from child baw subprocess env', () => {
    process.env.BOT_TOKEN = '123456789:SECRET_TOKEN';
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    process.env.ADMIN_ID = '999999';
    const childEnv = buildSanitizedBawEnv({ BINANCE_BAW_DIR: '/tmp/test-sessions/u1' });
    expect(childEnv.BOT_TOKEN).toBeUndefined();
    expect(childEnv.ENCRYPTION_KEY).toBeUndefined();
    expect(childEnv.ADMIN_ID).toBeUndefined();
    expect(childEnv.BINANCE_BAW_DIR).toBe('/tmp/test-sessions/u1');
  });

  it('rejects session path traversal outside sessionsDir', () => {
    expect(() => assertSafeSessionPath('/tmp/test-sessions/user1')).not.toThrow();
    expect(() => assertSafeSessionPath('/tmp/test-sessions/../etc/passwd')).toThrow();
    expect(() => assertSafeSessionPath('/tmp/other-dir')).toThrow();
  });

  it('enforces per-wallet operation mutex to block concurrent double submits', () => {
    expect(tryAcquireWalletOp(901)).toBe(true);
    expect(tryAcquireWalletOp(901)).toBe(false);
    releaseWalletOp(901);
    expect(tryAcquireWalletOp(901)).toBe(true);
    releaseWalletOp(901);
  });

  it('deletes starting welcome message on next input unless untracked (edited into Status/Wallets)', async () => {
    const deleteMessage = jest.fn().mockResolvedValue(true);
    const fakeApi = { deleteMessage } as unknown as import('grammy').Api;

    trackWelcomeMsg(600, 10);
    await clearWelcomeMsg(fakeApi, 600);
    expect(deleteMessage).toHaveBeenCalledWith(600, 10);

    // If transformed in-place into Status/Wallets, untrack preserves the active report
    trackWelcomeMsg(600, 20);
    untrackWelcomeMsg(600, 20);
    await clearWelcomeMsg(fakeApi, 600);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Error Classes', () => {
  it('constructs JagentError, WalletError, ContractAddressMismatchError properly', () => {
    const jErr = new JagentError('test', 'CODE', true);
    expect(jErr.retryable).toBe(true);
    const wErr = new WalletError('wallet fail');
    expect(wErr).toBeInstanceOf(JagentError);
    const cErr = new ContractAddressMismatchError('0xA', '0xB');
    expect(cErr.code).toBe('CONTRACT_MISMATCH');
  });
});

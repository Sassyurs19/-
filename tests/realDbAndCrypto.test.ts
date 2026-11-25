// tests/realDbAndCrypto.test.ts
// Real integration tests (no DB mocks): verifies SQLite schema + repository + AES-256-GCM crypto
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jagent-real-test-'));
const dbFile = path.join(tmpRoot, 'test.db');

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
    adminRef: 'sassy19.ai',
    encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    dbPath: dbFile,
    sessionsDir: path.join(tmpRoot, 'sessions'),
    botTimezone: 'Asia/Kolkata',
    port: 0,
    nodeEnv: 'test',
    BAW_REQUIRED_VERSION: '1.12.0',
  },
}));

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getDb } from '../src/db/schema';
import {
  addWallet,
  getAdminSettings,
  getAdminTotals,
  getWalletFullHistory,
  insertMint,
  insertRewardClaim,
  insertSell,
  saveEligibilityCheck,
  updateMintStatus,
  updateSellStatus,
  upsertUser,
} from '../src/db/repository';
import { decryptDir, encryptDir, sweepSessionsDir, wipeDir } from '../src/core/crypto';
import { formatCleanNum } from '../src/bot/handlers/wallets';

afterAll(() => {
  try {
    getDb().close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Real SQLite & AES-256-GCM integration', () => {
  it('seeds admin referral_code from ADMIN_REF env', () => {
    getDb();
    const settings = getAdminSettings();
    expect(settings.referral_code).toBe('sassy19.ai');
    expect(settings.max_shares).toBe(10);
    expect(settings.minting_paused).toBe(false);
  });

  it('auto-names wallets sequentially per user (Wallet 1, Wallet 2, Wallet 3) and preserves label on reconnect', () => {
    upsertUser(999002, 'en');
    upsertUser(999003, 'en');

    const u1w1 = addWallet(999002, '0x0000000000000000000000000000000000000001', path.join(tmpRoot, 'sessions/u1w1'));
    const u1w2 = addWallet(999002, '0x0000000000000000000000000000000000000002', path.join(tmpRoot, 'sessions/u1w2'));
    const u1w3 = addWallet(999002, '0x0000000000000000000000000000000000000003', path.join(tmpRoot, 'sessions/u1w3'));
    const u1w1Reconnect = addWallet(999002, '0x0000000000000000000000000000000000000001', path.join(tmpRoot, 'sessions/u1w1b'));
    const u2w1 = addWallet(999003, '0x0000000000000000000000000000000000000009', path.join(tmpRoot, 'sessions/u2w1'));

    expect(u1w1.label).toBe('Wallet 1');
    expect(u1w2.label).toBe('Wallet 2');
    expect(u1w3.label).toBe('Wallet 3');
    expect(u1w1Reconnect.label).toBe('Wallet 1');
    expect(u2w1.label).toBe('Wallet 1');
  });

  it('persists checks, mints, sells with receiveAmount + gasUsed, and admin totals', () => {
    upsertUser(999001, 'en');
    const wallet = addWallet(999001, '0x1234567890abcdef1234567890abcdef12345678', path.join(tmpRoot, 'sessions/w1'));
    expect(wallet.label).toBe('Wallet 1');

    saveEligibilityCheck(wallet.id, {
      agent_id_ok: 1,
      agent_id_val: 'alice.ai',
      devmode_ok: 1,
      devmode_expiry: 1800000000,
      prev_mint_ok: 0,
      prev_shares: 0,
      prev_date: null,
      prev_txs: '[]',
      quota_remaining: 10,
      usdt_balance: '60',
      usdt_needed: '56.61',
      bnb_balance: '0.02',
      bnb_ok: 1,
      all_ok: 1,
    });

    const mintId = insertMint(wallet.id, {
      shares: 10,
      pay_method: 'usdt',
      total_cost: '55.50 USDT',
      gas_used: null,
      tx_hash: null,
      referrer: 'sassy19.ai',
      status: 'pending',
      error_reason: null,
    });
    updateMintStatus(mintId, 'success', '0xMINT_HASH', '0.00025');

    const sellId = insertSell(wallet.id, {
      jagent_amount: '5000',
      receive_token: 'BNB',
      receive_amount: null,
      gas_used: null,
      tx_hash: null,
      status: 'pending',
      error_reason: null,
    });
    updateSellStatus(sellId, 'success', '0xSELL_HASH', undefined, '0.1234', '0.00018');

    insertRewardClaim(wallet.id, {
      amount_usdt: '1.0',
      tx_hash: '0xREWARD_HASH',
      status: 'success',
      source: 'auto_mint',
      reason: null,
    });

    const history = getWalletFullHistory(wallet.id);
    expect(history.checks).toHaveLength(1);
    expect(history.mints[0].tx_hash).toBe('0xMINT_HASH');
    expect(history.mints[0].gas_used).toBe('0.00025');
    expect(history.sells[0].receive_amount).toBe('0.1234');
    expect(history.sells[0].gas_used).toBe('0.00018');
    expect(history.rewards).toHaveLength(1);
    expect(history.rewards?.[0].tx_hash).toBe('0xREWARD_HASH');

    const totals = getAdminTotals();
    expect(totals.total_mints).toBe(1);
    expect(totals.total_shares).toBe(10);
    expect(totals.total_sells).toBe(1);
  });

  it('formats numbers cleanly without stripping trailing integer zeros', () => {
    expect(formatCleanNum('5000', 0)).toBe('5000');
    expect(formatCleanNum(5000, 0)).toBe('5000');
    expect(formatCleanNum('50.00', 2)).toBe('50');
    expect(formatCleanNum('54.9900', 2)).toBe('54.99');
    expect(formatCleanNum('0.000098', 6)).toBe('0.000098');
    expect(formatCleanNum('0', 4)).toBe('0');
  });

  it('encrypts, decrypts, and wipes session directory cleanly', () => {
    const sessDir = path.join(tmpRoot, 'sessions/crypto_test');
    fs.mkdirSync(sessDir, { recursive: true });
    const sessionFile = path.join(sessDir, 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({ clientId: 'secret-uuid', sessionId: 'secret-token' }));

    encryptDir(sessDir);
    expect(fs.existsSync(sessionFile)).toBe(false);
    expect(fs.existsSync(sessionFile + '.enc')).toBe(true);

    decryptDir(sessDir);
    expect(fs.existsSync(sessionFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(parsed.sessionId).toBe('secret-token');

    wipeDir(sessDir);
    expect(fs.existsSync(sessDir)).toBe(false);
  });

  it('handles .enc in folder names and sweeps crash-leftover plaintext sessions on startup', () => {
    const sessRoot = path.join(tmpRoot, 'sessions');
    const walletDir = path.join(sessRoot, '999_wallet.enc_dir');
    const staleTmpDir = path.join(sessRoot, '999_new_1');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.mkdirSync(staleTmpDir, { recursive: true });

    const leftOverFile = path.join(walletDir, 'session.json');
    fs.writeFileSync(leftOverFile, JSON.stringify({ secret: 'abc' }));
    fs.writeFileSync(path.join(sessRoot, '.baw_no_keytar.mjs'), 'export default {};');

    // Backdate stale temp dir beyond 10 minutes
    const oldTime = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(staleTmpDir, oldTime, oldTime);

    const swept = sweepSessionsDir(sessRoot);
    expect(swept).toBe(2);
    expect(fs.existsSync(leftOverFile)).toBe(false);
    expect(fs.existsSync(leftOverFile + '.enc')).toBe(true);
    expect(fs.existsSync(staleTmpDir)).toBe(false);
    expect(fs.existsSync(path.join(sessRoot, '.baw_no_keytar.mjs'))).toBe(true);

    decryptDir(walletDir);
    expect(fs.existsSync(leftOverFile)).toBe(true);
    wipeDir(walletDir);
  });
});

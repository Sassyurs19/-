// src/db/repository.ts
import { getDb } from './schema';
import { Lang } from '../i18n';

export interface User {
  telegram_id: number;
  lang: Lang;
  created_at: number;
}

export interface Wallet {
  id: number;
  telegram_id: number;
  address: string;
  label: string | null;
  agent_id: string | null;
  session_dir: string;
  connected_at: number;
  last_check_at: number | null;
  last_check_ok: number | null;
  is_active: number;
}

export interface EligibilityCheckRecord {
  id: number;
  wallet_id: number;
  checked_at: number;
  agent_id_ok: number | null;
  agent_id_val: string | null;
  devmode_ok: number | null;
  devmode_expiry: number | null;
  prev_mint_ok: number | null;
  prev_shares: number | null;
  prev_date: string | null;
  prev_txs: string | null;
  quota_remaining: number | null;
  usdt_balance: string | null;
  usdt_needed: string | null;
  bnb_balance: string | null;
  bnb_ok: number | null;
  all_ok: number;
}

export interface MintRecord {
  id: number;
  wallet_id: number;
  minted_at: number;
  shares: number;
  pay_method: string;
  total_cost: string;
  gas_used: string | null;
  tx_hash: string | null;
  referrer: string | null;
  status: string;
  error_reason: string | null;
}

export interface SellRecord {
  id: number;
  wallet_id: number;
  sold_at: number;
  jagent_amount: string;
  receive_token: string;
  receive_amount: string | null;
  gas_used: string | null;
  tx_hash: string | null;
  status: string;
  error_reason: string | null;
}

export interface RewardClaimRecord {
  id: number;
  wallet_id: number;
  claimed_at: number;
  amount_usdt: string;
  tx_hash: string | null;
  status: string;
  source: string;
  reason: string | null;
}

export interface AdminSettings {
  referral_code: string;
  max_shares: number;
  minting_paused: boolean;
}

// ---- Users ----

export function upsertUser(telegramId: number, lang: Lang = 'en'): void {
  getDb().prepare(`
    INSERT INTO users(telegram_id, lang) VALUES(?, ?)
    ON CONFLICT(telegram_id) DO NOTHING
  `).run(telegramId, lang);
}

export function getUser(telegramId: number): User | null {
  return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | null;
}

export function setUserLang(telegramId: number, lang: Lang): void {
  getDb().prepare('UPDATE users SET lang = ? WHERE telegram_id = ?').run(lang, telegramId);
}

// ---- Wallets ----

export function addWallet(telegramId: number, address: string, sessionDir: string): Wallet {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM wallets WHERE telegram_id = ? AND address = ?')
    .get(telegramId, address) as Wallet | null;

  let nextLabel = existing?.label ?? null;
  if (!nextLabel) {
    const countRow = db
      .prepare('SELECT COUNT(*) as c FROM wallets WHERE telegram_id = ?')
      .get(telegramId) as { c: number } | undefined;
    const num = (countRow?.c ?? 0) + 1;
    nextLabel = `Wallet ${num}`;
  }

  db.prepare(`
    INSERT INTO wallets(telegram_id, address, label, session_dir)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(telegram_id, address) DO UPDATE SET
      is_active = 1,
      label = COALESCE(wallets.label, excluded.label),
      session_dir = excluded.session_dir,
      connected_at = unixepoch()
  `).run(telegramId, address, nextLabel, sessionDir);
  return db.prepare('SELECT * FROM wallets WHERE telegram_id = ? AND address = ?').get(telegramId, address) as Wallet;
}

export function getWallet(id: number): Wallet | null {
  return getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(id) as Wallet | null;
}

export function getWalletByAddress(telegramId: number, address: string): Wallet | null {
  return getDb().prepare('SELECT * FROM wallets WHERE telegram_id = ? AND address = ? AND is_active = 1').get(telegramId, address) as Wallet | null;
}

export function getUserWallets(telegramId: number): Wallet[] {
  return getDb().prepare('SELECT * FROM wallets WHERE telegram_id = ? AND is_active = 1 ORDER BY id ASC').all(telegramId) as Wallet[];
}

export function updateWalletAgentId(walletId: number, agentId: string): void {
  getDb().prepare('UPDATE wallets SET agent_id = ? WHERE id = ?').run(agentId, walletId);
}

export function updateWalletLastCheck(walletId: number, ok: boolean): void {
  getDb().prepare('UPDATE wallets SET last_check_at = unixepoch(), last_check_ok = ? WHERE id = ?').run(ok ? 1 : 0, walletId);
}

export function deactivateWallet(walletId: number): void {
  getDb().prepare('UPDATE wallets SET is_active = 0 WHERE id = ?').run(walletId);
}

// ---- Eligibility ----

export function saveEligibilityCheck(walletId: number, data: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO eligibility_checks(
      wallet_id, agent_id_ok, agent_id_val, devmode_ok, devmode_expiry,
      prev_mint_ok, prev_shares, prev_date, prev_txs,
      quota_remaining, usdt_balance, usdt_needed, bnb_balance, bnb_ok, all_ok
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    walletId,
    data.agent_id_ok ?? null, data.agent_id_val ?? null,
    data.devmode_ok ?? null, data.devmode_expiry ?? null,
    data.prev_mint_ok ?? null, data.prev_shares ?? null, data.prev_date ?? null, data.prev_txs ?? null,
    data.quota_remaining ?? null, data.usdt_balance ?? null, data.usdt_needed ?? null,
    data.bnb_balance ?? null, data.bnb_ok ?? null, data.all_ok ?? 0
  );
}

export function getEligibilityChecks(walletId: number, limit = 20): EligibilityCheckRecord[] {
  return getDb()
    .prepare('SELECT * FROM eligibility_checks WHERE wallet_id = ? ORDER BY checked_at DESC LIMIT ?')
    .all(walletId, limit) as EligibilityCheckRecord[];
}

// ---- Mint History ----

export function insertMint(walletId: number, data: Omit<MintRecord, 'id' | 'wallet_id' | 'minted_at'>): number {
  const result = getDb().prepare(`
    INSERT INTO mint_history(wallet_id, shares, pay_method, total_cost, gas_used, tx_hash, referrer, status, error_reason)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(walletId, data.shares, data.pay_method, data.total_cost, data.gas_used, data.tx_hash, data.referrer, data.status, data.error_reason);
  return result.lastInsertRowid as number;
}

export function updateMintStatus(
  mintId: number,
  status: string,
  txHash?: string,
  gasUsed?: string,
  errorReason?: string
): void {
  getDb().prepare(`
    UPDATE mint_history
    SET status = ?,
        tx_hash = COALESCE(?, tx_hash),
        gas_used = COALESCE(?, gas_used),
        error_reason = COALESCE(?, error_reason)
    WHERE id = ?
  `).run(status, txHash ?? null, gasUsed ?? null, errorReason ?? null, mintId);
}

export function getMintHistory(walletId: number, limit = 20): MintRecord[] {
  return getDb()
    .prepare('SELECT * FROM mint_history WHERE wallet_id = ? ORDER BY minted_at DESC LIMIT ?')
    .all(walletId, limit) as MintRecord[];
}

// ---- Sell History ----

export function insertSell(walletId: number, data: Omit<SellRecord, 'id' | 'wallet_id' | 'sold_at'>): number {
  const result = getDb().prepare(`
    INSERT INTO sell_history(wallet_id, jagent_amount, receive_token, receive_amount, gas_used, tx_hash, status, error_reason)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(walletId, data.jagent_amount, data.receive_token, data.receive_amount, data.gas_used, data.tx_hash, data.status, data.error_reason);
  return result.lastInsertRowid as number;
}

export function updateSellStatus(
  sellId: number,
  status: string,
  txHash?: string,
  errorReason?: string,
  receiveAmount?: string,
  gasUsed?: string
): void {
  getDb().prepare(`
    UPDATE sell_history
    SET status = ?,
        tx_hash = COALESCE(?, tx_hash),
        error_reason = COALESCE(?, error_reason),
        receive_amount = COALESCE(?, receive_amount),
        gas_used = COALESCE(?, gas_used)
    WHERE id = ?
  `).run(status, txHash ?? null, errorReason ?? null, receiveAmount ?? null, gasUsed ?? null, sellId);
}

export function getSellHistory(walletId: number, limit = 20): SellRecord[] {
  return getDb()
    .prepare('SELECT * FROM sell_history WHERE wallet_id = ? ORDER BY sold_at DESC LIMIT ?')
    .all(walletId, limit) as SellRecord[];
}

// ---- Reward Claims ----

export function insertRewardClaim(
  walletId: number,
  data: Omit<RewardClaimRecord, 'id' | 'wallet_id' | 'claimed_at'>
): number {
  const result = getDb().prepare(`
    INSERT INTO reward_claims(wallet_id, amount_usdt, tx_hash, status, source, reason)
    VALUES(?,?,?,?,?,?)
  `).run(walletId, data.amount_usdt, data.tx_hash, data.status, data.source, data.reason);
  return result.lastInsertRowid as number;
}

export function getRewardHistory(walletId: number, limit = 20): RewardClaimRecord[] {
  return getDb()
    .prepare('SELECT * FROM reward_claims WHERE wallet_id = ? ORDER BY claimed_at DESC LIMIT ?')
    .all(walletId, limit) as RewardClaimRecord[];
}

// ---- Admin Settings ----

export function getAdminSettings(): AdminSettings {
  const rows = getDb().prepare('SELECT key, value FROM admin_settings').all() as { key: string; value: string }[];
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  return {
    referral_code: map.referral_code ?? '',
    max_shares: parseInt(map.max_shares ?? '10', 10),
    minting_paused: map.minting_paused === '1',
  };
}

export function setAdminSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO admin_settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, value);
}

// ---- Full History & CSV Export ----

export interface WalletFullHistory {
  checks: EligibilityCheckRecord[];
  mints: MintRecord[];
  sells: SellRecord[];
  rewards?: RewardClaimRecord[];
}

export function getWalletFullHistory(walletId: number): WalletFullHistory {
  return {
    checks: getEligibilityChecks(walletId, 1000),
    mints: getMintHistory(walletId, 1000),
    sells: getSellHistory(walletId, 1000),
    rewards: getRewardHistory(walletId, 1000),
  };
}

// ---- Admin Totals ----

export interface AdminTotals {
  total_users: number;
  total_wallets: number;
  total_mints: number;
  failed_mints: number;
  total_shares: number;
  total_sells: number;
  failed_sells: number;
}

export function getAdminTotals(): AdminTotals {
  const db = getDb();
  return {
    total_users: (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c,
    total_wallets: (db.prepare('SELECT COUNT(*) as c FROM wallets WHERE is_active = 1').get() as { c: number }).c,
    total_mints: (db.prepare("SELECT COUNT(*) as c FROM mint_history WHERE status = 'success'").get() as { c: number }).c,
    failed_mints: (db.prepare("SELECT COUNT(*) as c FROM mint_history WHERE status = 'failed'").get() as { c: number }).c,
    total_shares: (db.prepare("SELECT COALESCE(SUM(shares),0) as c FROM mint_history WHERE status = 'success'").get() as { c: number }).c,
    total_sells: (db.prepare("SELECT COUNT(*) as c FROM sell_history WHERE status = 'success'").get() as { c: number }).c,
    failed_sells: (db.prepare("SELECT COUNT(*) as c FROM sell_history WHERE status = 'failed'").get() as { c: number }).c,
  };
}

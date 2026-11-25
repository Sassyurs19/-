// src/db/schema.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../core/logger';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applyMigrations(_db);
  logger.info('SQLite database initialized', { path: config.dbPath });
  return _db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id    INTEGER PRIMARY KEY,
      lang           TEXT NOT NULL DEFAULT 'en',
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id    INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      address        TEXT NOT NULL,
      label          TEXT,
      agent_id       TEXT,
      session_dir    TEXT NOT NULL,
      connected_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_check_at  INTEGER,
      last_check_ok  INTEGER,
      is_active      INTEGER NOT NULL DEFAULT 1,
      UNIQUE(telegram_id, address)
    );

    CREATE TABLE IF NOT EXISTS eligibility_checks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id       INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      checked_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      agent_id_ok     INTEGER,
      agent_id_val    TEXT,
      devmode_ok      INTEGER,
      devmode_expiry  INTEGER,
      prev_mint_ok    INTEGER,
      prev_shares     INTEGER,
      prev_date       TEXT,
      prev_txs        TEXT,
      quota_remaining INTEGER,
      usdt_balance    TEXT,
      usdt_needed     TEXT,
      bnb_balance     TEXT,
      bnb_ok          INTEGER,
      all_ok          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mint_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id      INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      minted_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      shares         INTEGER NOT NULL,
      pay_method     TEXT NOT NULL,
      total_cost     TEXT NOT NULL,
      gas_used       TEXT,
      tx_hash        TEXT,
      referrer       TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      error_reason   TEXT
    );

    CREATE TABLE IF NOT EXISTS sell_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id      INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      sold_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      jagent_amount  TEXT NOT NULL,
      receive_token  TEXT NOT NULL,
      receive_amount TEXT,
      gas_used       TEXT,
      tx_hash        TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      error_reason   TEXT
    );

    CREATE TABLE IF NOT EXISTS reward_claims (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id      INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      claimed_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      amount_usdt    TEXT NOT NULL,
      tx_hash        TEXT,
      status         TEXT NOT NULL DEFAULT 'success',
      source         TEXT NOT NULL DEFAULT 'manual',
      reason         TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      key            TEXT PRIMARY KEY,
      value          TEXT NOT NULL,
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO admin_settings(key, value) VALUES
      ('referral_code', ''),
      ('max_shares', '10'),
      ('minting_paused', '0');
  `);

  // Safe migration for existing SQLite databases created before `wallets.label`
  try {
    const cols = db.pragma('table_info(wallets)') as Array<{ name: string }> | undefined;
    if (Array.isArray(cols) && cols.length > 0) {
      if (!cols.some((c) => c.name === 'label')) {
        db.exec('ALTER TABLE wallets ADD COLUMN label TEXT');
      }
      // Backfill any wallets missing labels with Wallet 1, Wallet 2, ... per user
      const rows = db
        .prepare('SELECT id, telegram_id, label FROM wallets ORDER BY telegram_id ASC, id ASC')
        .all() as Array<{ id: number; telegram_id: number; label: string | null }>;
      const counts = new Map<number, number>();
      const upd = db.prepare('UPDATE wallets SET label = ? WHERE id = ?');
      for (const r of rows) {
        const nextNum = (counts.get(r.telegram_id) ?? 0) + 1;
        counts.set(r.telegram_id, nextNum);
        if (!r.label) {
          upd.run(`Wallet ${nextNum}`, r.id);
        }
      }
    }
  } catch {
    // Ignored under unit-test SQLite mocks
  }

  // Seed default referral_code from env if still empty
  const refRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'referral_code'").get() as { value?: string } | undefined;
  if (refRow && !refRow.value && config.adminRef) {
    db.prepare("UPDATE admin_settings SET value = ? WHERE key = 'referral_code'").run(config.adminRef);
  }
}

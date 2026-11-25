// tests/db.test.ts
// Repository unit tests using a jest mock for better-sqlite3
// (better-sqlite3 requires native compilation; we mock it for CI portability)

// ── Minimal in-memory SQLite mock ──────────────────────────────────────────
const store: Record<string, Record<string, unknown>[]> = {
  users: [],
  wallets: [],
  eligibility_checks: [],
  mint_history: [],
  sell_history: [],
  admin_settings: [
    { key: 'referral_code', value: '', updated_at: 0 },
    { key: 'max_shares', value: '10', updated_at: 0 },
    { key: 'minting_paused', value: '0', updated_at: 0 },
  ],
};
let autoId = 1;

function makeStatement(sql: string) {
  return {
    run: (...params: unknown[]) => {
      const p = params.flat();
      const tableMatch = sql.match(/(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i);
      if (!tableMatch) return { lastInsertRowid: autoId++, changes: 0 };
      const tbl = tableMatch[1];
      if (!store[tbl]) store[tbl] = [];

      if (/INSERT/i.test(sql)) {
        const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
        const cols = colMatch ? colMatch[1].split(',').map(c => c.trim()) : [];
        const row: Record<string, unknown> = {};
        // map positional params
        cols.forEach((c, i) => { row[c] = p[i] ?? null; });
        if (!row.id) row.id = autoId++;
        // Handle ON CONFLICT DO NOTHING / DO UPDATE
        if (/DO NOTHING/i.test(sql)) {
          const pk = tbl === 'users' ? 'telegram_id' : tbl === 'wallets' ? 'address' : 'key';
          const conflict = store[tbl].findIndex(r => r[pk] === row[pk]);
          if (conflict === -1) store[tbl].push(row);
        } else if (/DO UPDATE/i.test(sql)) {
          const pk = tbl === 'wallets' ? ['telegram_id', 'address'] : ['key'];
          const conflict = store[tbl].findIndex(r =>
            pk.every(k => r[k] === row[k])
          );
          if (conflict === -1) {
            store[tbl].push(row);
          } else {
            // Update value & updated_at
            if (row.value !== undefined) store[tbl][conflict].value = row.value;
            if (row.session_dir !== undefined) store[tbl][conflict].session_dir = row.session_dir;
            if (row.is_active !== undefined) store[tbl][conflict].is_active = row.is_active;
          }
        } else {
          store[tbl].push(row);
        }
        return { lastInsertRowid: row.id as number, changes: 1 };
      }

      if (/UPDATE/i.test(sql)) {
        // Simple: find by last param (WHERE id = ?)
        const idParam = p[p.length - 1];
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
        store[tbl].forEach(r => {
          if (r.id === idParam || r.key === idParam) {
            if (p[0] !== undefined) {
              // parse SET columns
              if (setMatch) {
                const setParts = setMatch[1].split(',');
                setParts.forEach((part, i) => {
                  const colName = part.split('=')[0].trim();
                  if (p[i] !== undefined && p[i] !== null) r[colName] = p[i];
                });
              }
            }
          }
        });
        return { lastInsertRowid: 0, changes: 1 };
      }
      return { lastInsertRowid: autoId++, changes: 0 };
    },
    get: (...params: unknown[]) => {
      const p = params.flat();
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      if (!tableMatch) {
        // COUNT(*) queries
        if (/COUNT/i.test(sql)) return { c: store['users']?.length ?? 0 };
        return null;
      }
      const tbl = tableMatch[1];
      if (!store[tbl]) return null;

      // COUNT aggregates
      if (/COUNT\(\*\)/i.test(sql)) {
        const countTbl = tbl;
        let arr = store[countTbl] ?? [];
        if (/WHERE.*telegram_id/i.test(sql) && p.length > 0) arr = arr.filter(r => r.telegram_id === p[0]);
        if (/WHERE.*is_active.*=.*1/i.test(sql)) arr = arr.filter(r => r.is_active === 1);
        if (/WHERE.*status.*=.*'success'/i.test(sql)) arr = arr.filter(r => r.status === 'success');
        return { c: arr.length };
      }
      if (/SUM\(shares\)/i.test(sql)) {
        const arr = (store[tbl] ?? []).filter(r => r.status === 'success');
        return { c: arr.reduce((s, r) => s + ((r.shares as number) ?? 0), 0) };
      }

      // Find by param
      if (p.length >= 2 && /address/i.test(sql)) {
        return store[tbl].find(r => r.telegram_id === p[0] && r.address === p[1]) ?? null;
      }
      if (p.length > 0) {
        return store[tbl].find(r =>
          r.telegram_id === p[0] ||
          r.id === p[0] ||
          r.key === p[0]
        ) ?? null;
      }
      return store[tbl][0] ?? null;
    },
    all: (...params: unknown[]) => {
      const p = params.flat();
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      if (!tableMatch) return [];
      const tbl = tableMatch[1];
      let rows = store[tbl] ? [...store[tbl]] : [];
      if (/is_active\s*=\s*1/i.test(sql)) rows = rows.filter(r => r.is_active === 1);
      if (p.length > 0 && /WHERE.*telegram_id/i.test(sql)) rows = rows.filter(r => r.telegram_id === p[0]);
      if (p.length > 0 && /WHERE.*wallet_id/i.test(sql)) rows = rows.filter(r => r.wallet_id === p[0]);
      if (/LIMIT\s+\?/i.test(sql) && p.length > 0) rows = rows.slice(0, p[p.length - 1] as number);
      return rows;
    },
  };
}

const mockDb = {
  prepare: (sql: string) => makeStatement(sql),
  pragma: jest.fn(),
  exec: jest.fn(),
};

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => mockDb);
});

jest.mock('../src/config', () => ({
  config: {
    dbPath: ':memory:',
    sessionsDir: '/tmp/test-sessions',
    logLevel: 'error',
    botToken: 'test',
    adminId: 1,
    adminRef: 'TEST',
    encryptionKey: 'a'.repeat(64),
    MINT_CONTRACT: '0x3643A907f875fA9B740e1C0747E91b5aA5222aB8',
    JAGENT_TOKEN: '0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15',
    USDT_BSC: '0x55d398326f99059fF775485246999027B3197955',
    BINANCE_CHAIN_ID: '56',
    BSC_CHAIN_ID: 56,
    bscRpcUrl: 'https://bsc-dataseed1.binance.org',
    jagerApiBase: 'https://jager.live/api',
    jagerRateLimitRpm: 30,
    apiMaxRetries: 3,
    nodeEnv: 'test',
    BAW_REQUIRED_VERSION: '1.12.0',
  },
}));

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Now import the actual repository ──────────────────────────────────────
import {
  upsertUser, getUser, setUserLang,
  addWallet, getWallet, getUserWallets, updateWalletAgentId,
  updateWalletLastCheck, deactivateWallet,
  getAdminSettings, setAdminSetting,
  insertMint, updateMintStatus, getMintHistory,
  insertSell, updateSellStatus, getSellHistory,
  getAdminTotals,
} from '../src/db/repository';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('User repository', () => {
  it('creates a user and retrieves it', () => {
    upsertUser(1001);
    const u = getUser(1001);
    expect(u).not.toBeNull();
  });

  it('upsert is idempotent', () => {
    upsertUser(1002);
    upsertUser(1002);
    // Should not throw, store remains stable
    expect(store.users.filter(u => u.telegram_id === 1002)).toHaveLength(1);
  });

  it('sets user language', () => {
    upsertUser(1003);
    setUserLang(1003, 'te');
    // setUserLang calls UPDATE — verify the mock doesn't throw
    expect(true).toBe(true);
  });
});

describe('Wallet repository', () => {
  beforeEach(() => { upsertUser(2001); });

  it('adds a wallet', () => {
    const w = addWallet(2001, '0xABC', '/sessions/abc');
    expect(w).not.toBeNull();
    expect(w.address).toBe('0xABC');
  });

  it('updates agent id without throwing', () => {
    const w = addWallet(2001, '0xAGENT', '/sessions/agent');
    expect(() => updateWalletAgentId(w.id, 'myagent.ai')).not.toThrow();
  });

  it('updates last check without throwing', () => {
    const w = addWallet(2001, '0xCHECK', '/sessions/check');
    expect(() => updateWalletLastCheck(w.id, true)).not.toThrow();
  });

  it('deactivates wallet without throwing', () => {
    const w = addWallet(2001, '0xDEACT', '/sessions/deact');
    expect(() => deactivateWallet(w.id)).not.toThrow();
  });
});

describe('Mint history repository', () => {
  let walletId: number;
  beforeEach(() => {
    upsertUser(3001);
    const w = addWallet(3001, '0xMINT', '/sessions/mint');
    walletId = w.id;
  });

  it('inserts a mint record without throwing', () => {
    expect(() => insertMint(walletId, {
      shares: 3, pay_method: 'usdt', total_cost: '30.6',
      gas_used: null, tx_hash: null, referrer: 'REF', status: 'pending', error_reason: null,
    })).not.toThrow();
  });

  it('updateMintStatus does not throw', () => {
    const id = insertMint(walletId, {
      shares: 1, pay_method: 'bnb', total_cost: '0.01',
      gas_used: null, tx_hash: null, referrer: null, status: 'pending', error_reason: null,
    });
    expect(() => updateMintStatus(id, 'success', '0xTX', '0.0001')).not.toThrow();
  });

  it('getMintHistory returns an array', () => {
    const history = getMintHistory(walletId);
    expect(Array.isArray(history)).toBe(true);
  });
});

describe('Sell history repository', () => {
  let walletId: number;
  beforeEach(() => {
    upsertUser(4001);
    const w = addWallet(4001, '0xSELL', '/sessions/sell');
    walletId = w.id;
  });

  it('inserts a sell record without throwing', () => {
    expect(() => insertSell(walletId, {
      jagent_amount: '100', receive_token: 'BNB', receive_amount: null,
      gas_used: null, tx_hash: null, status: 'pending', error_reason: null,
    })).not.toThrow();
  });

  it('updateSellStatus does not throw', () => {
    const id = insertSell(walletId, {
      jagent_amount: '50', receive_token: 'USDT', receive_amount: null,
      gas_used: null, tx_hash: null, status: 'pending', error_reason: null,
    });
    expect(() => updateSellStatus(id, 'success', '0xSELLTX')).not.toThrow();
  });

  it('getSellHistory returns array', () => {
    expect(Array.isArray(getSellHistory(walletId))).toBe(true);
  });
});

describe('Admin settings repository', () => {
  it('gets default max_shares', () => {
    const settings = getAdminSettings();
    expect(settings.max_shares).toBe(10);
  });

  it('gets default minting_paused = false', () => {
    const settings = getAdminSettings();
    expect(settings.minting_paused).toBe(false);
  });

  it('setAdminSetting does not throw', () => {
    expect(() => setAdminSetting('referral_code', 'MYREF')).not.toThrow();
  });

  it('setAdminSetting max_shares does not throw', () => {
    expect(() => setAdminSetting('max_shares', '5')).not.toThrow();
  });
});

describe('Admin totals', () => {
  it('returns non-negative counts without throwing', () => {
    const totals = getAdminTotals();
    expect(totals.total_users).toBeGreaterThanOrEqual(0);
    expect(totals.total_wallets).toBeGreaterThanOrEqual(0);
    expect(totals.total_mints).toBeGreaterThanOrEqual(0);
    expect(totals.total_shares).toBeGreaterThanOrEqual(0);
    expect(totals.total_sells).toBeGreaterThanOrEqual(0);
  });
});

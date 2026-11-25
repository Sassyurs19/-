# JAGENT Mint Bot

> A production-ready Telegram bot that helps users mint \$JAGENT on [jager.live](https://jager.live) using their Binance Agentic Wallet. Mobile-first clean button UI, English + Telugu language toggle.

---

## Features

- 🔗 **Wallet Connect via QR** — `baw auth signin` / `auth verify` with isolated, encrypted session dirs per wallet
- 🔍 **6 Eligibility Checks** — Agent ID, Developer Mode, previous mints (API + on-chain), quota, USDT, BNB
- 🪙 **Mint Flow** — picks shares (1–10), pay method (USDT/BNB), shows exact cost card, Confirm-only execution
- 💰 **Sell Flow** — JAGENT → BNB/USDT with 5% max slippage, Confirm-only
- 🛡️ **Contract Address Guard** — aborts if API returns any address ≠ `0x3643A907f875fA9B740e1C0747E91b5aA5222aB8`
- 📋 **SQLite History** — full mint/sell/check history with CSV export
- 🌐 **English + Telugu** language toggle per user
- 🔧 **Admin panel** — `/admin` to set referral code, max shares, pause minting, view totals
- ☁️ **Render-ready** — single `Dockerfile`, `render.yaml`, persistent disk for SQLite + sessions

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 |
| Language | TypeScript 5 |
| Telegram | grammY v1 |
| Wallet | @binance/agentic-wallet (baw CLI) |
| Database | SQLite via better-sqlite3 |
| Blockchain read | ethers v6 (BSC RPC) |
| HTTP | axios + axios-retry + bottleneck |
| Crypto | Node.js built-in AES-256-GCM |
| Tests | Jest + ts-jest |
| Deploy | Render (Free/Starter plan) |

---

## Prerequisites

- Node.js ≥ 22
- `baw` CLI ≥ 1.12.0: `npm install -g @binance/agentic-wallet@1.12.0`
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Your Telegram User ID (from [@userinfobot](https://t.me/userinfobot))
- An admin referral code from jager.live

---

## Local Development

### 1. Clone & install

```bash
git clone <your-repo-url>
cd jagent-telegram-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=123456789
ADMIN_REF=YOUR_REFERRAL_CODE
ENCRYPTION_KEY=<64 hex chars>  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JAGER_API_BASE=https://jager.live/api
BSC_RPC_URL=https://bsc-rpc.publicnode.com
BOT_TIMEZONE=Asia/Kolkata
DB_PATH=./data/jagent.db
SESSIONS_DIR=./sessions
LOG_LEVEL=info
NODE_ENV=development
```

### 3. Run in dev mode

```bash
npm run dev
```

### 4. Run tests

```bash
npm test
```

---

## Render Deployment

### Step 1: Create a new Render Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo

### Step 2: Configure the service

| Setting | Value |
|---------|-------|
| **Name** | `jagent-bot` |
| **Region** | Pick closest to your users |
| **Branch** | `main` |
| **Build Command** | `npm install && npm install -g @binance/agentic-wallet@1.12.0 && npm run build` |
| **Start Command** | `npm start` |
| **Plan** | Starter (\$7/mo) for persistent disk |

### Step 3: Add environment variables

In Render dashboard → **Environment**:

```
BOT_TOKEN          = <your bot token>
ADMIN_ID           = <your telegram id>
ADMIN_REF          = <your referral code>
ENCRYPTION_KEY     = <64 char hex>
JAGER_API_BASE     = https://jager.live/api
BSC_RPC_URL        = https://bsc-rpc.publicnode.com
BOT_TIMEZONE       = Asia/Kolkata
DB_PATH            = /data/jagent.db
SESSIONS_DIR       = /data/sessions
LOG_LEVEL          = info
NODE_ENV           = production
```

### Step 4: Add Persistent Disk

In Render → **Disks** → Add disk:
- **Mount Path**: `/data`
- **Size**: 1 GB (plenty for SQLite + sessions)

This ensures your database and wallet sessions survive restarts.

### Step 5: Deploy

Click **Deploy** — Render will build and start the bot.

> **Note**: On the free Render plan, the service sleeps after 15 min inactivity. Use the **Starter** plan for 24/7 uptime.

---

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Env config & constants
├── i18n/
│   └── index.ts          # English + Telugu translations
├── core/
│   ├── logger.ts         # Winston logger
│   ├── errors.ts         # Custom error types
│   └── crypto.ts         # AES-256-GCM file/dir encryption
├── db/
│   ├── schema.ts         # SQLite schema + migrations
│   └── repository.ts     # All DB operations
├── wallet/
│   └── baw.ts            # baw CLI wrapper (all commands)
├── jager/
│   ├── api.ts            # jager.live REST API client
│   ├── rpc.ts            # Resilient BSC RPC fallback + gas + receipt parser
│   ├── eligibility.ts    # 6 eligibility checks + on-chain scan
│   ├── mint.ts           # Mint flow + contract address guard
│   ├── rewards.ts        # $1+ invite/mint USDT rewards auto & manual claim
│   └── sell.ts           # Sell flow (quote + swap + order polling)
├── bot/
│   ├── middleware.ts     # grammY session + user middleware
│   ├── keyboards.ts      # All inline keyboards
│   └── handlers/
│       ├── start.ts      # /start, connect wallet flow
│       ├── wallets.ts    # My wallets, check, disconnect, CSV
│       ├── mint.ts       # Mint flow handlers
│       └── sell.ts       # Sell flow handlers
└── admin/
    └── admin.ts          # /admin command + panel
```

---

## Security Design

| Concern | Mitigation |
|---------|------------|
| Private keys | Never touched — all signing happens in Binance App |
| Session isolation | Each wallet gets a separate `BINANCE_BAW_DIR` + `BINANCE_INSTANCE_ID` with keytar bypass |
| Session encryption | AES-256-GCM encrypts session dir at rest between CLI calls |
| Session cleanup | `baw auth signout` + `rmSync` on disconnect or failure |
| Contract address spoofing | Hard-coded expected address `0x3643...aB8`, abort on mismatch |
| Token contract guard | Explicitly blocks sending to JAGENT token `0x8e64...` |
| Credential logging | Never logged, session tokens redacted from debug logs |
| Admin-only commands | Telegram user ID check for all `/admin` actions |
| Confirm-only | Every on-chain action requires explicit Confirm tap |
| Rate limiting | Bottleneck limiter on all jager.live API calls |

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/admin` | Admin panel (admin only) |

---

## Admin Panel

Send `/admin` as the bot owner to:
- Set the referral code used for all mints
- Set the global maximum shares per mint (1–10)
- Pause or resume minting for all users
- View aggregate totals (users, wallets, mints, shares, sells)

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `ADMIN_ID` | ✅ | Your Telegram user ID |
| `ADMIN_REF` | ✅ | Default referral code for mints |
| `ENCRYPTION_KEY` | ✅ | 64-hex-char key for session encryption |
| `JAGER_API_BASE` | — | jager.live API base URL |
| `BSC_RPC_URL` | — | BSC JSON-RPC URL |
| `DB_PATH` | — | SQLite file path |
| `SESSIONS_DIR` | — | Wallet session directory |
| `LOG_LEVEL` | — | `error`/`warn`/`info`/`debug` |
| `NODE_ENV` | — | `production` or `development` |
| `API_MAX_RETRIES` | — | Max API retry attempts (default: 3) |
| `JAGER_RATE_LIMIT_RPM` | — | Max API calls/min to jager.live |

---

## Important Notes

> ⚠️ **Referral rewards**: Wallets owned by the same person may not receive referral rewards from jager.live. This notice is shown to users before every mint.

> 🔒 **Developer Mode**: Users must enable Developer Mode in Binance App → Agentic Wallet → Settings before minting. It stays active for 7 days per use.

> 💡 **On free-plan Render**: Bot restarts when the dyno spins up; existing connected wallets in SQLite are preserved on the persistent disk but baw sessions need to be re-authenticated by users since in-memory session state is lost.

---

## Running Tests

```bash
npm test                # Run all tests
npm run test:watch     # Watch mode
```

Test coverage:
- ✅ Contract address guard (exhaustive: 10+ cases)
- ✅ All 6 eligibility check logics
- ✅ USDT cost calculation with 1.02× buffer
- ✅ BNB gas threshold
- ✅ Developer Mode expiry logic
- ✅ Error class hierarchy

---

## License

MIT

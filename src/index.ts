// src/index.ts
// Main entry point: initializes DB, Render HTTP healthcheck server, and grammY bot
import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Bot, GrammyError, HttpError } from 'grammy';
import { JagentContext, setupMiddleware } from './bot/middleware';
import { registerStartHandlers } from './bot/handlers/start';
import { registerWalletHandlers } from './bot/handlers/wallets';
import { registerMintHandlers } from './bot/handlers/mint';
import { registerSellHandlers } from './bot/handlers/sell';
import { registerAdminHandlers } from './admin/admin';
import { getDb } from './db/schema';
import { config } from './config';
import { logger } from './core/logger';

// Ensure required directories exist
for (const dir of [path.dirname(config.dbPath), config.sessionsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Initialize DB
getDb();

// Initialize bot
const bot = new Bot<JagentContext>(config.botToken);

// Disable intrusive Telegram web link preview cards globally across all messages
bot.api.config.use((prev, method, payload, signal) => {
  if ((method === 'sendMessage' || method === 'editMessageText') && payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (!p.link_preview_options) {
      p.link_preview_options = { is_disabled: true };
    }
  }
  return prev(method, payload, signal);
});

// Middleware
setupMiddleware(bot);

// Register all handlers
registerStartHandlers(bot);
registerWalletHandlers(bot);
registerMintHandlers(bot);
registerSellHandlers(bot);
registerAdminHandlers(bot);

// Global error handler
bot.catch((err) => {
  const ctx = err.ctx;
  logger.error('Bot error', {
    updateId: ctx.update.update_id,
    error: err.error instanceof Error ? err.error.message : String(err.error),
  });

  if (err.error instanceof GrammyError) {
    logger.error('grammY error', { description: err.error.description });
  } else if (err.error instanceof HttpError) {
    logger.error('HTTP error', { error: err.error.message });
  }

  ctx.reply('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
});

// Lightweight HTTP server for Render web service health checks (healthCheckPath: /)
let healthServer: http.Server | null = null;
if (config.port > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'jagent-telegram-bot' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(config.port, '0.0.0.0', () => {
    logger.info('Healthcheck HTTP server listening', { port: config.port });
  });
}

// Start bot
logger.info('Starting JAGENT bot...', { nodeEnv: config.nodeEnv });

bot.start({
  onStart: (botInfo) => {
    logger.info(`Bot @${botInfo.username} started!`);
    void bot.api
      .setMyCommands([
        { command: 'start', description: 'Open ＪＡＧΞＲ terminal' },
        { command: 'help', description: 'Quick guide & requirements' },
        { command: 'language', description: 'Switch English / తెలుగు' },
      ])
      .catch(() => {});
    void bot.api
      .setMyCommands(
        [
          { command: 'start', description: 'Open ＪＡＧΞＲ terminal' },
          { command: 'help', description: 'Quick guide & requirements' },
          { command: 'language', description: 'Switch English / తెలుగు' },
          { command: 'admin', description: 'Admin console' },
        ],
        { scope: { type: 'chat', chat_id: config.adminId } }
      )
      .catch(() => {});
  },
  drop_pending_updates: config.nodeEnv === 'production',
  allowed_updates: ['message', 'callback_query'],
}).catch((err) => {
  logger.error('Fatal bot polling error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, stopping bot...`);
  if (healthServer) {
    healthServer.close();
    healthServer.closeAllConnections?.();
  }
  await Promise.race([
    bot.stop().catch(() => {}),
    new Promise((r) => setTimeout(r, 3_000)),
  ]);
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

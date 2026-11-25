// src/bot/sessionLifecycle.ts
// Manages:
// 1. Auto-deleting transient/superseded Telegram messages (QR, loading, wait banners)
// 2. 20-minute wallet session completion timers (auto-logout if mint not completed)
// 3. Visual progress bar rendering for minting
import { Api } from 'grammy';
import { config } from '../config';
import { logger } from '../core/logger';
import { esc, Lang } from '../i18n';
import { formatClockInTz } from '../jager/eligibility';
import { logoutAndWipeSession } from '../wallet/baw';

// ---- Welcome / Ephemeral Screen Cleanup ----

const welcomeMessages = new Map<number, number>();

/** Track the active welcome/help card in a chat so it disappears automatically on next input */
export function trackWelcomeMsg(chatId: number, messageId: number): void {
  welcomeMessages.set(chatId, messageId);
}

/** Stop treating a message as disposable welcome once edited in-place into Status/Wallets */
export function untrackWelcomeMsg(chatId: number, messageId?: number): void {
  const tracked = welcomeMessages.get(chatId);
  if (tracked !== undefined && (messageId === undefined || tracked === messageId)) {
    welcomeMessages.delete(chatId);
  }
}

/** Delete the active welcome/help card in a chat (best-effort) */
export async function clearWelcomeMsg(api: Api, chatId: number): Promise<void> {
  const id = welcomeMessages.get(chatId);
  if (id === undefined) return;
  welcomeMessages.delete(chatId);
  await api.deleteMessage(chatId, id).catch(() => {});
}

// ---- Transient Message Cleanup ----

const transientMessages = new Map<number, number[]>();

/** Track a transient message ID (e.g. loading spinner, QR, wait notice) for a chat */
export function trackTransientMsg(chatId: number, messageId: number): void {
  const list = transientMessages.get(chatId) ?? [];
  list.push(messageId);
  transientMessages.set(chatId, list);
}

/** Delete all currently tracked transient messages in a chat, keeping important cards intact */
export async function clearTransientMsgs(api: Api, chatId: number): Promise<void> {
  const ids = transientMessages.get(chatId);
  if (!ids || ids.length === 0) return;
  transientMessages.delete(chatId);

  await Promise.all(
    ids.map((id) => api.deleteMessage(chatId, id).catch(() => {}))
  );
}

// ---- 20-Minute Session Completion Timer ----

interface ActiveSessionTimer {
  walletId: number;
  chatId: number;
  address: string;
  walletLabel?: string | null;
  sessionDir: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const activeWalletTimers = new Map<number, ActiveSessionTimer>();

export function getSessionTimeoutMs(): number {
  return Math.max(1, config.sessionTimeoutMinutes) * 60 * 1000;
}

/**
 * Start a 20-minute countdown timer for an unminted wallet if one isn't already running.
 * Returns the expiry timestamp (ms).
 */
export function ensureSessionTimer(params: {
  api: Api;
  walletId: number;
  chatId: number;
  address: string;
  walletLabel?: string | null;
  sessionDir: string;
  lang: Lang;
  onAutoLogout?: () => void;
}): number {
  const existing = activeWalletTimers.get(params.walletId);
  if (existing && existing.expiresAt > Date.now()) {
    existing.sessionDir = params.sessionDir;
    existing.chatId = params.chatId;
    if (params.walletLabel) existing.walletLabel = params.walletLabel;
    return existing.expiresAt;
  }

  if (existing) clearTimeout(existing.timer);

  const timeoutMs = getSessionTimeoutMs();
  const expiresAt = Date.now() + timeoutMs;

  const timer = setTimeout(() => {
    void handleSessionTimeout(params.api, params.walletId, params.lang, params.onAutoLogout);
  }, timeoutMs);
  timer.unref();

  activeWalletTimers.set(params.walletId, {
    walletId: params.walletId,
    chatId: params.chatId,
    address: params.address,
    walletLabel: params.walletLabel,
    sessionDir: params.sessionDir,
    expiresAt,
    timer,
  });

  logger.info('Started 20-min wallet session timer', {
    walletId: params.walletId,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  return expiresAt;
}

async function handleSessionTimeout(
  api: Api,
  walletId: number,
  lang: Lang,
  onAutoLogout?: () => void
): Promise<void> {
  const entry = activeWalletTimers.get(walletId);
  if (!entry) return;
  activeWalletTimers.delete(walletId);

  logger.info('20-min wallet session expired, logging out', { walletId });
  await logoutAndWipeSession(entry.sessionDir);
  if (onAutoLogout) onAutoLogout();

  const short = `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`;
  const walletTag = entry.walletLabel
    ? `<b>${esc(entry.walletLabel)}</b> · <code>${esc(short)}</code>`
    : `<code>${esc(short)}</code>`;
  const msg =
    lang === 'te'
      ? `🔒 <b>సెషన్ లాగ్‌అవుట్ అయింది</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>వాలెట్</b> — ${walletTag}\n• <b>కారణం</b> — ${config.sessionTimeoutMinutes} నిమిషాల్లో మింటింగ్ పూర్తి కాలేదు.</blockquote>\n\n<b>కొనసాగడానికి + కొత్త వాలెట్ నొక్కండి.</b>`
      : `🔒 <b>Session Logged Out</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Wallet</b> — ${walletTag}\n• <b>Reason</b> — ${config.sessionTimeoutMinutes}-min window expired before minting.</blockquote>\n\n<b>Reconnect anytime via + Connect Wallet.</b>`;

  await api.sendMessage(entry.chatId, msg, { parse_mode: 'HTML' }).catch(() => {});
}

export function getSessionExpiryMs(walletId: number): number | null {
  const entry = activeWalletTimers.get(walletId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.expiresAt;
}

export function formatRemainingWindow(expiresAtMs: number): string {
  const remMs = Math.max(0, expiresAtMs - Date.now());
  const mins = Math.ceil(remMs / 60_000);
  const untilStr = formatClockInTz(expiresAtMs, false).slice(0, 5);
  return `${mins}m left · ${untilStr}`;
}

export function clearSessionTimer(walletId: number): void {
  const entry = activeWalletTimers.get(walletId);
  if (!entry) return;
  clearTimeout(entry.timer);
  activeWalletTimers.delete(walletId);
}

// ---- Visual Loading Bar ----

export function renderProgressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `<code>[${'█'.repeat(filled)}${'░'.repeat(empty)}]</code> <b>${clamped}%</b>`;
}

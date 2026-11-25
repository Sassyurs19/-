// src/bot/handlers/wallets.ts
// Connected wallets, Refresh eligibility (20-min timer for unminted wallets & immediate logout if already minted),
// live Status + history screen, and Disconnect.
import fs from 'fs';
import { Bot } from 'grammy';
import { JagentContext } from '../middleware';
import { esc, t } from '../../i18n';
import {
  backToMainKeyboard,
  statusDetailKeyboard,
  statusWalletsKeyboard,
  walletActionsKeyboard,
  walletListKeyboard,
} from '../keyboards';
import {
  deactivateWallet,
  getUserWallets,
  getWallet,
  getWalletFullHistory,
  saveEligibilityCheck,
  updateWalletAgentId,
  updateWalletLastCheck,
} from '../../db/repository';
import { bawStatus, logoutAndWipeSession } from '../../wallet/baw';
import { getAgentStatus } from '../../jager/api';
import {
  calcUsdtNeeded,
  formatClockInTz,
  formatEligibilityChecks,
  formatShortTimestamp,
  runEligibilityChecks,
} from '../../jager/eligibility';
import {
  clearSessionTimer,
  ensureSessionTimer,
  formatRemainingWindow,
  getSessionExpiryMs,
} from '../sessionLifecycle';
import { logger } from '../../core/logger';
import { config } from '../../config';
import { checkUserCooldown } from '../../core/rateLimit';

async function isWalletSessionConnected(sessionDir: string): Promise<boolean> {
  if (!sessionDir || !fs.existsSync(sessionDir)) return false;
  try {
    const res = await bawStatus(sessionDir);
    return res.success && res.data.status === 'CONNECTED';
  } catch {
    return false;
  }
}

export function formatCleanNum(val: string | number | null | undefined, decimals = 4): string {
  if (val === null || val === undefined || val === '') return '0';
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (!Number.isFinite(n)) return String(val);
  if (n === 0) return '0';
  const fixed = Math.abs(n) < 0.0001 && decimals < 6 ? n.toFixed(6) : n.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

async function editOrReplyHtml(
  ctx: JagentContext,
  text: string,
  replyMarkup?: import('grammy').InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('message is not modified')) return;
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }).catch(() => {});
  }
}

export async function formatWalletStatusReport(walletId: number): Promise<string> {
  const wallet = getWallet(walletId);
  if (!wallet) return '❌ <b>Wallet not found.</b>';

  const history = getWalletFullHistory(walletId);
  const [connected, liveStatus] = await Promise.all([
    isWalletSessionConnected(wallet.session_dir),
    getAgentStatus(wallet.address).catch(() => null),
  ]);

  if (liveStatus?.agentId && liveStatus.agentId !== wallet.agent_id) {
    updateWalletAgentId(wallet.id, liveStatus.agentId);
  }

  const walletName = wallet.label ?? 'Wallet';
  const expiryMs = connected ? getSessionExpiryMs(walletId) : null;
  const shortAddr = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
  const agentName = liveStatus?.agentId ?? wallet.agent_id ?? 'None';
  const updatedTime = formatClockInTz(Date.now(), false);
  const statusStr = connected
    ? `🟢 Live${expiryMs ? ` (${formatRemainingWindow(expiryMs)})` : ''}`
    : '🔒 Logged out';

  const overviewRows: string[] = [
    `• <b>Address</b> — <code>${esc(shortAddr)}</code>`,
    `• <b>Agent ID</b> — <code>${esc(agentName)}</code>`,
    `• <b>Status</b> — <b>${esc(statusStr)}</b>`,
    `• <b>Linked</b> — <b>${esc(formatShortTimestamp(wallet.connected_at, true))}</b>`,
  ];

  if (liveStatus) {
    const bnb = liveStatus.balances ? formatCleanNum(liveStatus.balances.bnb, 6) : '?';
    const usdt = liveStatus.balances ? formatCleanNum(liveStatus.balances.usdt, 2) : '?';
    const jagent = liveStatus.balances ? formatCleanNum(liveStatus.balances.jagent, 2) : '?';

    overviewRows.push(
      `• <b>JAGENT</b> — <code>${esc(jagent)}</code> · <b>USDT</b> — <code>${esc(usdt)}</code>`,
      `• <b>BNB</b> — <code>${esc(bnb)}</code>`,
      `• <b>Quota</b> — <b>${liveStatus.mint?.remaining ?? 0} left</b> (${liveStatus.mint?.minted ?? 0}/${liveStatus.mint?.quota ?? 0})`
    );

    if (liveStatus.invite) {
      overviewRows.push(
        `• <b>Invites</b> — <b>${liveStatus.invite.invited}</b> joined · <b>${liveStatus.invite.reachedTenShares}</b> valid`,
        `• <b>Rewards</b> — <code>${esc(liveStatus.invite.pendingUsdt ?? '0')}</code> pend · <code>${esc(liveStatus.invite.paidUsdt ?? '0')}</code> paid`
      );
    }
  } else {
    overviewRows.push(`• <b>Live Data</b> — Unavailable (showing saved history)`);
  }

  // Action history for this wallet — mints, sells, rewards on crisp single lines
  const historyRows: string[] = [`<b>📋 History · ${esc(walletName)}</b>`];

  const mintsOk = history.mints.filter((m) => m.status === 'success').length;
  const mintsFail = history.mints.filter((m) => m.status === 'failed').length;
  if (history.mints.length === 0) {
    historyRows.push('• <b>Mints</b> — None yet');
  } else {
    historyRows.push(`• <b>Mints</b> — <b>${mintsOk}</b> ok · <b>${mintsFail}</b> failed`);
    for (const m of history.mints.slice(0, 3)) {
      const icon = m.status === 'success' ? '✅' : m.status === 'failed' ? '❌' : '⏳';
      const txLink = m.tx_hash ? ` · <a href="https://bscscan.com/tx/${esc(m.tx_hash)}">TX</a>` : '';
      const when = formatShortTimestamp(m.minted_at, true).split(',')[0] ?? '';
      historyRows.push(`  ${icon} <b>${m.shares} sh</b> · ${esc(m.pay_method.toUpperCase())} · ${esc(when)}${txLink}`);
      if (m.error_reason) {
        historyRows.push(`    ↳ ${esc(m.error_reason.slice(0, 50))}`);
      }
    }
  }

  const sellsOk = history.sells.filter((s) => s.status === 'success').length;
  const sellsFail = history.sells.filter((s) => s.status === 'failed').length;
  if (history.sells.length === 0) {
    historyRows.push('• <b>Sells</b> — None yet');
  } else {
    historyRows.push(`• <b>Sells</b> — <b>${sellsOk}</b> ok · <b>${sellsFail}</b> failed`);
    for (const s of history.sells.slice(0, 3)) {
      const icon = s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏳';
      const txLink = s.tx_hash ? ` · <a href="https://bscscan.com/tx/${esc(s.tx_hash)}">TX</a>` : '';
      historyRows.push(
        `  ${icon} <code>${esc(formatCleanNum(s.jagent_amount, 0))}</code> → <code>${esc(formatCleanNum(s.receive_amount, 4))} ${esc(s.receive_token)}</code>${txLink}`
      );
      if (s.error_reason) {
        historyRows.push(`    ↳ ${esc(s.error_reason.slice(0, 50))}`);
      }
    }
  }

  const rewardsOk = (history.rewards ?? []).filter((r) => r.status === 'success');
  if (rewardsOk.length === 0) {
    historyRows.push('• <b>Rewards</b> — None yet');
  } else {
    historyRows.push(`• <b>Rewards (${rewardsOk.length})</b>`);
    for (const r of rewardsOk.slice(0, 3)) {
      const txLink = r.tx_hash ? ` · <a href="https://bscscan.com/tx/${esc(r.tx_hash)}">TX</a>` : '';
      const when = formatShortTimestamp(r.claimed_at, true).split(',')[0] ?? '';
      historyRows.push(`  🎁 <code>+${esc(r.amount_usdt)} USDT</code> · ${esc(when)}${txLink}`);
    }
  }

  const lines: string[] = [
    `<b>✦ ＪＡＧΞＲ · ${esc(walletName)}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<blockquote>${overviewRows.join('\n')}</blockquote>`,
    `<blockquote>${historyRows.join('\n')}</blockquote>`,
    `⏱ <b>Updated:</b> ${esc(updatedTime)}`,
  ];

  // Keep cleanly under Telegram's 4096-char cap
  const full = lines.join('\n');
  return full.length > 3950 ? full.slice(0, 3900) + '\n...</blockquote>' : full;
}

export function registerWalletHandlers(bot: Bot<JagentContext>): void {
  // My wallets list
  bot.callbackQuery('my_wallets', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = ctx.session.lang;
    const wallets = getUserWallets(ctx.from!.id);

    if (!wallets.length) {
      await editOrReplyHtml(ctx, t('no_wallets', lang), walletListKeyboard([], lang));
      return;
    }

    const lines = wallets.map((w) => {
      const name = w.label ?? 'Wallet';
      const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
      const lastCheck = w.last_check_at ? formatShortTimestamp(w.last_check_at, true) : 'Never';
      const checkIcon = w.last_check_ok === null ? '❓' : w.last_check_ok ? '✅' : '❌';
      const agent = w.agent_id ? ` · <code>${esc(w.agent_id)}</code>` : '';
      return `${checkIcon} <b>${esc(name)}</b> · <code>${esc(short)}</code>${agent}\n   <b>Checked:</b> ${esc(lastCheck)}`;
    });

    await editOrReplyHtml(
      ctx,
      `<b>✦ ＪＡＧΞＲ · Connected Wallets</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>${lines.join('\n\n')}</blockquote>`,
      walletListKeyboard(wallets, lang)
    );
  });

  // Select a specific wallet
  bot.callbackQuery(/^wallet_select:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const lang = ctx.session.lang;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.reply('❌ <b>Wallet not found.</b>', { parse_mode: 'HTML' });
      return;
    }

    const walletName = wallet.label ?? 'Wallet';
    const short = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
    const connected = await isWalletSessionConnected(wallet.session_dir);
    const expiryMs = connected ? getSessionExpiryMs(walletId) : null;
    const lastCheck = wallet.last_check_at ? formatShortTimestamp(wallet.last_check_at, true) : 'Never';
    const checkIcon = wallet.last_check_ok === null ? '❓' : wallet.last_check_ok ? '✅' : '❌';

    await editOrReplyHtml(
      ctx,
      `<b>✦ ＪＡＧΞＲ · ${esc(walletName)}</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>• <b>Address</b> — <code>${esc(short)}</code>\n` +
        `• <b>Agent ID</b> — <code>${esc(wallet.agent_id ?? 'N/A')}</code>\n` +
        `• <b>Session</b> — <b>${connected ? '🟢 Connected' : '🔒 Logged out'}</b>${expiryMs ? ` (${esc(formatRemainingWindow(expiryMs))})` : ''}\n` +
        `• <b>Last Check</b> — ${checkIcon} <b>${esc(lastCheck)}</b></blockquote>`,
      walletActionsKeyboard(walletId, lang, connected, {
        canMint: wallet.last_check_ok === 1,
      })
    );
  });

  // Refresh / Check again
  bot.callbackQuery(/^check:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'check', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Please wait a moment...' });
      return;
    }
    await ctx.answerCallbackQuery('Refreshing checks...');
    const walletId = parseInt(ctx.match[1], 10);
    const chatId = ctx.chat!.id;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.reply('❌ <b>Wallet not found.</b>', { parse_mode: 'HTML' });
      return;
    }

    await ctx.editMessageText('🔍 <b>Refreshing eligibility checks...</b>', {
      parse_mode: 'HTML',
    }).catch(() => {});

    try {
      const eligResult = await runEligibilityChecks(wallet.address, wallet.session_dir);
      const usdtNeeded = calcUsdtNeeded(eligResult.priceUsdtPerShare, eligResult.sharesPerMint);

      if (eligResult.agentId) updateWalletAgentId(walletId, eligResult.agentId);
      updateWalletLastCheck(walletId, eligResult.allPassed);
      saveEligibilityCheck(walletId, {
        agent_id_ok: eligResult.agentId ? 1 : 0,
        agent_id_val: eligResult.agentId,
        devmode_ok: eligResult.checks.find((c) => c.name === 'check_devmode')?.passed ? 1 : 0,
        devmode_expiry: eligResult.devModeExpiry,
        prev_mint_ok: eligResult.prevMint.minted ? 1 : 0,
        prev_shares: eligResult.prevMint.shares,
        prev_date: eligResult.prevMint.date,
        prev_txs: JSON.stringify(eligResult.prevMint.txHashes),
        quota_remaining: eligResult.quotaRemaining,
        usdt_balance: eligResult.usdtBalance,
        usdt_needed: usdtNeeded,
        bnb_balance: eligResult.bnbBalance,
        bnb_ok: parseFloat(eligResult.bnbBalance) >= config.MIN_BNB_GAS ? 1 : 0,
        all_ok: eligResult.allPassed ? 1 : 0,
      });

      if (eligResult.alreadyMinted) {
        clearSessionTimer(walletId);
        if (eligResult.sessionConnected) {
          await logoutAndWipeSession(wallet.session_dir);
        }
        const checksText = formatEligibilityChecks(
          eligResult,
          (k, ...a) => t(k, lang, ...a),
          undefined,
          wallet.label
        );
        const reason = `${wallet.label ?? 'This wallet'} already minted before (${eligResult.prevMint.shares || '?'} shares).`;
        await editOrReplyHtml(
          ctx,
          `${checksText}\n\n${t('session_logged_out_minted', lang, reason)}`,
          walletActionsKeyboard(walletId, lang, false, { alreadyMinted: true })
        );
        return;
      }

      let timerNote: string | undefined;
      if (eligResult.sessionConnected) {
        const expiresAt = ensureSessionTimer({
          api: bot.api,
          walletId,
          chatId,
          address: wallet.address,
          walletLabel: wallet.label,
          sessionDir: wallet.session_dir,
          lang,
        });
        timerNote = `20-min window: ${formatRemainingWindow(expiresAt)}`;
      }

      const checksText = formatEligibilityChecks(
        eligResult,
        (k, ...a) => t(k, lang, ...a),
        timerNote,
        wallet.label
      );

      await editOrReplyHtml(
        ctx,
        checksText,
        walletActionsKeyboard(walletId, lang, eligResult.sessionConnected, {
          alreadyMinted: false,
          canMint: eligResult.allPassed,
        })
      );
    } catch (err) {
      logger.error('Check again error', { err });
      await editOrReplyHtml(
        ctx,
        t('error_generic', lang, err instanceof Error ? err.message : String(err)),
        walletActionsKeyboard(walletId, lang, false)
      );
    }
  });

  // Disconnect / manual logout
  bot.callbackQuery(/^disconnect:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const lang = ctx.session.lang;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id) {
      await ctx.reply('❌ <b>Wallet not found.</b>', { parse_mode: 'HTML' });
      return;
    }

    clearSessionTimer(walletId);
    await logoutAndWipeSession(wallet.session_dir);
    deactivateWallet(walletId);

    const walletName = wallet.label ?? 'Wallet';
    const short = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
    await editOrReplyHtml(
      ctx,
      `🔒 <b>Session Logged Out</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Wallet</b> — <b>${esc(walletName)}</b> · <code>${esc(short)}</code>\n• <b>Reason</b> — Disconnected by user.</blockquote>`,
      backToMainKeyboard(lang)
    );
  });

  // Status menu
  bot.callbackQuery('status_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = ctx.session.lang;
    const wallets = getUserWallets(ctx.from!.id);

    if (!wallets.length) {
      await editOrReplyHtml(ctx, t('no_wallets', lang), backToMainKeyboard(lang));
      return;
    }

    if (wallets.length === 1) {
      await ctx.editMessageText('⏳ <b>Loading live wallet status...</b>', {
        parse_mode: 'HTML',
      }).catch(() => {});
      const report = await formatWalletStatusReport(wallets[0].id);
      await editOrReplyHtml(ctx, report, statusDetailKeyboard(wallets[0].id, lang, true));
      return;
    }

    const lines = wallets.map((w) => {
      const name = w.label ?? 'Wallet';
      const short = `<code>${esc(w.address.slice(0, 6))}...${esc(w.address.slice(-4))}</code>`;
      const history = getWalletFullHistory(w.id);
      const successMints = history.mints.filter((m) => m.status === 'success');
      const totalShares = successMints.reduce((s, m) => s + m.shares, 0);
      const successSells = history.sells.filter((s) => s.status === 'success').length;
      const agentTxt = w.agent_id ? ` · <code>${esc(w.agent_id)}</code>` : '';
      return `👛 <b>${esc(name)}</b> · ${short}${agentTxt}\n   Mints: <b>${successMints.length}</b> (${totalShares} sh) · Sells: <b>${successSells}</b>`;
    });

    await editOrReplyHtml(
      ctx,
      `${t('status_title', lang)}\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>${lines.join('\n\n')}</blockquote>\n\n<b>Select a wallet for live status &amp; history:</b>`,
      statusWalletsKeyboard(wallets, lang)
    );
  });

  // Per-wallet live status + Refresh
  bot.callbackQuery(/^status_wallet:(\d+)$/, async (ctx) => {
    if (!checkUserCooldown(ctx.from!.id, 'status_wallet', 1500)) {
      await ctx.answerCallbackQuery({ text: 'Refreshing...' });
      return;
    }
    await ctx.answerCallbackQuery('Fetching live data...');
    const lang = ctx.session.lang;
    const walletId = parseInt(ctx.match[1], 10);
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.reply('❌ <b>Wallet not found.</b>', { parse_mode: 'HTML' });
      return;
    }

    const report = await formatWalletStatusReport(walletId);
    await editOrReplyHtml(ctx, report, statusDetailKeyboard(walletId, lang, false));
  });
}

// src/bot/handlers/start.ts
// /start menu, language toggle, help, and clean non-blocking QR wallet connect flow
import { Bot, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { JagentContext } from '../middleware';
import { esc, Lang, t } from '../../i18n';
import {
  backToMainKeyboard,
  connectCancelKeyboard,
  mainMenuKeyboard,
  walletActionsKeyboard,
} from '../keyboards';
import { checkUserCooldown } from '../../core/rateLimit';
import { config } from '../../config';
import {
  bawAddress,
  bawSignin,
  bawStatus,
  bawVerify,
  BawSigninResult,
  getSessionDir,
  logoutAndWipeSession,
  promoteSessionDir,
} from '../../wallet/baw';
import {
  addWallet,
  saveEligibilityCheck,
  setUserLang,
  updateWalletAgentId,
  updateWalletLastCheck,
  upsertUser,
} from '../../db/repository';
import { logger } from '../../core/logger';
import { wipeDir } from '../../core/crypto';
import {
  calcUsdtNeeded,
  formatEligibilityChecks,
  formatTimestampInTz,
  runEligibilityChecks,
} from '../../jager/eligibility';
import {
  clearSessionTimer,
  clearTransientMsgs,
  clearWelcomeMsg,
  ensureSessionTimer,
  formatConnectProgressCard,
  formatRemainingWindow,
  trackTransientMsg,
  trackWelcomeMsg,
  untrackTransientMsg,
} from '../sessionLifecycle';

// Track active background verify tasks per user so [Cancel] stops them immediately
const activeConnectAborts = new Map<
  number,
  { qrCodeId: string; sessionDir: string; abort: AbortController }
>();

export function registerStartHandlers(bot: Bot<JagentContext>): void {
  // /start command — replaces any previous welcome & clears transient/pending QR state
  bot.command('start', async (ctx) => {
    ctx.session.pendingMint = undefined;
    ctx.session.pendingSell = undefined;
    ctx.session.adminAwait = undefined;
    if (ctx.from) {
      const entry = activeConnectAborts.get(ctx.from.id);
      if (entry) {
        entry.abort.abort();
        wipeDir(entry.sessionDir);
        activeConnectAborts.delete(ctx.from.id);
      }
    }
    await clearTransientMsgs(bot.api, ctx.chat.id);
    const lang = ctx.session.lang;
    const sent = await ctx.reply(t('welcome', lang), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(lang),
    });
    trackWelcomeMsg(ctx.chat.id, sent.message_id);
  });

  // /help command (disappears cleanly on next user input)
  bot.command('help', async (ctx) => {
    const lang = ctx.session.lang;
    const sent = await ctx.reply(t('help_text', lang), {
      parse_mode: 'HTML',
      reply_markup: backToMainKeyboard(lang),
    });
    trackWelcomeMsg(ctx.chat.id, sent.message_id);
  });

  // /language, /lang, /telugu command
  bot.command(['language', 'lang', 'telugu'], async (ctx) => {
    const newLang: Lang = ctx.session.lang === 'en' ? 'te' : 'en';
    ctx.session.lang = newLang;
    if (ctx.from) setUserLang(ctx.from.id, newLang);
    const sent = await ctx.reply(t('welcome', newLang), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(newLang),
    });
    trackWelcomeMsg(ctx.chat.id, sent.message_id);
  });

  // Global /cancel — aborts pending QR, clears pending mint/sell/admin input, returns to main menu
  bot.command('cancel', async (ctx) => {
    const telegramId = ctx.from!.id;
    const chatId = ctx.chat.id;
    const lang = ctx.session.lang;
    ctx.session.pendingMint = undefined;
    ctx.session.pendingSell = undefined;
    ctx.session.adminAwait = undefined;

    const entry = activeConnectAborts.get(telegramId);
    if (entry) {
      entry.abort.abort();
      wipeDir(entry.sessionDir);
      activeConnectAborts.delete(telegramId);
    }
    await clearTransientMsgs(bot.api, chatId);

    const sent = await ctx.reply(t('welcome', lang), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(lang),
    });
    trackWelcomeMsg(chatId, sent.message_id);
  });

  // Main menu callback
  bot.callbackQuery('main_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = ctx.session.lang;
    const chatId = ctx.chat!.id;
    ctx.session.pendingMint = undefined;
    ctx.session.pendingSell = undefined;
    ctx.session.adminAwait = undefined;
    await clearTransientMsgs(bot.api, chatId);

    try {
      await ctx.editMessageText(t('welcome', lang), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      });
      if (ctx.callbackQuery.message) {
        trackWelcomeMsg(chatId, ctx.callbackQuery.message.message_id);
      }
    } catch {
      const sent = await ctx.reply(t('welcome', lang), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      });
      trackWelcomeMsg(chatId, sent.message_id);
    }
  });

  // Legacy callback compatibility
  bot.callbackQuery('toggle_lang', async (ctx) => {
    await ctx.answerCallbackQuery();
    const newLang: Lang = ctx.session.lang === 'en' ? 'te' : 'en';
    ctx.session.lang = newLang;
    if (ctx.from) setUserLang(ctx.from.id, newLang);
    await ctx.editMessageText(t('welcome', newLang), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(newLang),
    });
    if (ctx.callbackQuery.message) {
      trackWelcomeMsg(ctx.chat!.id, ctx.callbackQuery.message.message_id);
    }
  });

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = ctx.session.lang;
    await ctx.editMessageText(t('help_text', lang), {
      parse_mode: 'HTML',
      reply_markup: backToMainKeyboard(lang),
    });
    if (ctx.callbackQuery.message) {
      trackWelcomeMsg(ctx.chat!.id, ctx.callbackQuery.message.message_id);
    }
  });

  // Connect new wallet (or reconnect)
  bot.callbackQuery('connect_wallet', async (ctx) => {
    const lang = ctx.session.lang;
    const telegramId = ctx.from!.id;
    const chatId = ctx.chat!.id;

    if (!checkUserCooldown(telegramId, 'connect_wallet', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Please wait a moment...' });
      return;
    }
    await ctx.answerCallbackQuery();

    ctx.session.pendingMint = undefined;
    ctx.session.pendingSell = undefined;
    ctx.session.adminAwait = undefined;

    // Abort any previous pending QR connect and clean old welcome + transient messages immediately
    const existing = activeConnectAborts.get(telegramId);
    if (existing) {
      existing.abort.abort();
      wipeDir(existing.sessionDir);
      activeConnectAborts.delete(telegramId);
    }
    await clearWelcomeMsg(bot.api, chatId);
    await ctx.deleteMessage().catch(() => {});
    await clearTransientMsgs(bot.api, chatId);

    const connMsg = await ctx.reply(t('connecting', lang), { parse_mode: 'HTML' });
    trackTransientMsg(chatId, connMsg.message_id);

    const tempDir = getSessionDir(telegramId, `new_${Date.now()}`);
    const abort = new AbortController();
    activeConnectAborts.set(telegramId, {
      qrCodeId: 'pending',
      sessionDir: tempDir,
      abort,
    });

    try {
      const signinResult = await bawSignin(tempDir);
      if (abort.signal.aborted) {
        wipeDir(tempDir);
        return;
      }

      if (!signinResult.success) {
        if (activeConnectAborts.get(telegramId)?.abort === abort) {
          activeConnectAborts.delete(telegramId);
        }
        await clearTransientMsgs(bot.api, chatId);
        wipeDir(tempDir);
        const failMsg = await ctx.reply(`❌ ${esc(signinResult.error.message)}`, {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(lang),
        });
        trackWelcomeMsg(chatId, failMsg.message_id);
        return;
      }

      const data = signinResult.data;
      if ('status' in data && data.status === 'ALREADY_CONNECTED') {
        if (activeConnectAborts.get(telegramId)?.abort === abort) {
          activeConnectAborts.delete(telegramId);
        }
        await clearTransientMsgs(bot.api, chatId);
        const msg = await ctx.reply(t('already_connected', lang), {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(lang),
        });
        trackWelcomeMsg(chatId, msg.message_id);
        return;
      }

      const signData = data as BawSigninResult;
      const expireAtMs = parseInt(signData.expireAt, 10);
      const expiryStr = formatTimestampInTz(expireAtMs, false);

      activeConnectAborts.set(telegramId, {
        qrCodeId: signData.qrCodeId,
        sessionDir: tempDir,
        abort,
      });

      const qrBuffer = await QRCode.toBuffer(signData.urlForWeb, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      if (abort.signal.aborted) {
        wipeDir(tempDir);
        return;
      }

      // Remove "Connecting..." before showing QR
      await clearTransientMsgs(bot.api, chatId);

      const caption = t('connect_qr_title', lang, signData.urlForWeb, signData.pairingCode, expiryStr);
      const qrMsg = await ctx.replyWithPhoto(new InputFile(qrBuffer, 'baw-qr.png'), {
        caption,
        parse_mode: 'HTML',
        reply_markup: connectCancelKeyboard(lang),
      });
      trackTransientMsg(chatId, qrMsg.message_id);

      const waitMsg = await ctx.reply(t('connect_waiting', lang), { parse_mode: 'HTML' });
      trackTransientMsg(chatId, waitMsg.message_id);

      void runBackgroundVerify({
        bot,
        telegramId,
        chatId,
        lang,
        tempDir,
        qrCodeId: signData.qrCodeId,
        abort,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        wipeDir(tempDir);
        return;
      }
      if (activeConnectAborts.get(telegramId)?.abort === abort) {
        activeConnectAborts.delete(telegramId);
      }
      logger.error('Connect wallet init error', { err });
      await clearTransientMsgs(bot.api, chatId);
      wipeDir(tempDir);
      const errMsg = await ctx.reply(
        t('error_generic', lang, err instanceof Error ? err.message : String(err)),
        {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(lang),
        }
      );
      trackWelcomeMsg(chatId, errMsg.message_id);
    }
  });

  // Cancel active connect -> return cleanly to Main Menu
  bot.callbackQuery('connect_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled');
    const telegramId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const lang = ctx.session.lang;
    const entry = activeConnectAborts.get(telegramId);
    if (entry) {
      entry.abort.abort();
      wipeDir(entry.sessionDir);
      activeConnectAborts.delete(telegramId);
    }
    await clearTransientMsgs(bot.api, chatId);
    await clearWelcomeMsg(bot.api, chatId);
    const sent = await bot.api.sendMessage(chatId, t('welcome', lang), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(lang),
    });
    trackWelcomeMsg(chatId, sent.message_id);
  });
}

async function runBackgroundVerify(params: {
  bot: Bot<JagentContext>;
  telegramId: number;
  chatId: number;
  lang: Lang;
  tempDir: string;
  qrCodeId: string;
  abort: AbortController;
}): Promise<void> {
  const { bot, telegramId, chatId, lang, tempDir, qrCodeId, abort } = params;
  try {
    const verifyResult = await bawVerify(qrCodeId, tempDir, abort.signal);
    if (abort.signal.aborted) return;

    const currentEntry = activeConnectAborts.get(telegramId);
    if (currentEntry?.qrCodeId === qrCodeId) {
      activeConnectAborts.delete(telegramId);
    }

    // Remove QR + "Waiting for confirmation..." transient messages
    await clearTransientMsgs(bot.api, chatId);

    if (!verifyResult.success) {
      const msg = verifyResult.error.message;
      const errText = /expired|does not exist/i.test(msg)
        ? t('connect_expired', lang)
        : `${t('connect_failed', lang)}\n\n<code>${esc(msg)}</code>`;
      const errMsg = await bot.api.sendMessage(chatId, errText, {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      });
      trackWelcomeMsg(chatId, errMsg.message_id);
      wipeDir(tempDir);
      return;
    }

    const statusResult = await bawStatus(tempDir);
    if (!statusResult.success || statusResult.data.status !== 'CONNECTED') {
      const errMsg = await bot.api.sendMessage(chatId, t('connect_failed', lang), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      });
      trackWelcomeMsg(chatId, errMsg.message_id);
      await logoutAndWipeSession(tempDir);
      return;
    }

    const addrResult = await bawAddress(tempDir);
    if (!addrResult.success) {
      const errMsg = await bot.api.sendMessage(
        chatId,
        `${t('connect_failed', lang)}\n\n<code>${esc(addrResult.error.message)}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(lang),
        }
      );
      trackWelcomeMsg(chatId, errMsg.message_id);
      await logoutAndWipeSession(tempDir);
      return;
    }

    const bscAddr = addrResult.data.addresses.find((a) => a.binanceChainId === config.BINANCE_CHAIN_ID);
    if (!bscAddr) {
      const errMsg = await bot.api.sendMessage(chatId, '❌ Could not find BSC (chain 56) wallet address.', {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      });
      trackWelcomeMsg(chatId, errMsg.message_id);
      await logoutAndWipeSession(tempDir);
      return;
    }

    const address = bscAddr.address;
    const finalDir = getSessionDir(telegramId, address);
    await promoteSessionDir(tempDir, finalDir);

    upsertUser(telegramId);
    const wallet = addWallet(telegramId, address, finalDir);

    let lastProgressText = formatConnectProgressCard({
      walletLabel: wallet.label,
      address,
      agentId: wallet.agent_id ?? undefined,
      percent: 15,
      stageText: 'Connected · Starting eligibility checks...',
    });
    const checkingMsg = await bot.api.sendMessage(chatId, lastProgressText, {
      parse_mode: 'HTML',
    });
    trackTransientMsg(chatId, checkingMsg.message_id);

    try {
      const eligResult = await runEligibilityChecks(address, finalDir, undefined, async (prog) => {
        const nextText = formatConnectProgressCard({
          walletLabel: wallet.label,
          address,
          agentId: prog.agentId !== undefined ? prog.agentId : (wallet.agent_id ?? undefined),
          percent: prog.percent,
          stageText: prog.stage,
        });
        if (nextText === lastProgressText) return;
        lastProgressText = nextText;
        await bot.api
          .editMessageText(chatId, checkingMsg.message_id, nextText, { parse_mode: 'HTML' })
          .catch(() => {});
      });
      const usdtNeeded = calcUsdtNeeded(eligResult.priceUsdtPerShare, eligResult.sharesPerMint);

      if (eligResult.agentId) updateWalletAgentId(wallet.id, eligResult.agentId);
      updateWalletLastCheck(wallet.id, eligResult.allPassed);
      saveEligibilityCheck(wallet.id, {
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

      // Rule 1: If user HAS already minted -> log out immediately + send explicit logout reason
      if (eligResult.alreadyMinted) {
        clearSessionTimer(wallet.id);
        await logoutAndWipeSession(finalDir);
        const checksText = formatEligibilityChecks(
          eligResult,
          (k, ...a) => t(k, lang, ...a),
          undefined,
          wallet.label
        );
        const reason = `${wallet.label ?? 'This wallet'} already minted before (${eligResult.prevMint.shares || '?'} shares).`;
        const finalText = `${checksText}\n\n${t('session_logged_out_minted', lang, reason)}`;
        const kb = walletActionsKeyboard(wallet.id, lang, false, { alreadyMinted: true });

        untrackTransientMsg(chatId, checkingMsg.message_id);
        await bot.api
          .editMessageText(chatId, checkingMsg.message_id, finalText, {
            parse_mode: 'HTML',
            reply_markup: kb,
          })
          .catch(async () => {
            await clearTransientMsgs(bot.api, chatId);
            await bot.api.sendMessage(chatId, finalText, { parse_mode: 'HTML', reply_markup: kb });
          });
        return;
      }

      // Rule 2: User has NOT minted before -> keep session alive for 20 min with 🔄 Refresh!
      const expiresAt = ensureSessionTimer({
        api: bot.api,
        walletId: wallet.id,
        chatId,
        address,
        walletLabel: wallet.label,
        sessionDir: finalDir,
        lang,
      });
      const timerNote = `20-min window: ${formatRemainingWindow(expiresAt)}`;
      const checksText = formatEligibilityChecks(
        eligResult,
        (k, ...a) => t(k, lang, ...a),
        timerNote,
        wallet.label
      );
      const kb = walletActionsKeyboard(wallet.id, lang, true, {
        alreadyMinted: false,
        canMint: eligResult.allPassed,
      });

      untrackTransientMsg(chatId, checkingMsg.message_id);
      await bot.api
        .editMessageText(chatId, checkingMsg.message_id, checksText, {
          parse_mode: 'HTML',
          reply_markup: kb,
        })
        .catch(async () => {
          await clearTransientMsgs(bot.api, chatId);
          await bot.api.sendMessage(chatId, checksText, { parse_mode: 'HTML', reply_markup: kb });
        });
    } catch (eligErr) {
      logger.error('Post-connect eligibility check error', { eligErr });
      await clearTransientMsgs(bot.api, chatId);
      clearSessionTimer(wallet.id);
      await logoutAndWipeSession(finalDir);
      await bot.api.sendMessage(
        chatId,
        `🔒 <b>Session Logged Out</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>Reason:</b> Could not complete eligibility checks.</blockquote>\n<pre>${esc(eligErr instanceof Error ? eligErr.message : String(eligErr))}</pre>`,
        {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(wallet.id, lang, false),
        }
      );
    }
  } catch (err) {
    if (abort.signal.aborted) {
      wipeDir(tempDir);
      return;
    }
    activeConnectAborts.delete(telegramId);
    await clearTransientMsgs(bot.api, chatId);
    logger.error('Background verify failed', { err });
    wipeDir(tempDir);
    await bot.api
      .sendMessage(chatId, t('error_generic', lang, err instanceof Error ? err.message : String(err)), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(lang),
      })
      .then((m) => trackWelcomeMsg(chatId, m.message_id))
      .catch(() => {});
  }
}

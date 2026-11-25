// src/bot/handlers/sell.ts
// Sell flow: % picker -> BNB/USDT -> quote card -> Confirm -> progress bar + polling -> auto-claim -> logout
import fs from 'fs';
import { Bot } from 'grammy';
import { JagentContext } from '../middleware';
import { esc, t } from '../../i18n';
import {
  backToMainKeyboard,
  sellConfirmKeyboard,
  sellPercentKeyboard,
  sellTokenKeyboard,
  walletActionsKeyboard,
} from '../keyboards';
import {
  getWallet,
  insertRewardClaim,
  insertSell,
  updateSellStatus,
} from '../../db/repository';
import { executeSell, getSellQuote } from '../../jager/sell';
import { claimWalletRewards } from '../../jager/rewards';
import { bawBalance, bawStatus, logoutAndWipeSession } from '../../wallet/baw';
import { getAgentStatus } from '../../jager/api';
import { clearSessionTimer, renderProgressBar, untrackWelcomeMsg } from '../sessionLifecycle';
import { config } from '../../config';
import { logger } from '../../core/logger';
import {
  checkUserCooldown,
  releaseWalletOp,
  tryAcquireWalletOp,
} from '../../core/rateLimit';

async function isSellSessionConnected(sessionDir: string): Promise<boolean> {
  if (!sessionDir || !fs.existsSync(sessionDir)) return false;
  return bawStatus(sessionDir)
    .then((r) => r.success && r.data.status === 'CONNECTED')
    .catch(() => false);
}

export function registerSellHandlers(bot: Bot<JagentContext>): void {
  // Start sell flow
  bot.callbackQuery(/^sell_start:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'sell_start', 2000)) {
      await ctx.answerCallbackQuery({ text: 'Please wait a moment...' });
      return;
    }
    await ctx.answerCallbackQuery();
    untrackWelcomeMsg(ctx.chat!.id, ctx.callbackQuery.message?.message_id);

    const walletId = parseInt(ctx.match[1], 10);
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
        parse_mode: 'HTML',
        reply_markup: backToMainKeyboard(lang),
      }).catch(() => {});
      return;
    }

    const connected = await isSellSessionConnected(wallet.session_dir);
    if (!connected) {
      clearSessionTimer(walletId);
      await ctx.editMessageText(
        '🔒 <b>Session Logged Out</b>\n─────────────────\nTap <b>Reconnect</b> to connect your wallet again.',
        { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
      );
      return;
    }

    let jagentAmount = '0';
    try {
      const balResult = await bawBalance(wallet.session_dir, {
        tokenAddress: config.JAGENT_TOKEN,
        binanceChainId: config.BINANCE_CHAIN_ID,
        hideLowValue: false,
      });
      if (balResult.success && balResult.data.length > 0) {
        jagentAmount = balResult.data[0].balance;
      } else {
        const st = await getAgentStatus(wallet.address);
        if (st.balances?.jagent) jagentAmount = st.balances.jagent;
      }
    } catch (err) {
      logger.warn('Could not fetch JAGENT balance for sell', { err });
    }

    if (parseFloat(jagentAmount) <= 0 || Number.isNaN(parseFloat(jagentAmount))) {
      await ctx.editMessageText('❌ No $JAGENT balance available to sell.', {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true),
      });
      return;
    }

    ctx.session.pendingSell = {
      walletId,
      fullBalance: jagentAmount,
      amount: jagentAmount,
      toToken: 'BNB',
    };

    await ctx.editMessageText(
      `${t('sell_title', lang)}\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Balance</b> — <code>${esc(jagentAmount)} JAGENT</code></blockquote>\n\n<b>Select percentage to sell:</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: sellPercentKeyboard(walletId, lang),
      }
    );
  });

  // Percentage selected -> pick output token
  bot.callbackQuery(/^sell_pct:(\d+):(25|50|100)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const pct = parseInt(ctx.match[2], 10);
    const lang = ctx.session.lang;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
        parse_mode: 'HTML',
        reply_markup: backToMainKeyboard(lang),
      }).catch(() => {});
      return;
    }

    const pending = ctx.session.pendingSell;
    if (!pending || pending.walletId !== walletId) {
      const connected = await isSellSessionConnected(wallet.session_dir);
      await ctx.editMessageText('❌ <b>Sell session expired. Please start again.</b>', {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, connected, { canMint: wallet.last_check_ok === 1 }),
      }).catch(() => {});
      return;
    }

    const full = parseFloat(pending.fullBalance);
    const selectedAmt = pct === 100 ? pending.fullBalance : ((full * pct) / 100).toFixed(6).replace(/\.?0+$/, '');
    pending.amount = selectedAmt;

    await ctx.editMessageText(
      `${t('sell_title', lang)}\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Amount</b> — <code>${esc(selectedAmt)} JAGENT</code> (<b>${pct}%</b>)</blockquote>\n\n<b>Select receive token:</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: sellTokenKeyboard(walletId, lang),
      }
    );
  });

  // Token selected -> fetch quote -> Quote Card
  bot.callbackQuery(/^sell_token:(\d+):(BNB|USDT)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'sell_quote', 2000)) {
      await ctx.answerCallbackQuery({ text: 'Please wait a moment...' });
      return;
    }
    const walletId = parseInt(ctx.match[1], 10);
    const toToken = ctx.match[2] as 'BNB' | 'USDT';
    if (!tryAcquireWalletOp(walletId)) {
      await ctx.answerCallbackQuery({ text: 'Wallet action in progress...' });
      return;
    }
    await ctx.answerCallbackQuery();

    try {
      const wallet = getWallet(walletId);
      if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
        await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
          parse_mode: 'HTML',
          reply_markup: backToMainKeyboard(lang),
        }).catch(() => {});
        return;
      }

      const pending = ctx.session.pendingSell;
      if (!pending || pending.walletId !== walletId) {
        const connected = await isSellSessionConnected(wallet.session_dir);
        await ctx.editMessageText('❌ <b>Sell session expired. Please start again.</b>', {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, connected, { canMint: wallet.last_check_ok === 1 }),
        }).catch(() => {});
        return;
      }

      if (!(await isSellSessionConnected(wallet.session_dir))) {
        ctx.session.pendingSell = undefined;
        clearSessionTimer(walletId);
        await ctx.editMessageText(
          '🔒 <b>Session Logged Out</b>\n─────────────────\nTap <b>Reconnect</b> to connect your wallet again.',
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
        );
        return;
      }

      pending.toToken = toToken;
      await ctx.editMessageText(t('sell_fetching_quote', lang), { parse_mode: 'HTML' });

      try {
        const quote = await getSellQuote(wallet.session_dir, pending.amount, toToken);
        pending.quote = quote;

        const quoteCard = t(
          'sell_quote_card',
          lang,
          quote.jagentAmount,
          quote.receiveAmount,
          quote.receiveToken,
          quote.sellTaxPct,
          quote.priceImpact,
          quote.gasFee
        );

        await ctx.editMessageText(`${quoteCard}\n\n${t('sell_confirm_prompt', lang)}`, {
          parse_mode: 'HTML',
          reply_markup: sellConfirmKeyboard(walletId, lang),
        });
      } catch (err) {
        logger.error('Sell quote error', { err });
        const connected = await isSellSessionConnected(wallet.session_dir);
        await ctx.editMessageText(
          t('sell_failed', lang, err instanceof Error ? err.message : String(err)),
          {
            parse_mode: 'HTML',
            reply_markup: walletActionsKeyboard(walletId, lang, connected),
          }
        );
      }
    } finally {
      releaseWalletOp(walletId);
    }
  });

  // Confirm sell -> swap + poll -> auto-claim pending reward -> logout
  bot.callbackQuery(/^sell_confirm:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'sell_confirm', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Swap already submitted...' });
      return;
    }
    const walletId = parseInt(ctx.match[1], 10);
    if (!tryAcquireWalletOp(walletId)) {
      await ctx.answerCallbackQuery({ text: 'Wallet action in progress...' });
      return;
    }
    await ctx.answerCallbackQuery();

    try {
      const wallet = getWallet(walletId);
      if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
        ctx.session.pendingSell = undefined;
        await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
          parse_mode: 'HTML',
          reply_markup: backToMainKeyboard(lang),
        }).catch(() => {});
        return;
      }

      const pending = ctx.session.pendingSell;
      if (!pending || pending.walletId !== walletId) {
        const connected = await isSellSessionConnected(wallet.session_dir);
        await ctx.editMessageText('❌ <b>Sell session expired. Please start again.</b>', {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, connected, { canMint: wallet.last_check_ok === 1 }),
        }).catch(() => {});
        return;
      }

      if (!(await isSellSessionConnected(wallet.session_dir))) {
        ctx.session.pendingSell = undefined;
        clearSessionTimer(walletId);
        await ctx.editMessageText(
          '🔒 <b>Session Logged Out</b>\n─────────────────\nTap <b>Reconnect</b> to connect your wallet again.',
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
        );
        return;
      }

      ctx.session.pendingSell = undefined;

      await ctx.editMessageText(
        `<b>✦ ＪＡＧΞＲ · Selling JAGENT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>${renderProgressBar(40)}\n• <b>Broadcasting swap &amp; awaiting confirmation...</b></blockquote>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});

      const sellId = insertSell(walletId, {
        jagent_amount: pending.amount,
        receive_token: pending.toToken,
        receive_amount: pending.quote?.receiveAmount ?? null,
        gas_used: null,
        tx_hash: null,
        status: 'pending',
        error_reason: null,
      });

      try {
        const result = await executeSell(wallet.session_dir, pending.amount, pending.toToken);

        if (result.status === 'PENDING') {
          updateSellStatus(sellId, 'pending');
          await ctx.editMessageText(t('sell_pending', lang, result.orderId), {
            parse_mode: 'HTML',
            reply_markup: walletActionsKeyboard(walletId, lang, true),
          });
          return;
        }

        clearSessionTimer(walletId);
        await logoutAndWipeSession(wallet.session_dir);

        if (result.status === 'FAILED') {
          updateSellStatus(
            sellId,
            'failed',
            result.txHash || undefined,
            result.errorReason ?? 'Order failed',
            undefined,
            result.gasUsedBnb
          );
          await ctx.editMessageText(
            `${t('sell_failed', lang, result.errorReason ?? 'Swap failed on-chain')}\n\n⛽ Gas lost: <code>${esc(result.gasUsedBnb)} BNB</code>\n\n${t('session_logged_out_done', lang)}`,
            {
              parse_mode: 'HTML',
              reply_markup: walletActionsKeyboard(walletId, lang, false),
            }
          );
          return;
        }

        updateSellStatus(
          sellId,
          'success',
          result.txHash || undefined,
          undefined,
          result.receivedAmount || pending.quote?.receiveAmount,
          result.gasUsedBnb
        );

        let rewardLine = '';
        const reward = await claimWalletRewards(wallet.address, { onlyIfPending: true });
        if (reward.claimed) {
          insertRewardClaim(walletId, {
            amount_usdt: reward.paidUsdt,
            tx_hash: reward.txHash ?? null,
            status: 'success',
            source: 'auto_sell',
            reason: null,
          });
          rewardLine = `\n🎁 <b>Pending Reward Claimed:</b> <code>${esc(reward.paidUsdt)} USDT</code>${reward.txHash ? ` (<a href="https://bscscan.com/tx/${esc(reward.txHash)}">TX</a>)` : ''}`;
        }

        const summary = t(
          'sell_success',
          lang,
          result.txHash || result.orderId,
          result.status,
          result.receivedAmount || pending.quote?.receiveAmount || '?',
          pending.toToken,
          result.refundNote
        );

        await ctx.editMessageText(
          `${renderProgressBar(100)}\n\n${summary}${rewardLine}\n\n${t('session_logged_out_done', lang)}`,
          {
            parse_mode: 'HTML',
            reply_markup: walletActionsKeyboard(walletId, lang, false),
          }
        );
      } catch (err) {
        logger.error('Sell execution error', { err });
        const reason = err instanceof Error ? err.message : String(err);
        updateSellStatus(sellId, 'failed', undefined, reason);

        const stillConnected = await isSellSessionConnected(wallet.session_dir);
        await ctx.editMessageText(t('sell_failed', lang, reason), {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, stillConnected, {
            canMint: wallet.last_check_ok === 1,
          }),
        });
      }
    } finally {
      releaseWalletOp(walletId);
    }
  });

  // Cancel sell
  bot.callbackQuery(/^sell_cancel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    ctx.session.pendingSell = undefined;
    const wallet = getWallet(walletId);
    const connected = wallet ? await isSellSessionConnected(wallet.session_dir) : false;
    await ctx.editMessageText(t('sell_aborted', ctx.session.lang), {
      parse_mode: 'HTML',
      reply_markup: walletActionsKeyboard(walletId, ctx.session.lang, connected, {
        canMint: wallet?.last_check_ok === 1,
      }),
    });
  });
}

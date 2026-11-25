// src/bot/handlers/mint.ts
// Mint flow: pick shares -> pick pay -> Cost Card -> Confirm -> live progress bar ->
// execute -> auto-claim user + admin rewards -> notify admin -> auto-logout session
import fs from 'fs';
import { Bot } from 'grammy';
import { JagentContext } from '../middleware';
import { esc, t } from '../../i18n';
import {
  mintConfirmKeyboard,
  payMethodKeyboard,
  shareCountKeyboard,
  walletActionsKeyboard,
} from '../keyboards';
import {
  getAdminSettings,
  getWallet,
  insertMint,
  insertRewardClaim,
  updateMintStatus,
} from '../../db/repository';
import { executeMint, prepareMintPreview } from '../../jager/mint';
import { getAgentStatus } from '../../jager/api';
import { claimAdminAndNotify, claimWalletRewards } from '../../jager/rewards';
import { bawStatus, logoutAndWipeSession } from '../../wallet/baw';
import { clearSessionTimer, renderProgressBar } from '../sessionLifecycle';
import { logger } from '../../core/logger';
import { ContractAddressMismatchError, JagentError } from '../../core/errors';
import { config } from '../../config';
import { checkUserCooldown } from '../../core/rateLimit';

function formatProgressCard(percent: number, stageText: string): string {
  return (
    `<b>✦ ＪＡＧΞＲ · Minting JAGENT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>${renderProgressBar(percent)}\n` +
    `• <b>${esc(stageText)}</b></blockquote>`
  );
}

export function registerMintHandlers(bot: Bot<JagentContext>): void {
  // Start mint flow
  bot.callbackQuery(/^mint_start:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const lang = ctx.session.lang;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.reply('❌ Wallet not found.');
      return;
    }

    const connected =
      fs.existsSync(wallet.session_dir) &&
      (await bawStatus(wallet.session_dir)
        .then((r) => r.success && r.data.status === 'CONNECTED')
        .catch(() => false));
      if (!connected) {
      clearSessionTimer(walletId);
      await ctx.editMessageText(
        '🔒 <b>Session Logged Out</b>\n━━━━━━━━━━━━━━━━━━━━\n<b>Reconnect your wallet to mint.</b>',
        { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
      );
      return;
    }

    const settings = getAdminSettings();
    if (settings.minting_paused) {
      await ctx.editMessageText(t('minting_paused', lang), {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true),
      });
      return;
    }

    let quotaRemaining = settings.max_shares;
    let sharesPerMint = 10;
    try {
      const status = await getAgentStatus(wallet.address);
      // Enforce fresh-wallet rule right at mint start too
      if ((status.mint?.minted ?? 0) > 0) {
        clearSessionTimer(walletId);
        await logoutAndWipeSession(wallet.session_dir);
        await ctx.editMessageText(
          t('session_logged_out_minted', lang, `${wallet.label ?? 'This wallet'} already minted (${status.mint.minted} shares).`),
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false, { alreadyMinted: true }) }
        );
        return;
      }

      if (status.mint.siteEntryOpen === false || status.mint.open === false) {
        await ctx.editMessageText('⏸ Minting is currently closed on ＪＡＧΞＲ.', {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, true),
        });
        return;
      }
      quotaRemaining = status.mint.remaining ?? 0;
      sharesPerMint = status.mint.sharesPerMint ?? 10;
    } catch (err) {
      logger.warn('Could not fetch quota for mint start', { err });
    }

    const maxShares = Math.min(settings.max_shares, quotaRemaining, 10);
    if (maxShares <= 0 || maxShares < sharesPerMint) {
      await ctx.editMessageText(
        `❌ <b>Insufficient Quota</b>\n─────────────────\nRemaining: <code>${quotaRemaining}</code> · Required per tx: <b>${sharesPerMint}</b>.`,
        {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, true, { canMint: false }),
        }
      );
      return;
    }

    const note = sharesPerMint >= 10 ? `Batch size: ${sharesPerMint} shares/tx` : '';
    await ctx.editMessageText(t('mint_pick_shares', lang, maxShares, note), {
      parse_mode: 'HTML',
      reply_markup: shareCountKeyboard(walletId, maxShares, sharesPerMint, lang),
    });
  });

  // Shares selected -> pick pay method
  bot.callbackQuery(/^mint_shares:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const shares = parseInt(ctx.match[2], 10);
    const lang = ctx.session.lang;
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id) {
      await ctx.reply('❌ Wallet not found.');
      return;
    }

    await ctx.editMessageText(t('mint_pick_pay', lang), {
      parse_mode: 'HTML',
      reply_markup: payMethodKeyboard(walletId, shares, lang),
    });
  });

  // Pay method selected -> simulate + Cost Card
  bot.callbackQuery(/^mint_pay:(\d+):(\d+):(usdt|bnb)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'mint_pay', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Please wait a moment...' });
      return;
    }
    await ctx.answerCallbackQuery();

    const walletId = parseInt(ctx.match[1], 10);
    const shares = parseInt(ctx.match[2], 10);
    const pay = ctx.match[3] as 'usdt' | 'bnb';
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id) {
      await ctx.reply('❌ Wallet not found.');
      return;
    }

    const settings = getAdminSettings();
    const adminRef = settings.referral_code || config.adminRef;

    await ctx.editMessageText(t('mint_fetching', lang), { parse_mode: 'HTML' });

    try {
      const agentStatus = await getAgentStatus(wallet.address);
      const price = agentStatus.mint?.priceUsdtPerShare ?? '5.55';

      const preview = await prepareMintPreview(
        wallet.address,
        wallet.session_dir,
        shares,
        pay,
        adminRef,
        price
      );

      ctx.session.pendingMint = {
        walletId,
        shares,
        pay,
        referrer: preview.referrerDisplay,
        preview,
      };

      let riskText = '';
      if (preview.riskLines.length > 0) {
        riskText =
          `\n\n⚠️ <b>Risks:</b>\n` + preview.riskLines.map((l) => esc(l)).join('\n');
      }

      const approvalNote = preview.needsApproval
        ? '\n🔑 <i>Includes Step 1 USDT Approval (×1.02) + Step 2 Mint</i>'
        : '';

      const costCard = t(
        'mint_cost_card',
        lang,
        shares,
        `${price} USDT`,
        preview.totalDisplayCost,
        preview.gasEstimateBnb,
        preview.referrerDisplay,
        pay.toUpperCase()
      );

      await ctx.editMessageText(
        `${costCard}${approvalNote}${riskText}\n\n${t('mint_confirm_prompt', lang)}`,
        {
          parse_mode: 'HTML',
          reply_markup: mintConfirmKeyboard(walletId, lang),
        }
      );
    } catch (err) {
      logger.error('Mint preparation error', { err });
      ctx.session.pendingMint = undefined;

      if (err instanceof ContractAddressMismatchError) {
        clearSessionTimer(walletId);
        await logoutAndWipeSession(wallet.session_dir);
        await ctx.editMessageText(
          `${t('mint_contract_guard', lang)}\n\n<pre>${esc(err.message)}</pre>`,
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
        );
        return;
      }

      if (err instanceof JagentError && (err.code === 'DEVMODE_OFF' || err.code === 'DEVMODE_CAP_EXCEEDED')) {
        // Unminted user can fix in App and tap Refresh while session stays open within 20-min window
        await ctx.editMessageText(
          `${t('mint_failed', lang, err.message)}\n\n<i>Fix in Binance App, then tap <b>🔄 Refresh</b>.</i>`,
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, true, { canMint: false }) }
        );
        return;
      }

      await ctx.editMessageText(
        t('mint_failed', lang, err instanceof Error ? err.message : String(err)),
        {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, true),
        }
      );
    }
  });

  // Confirm mint -> live progress bar -> execute -> user+admin reward claim -> admin notify -> logout
  bot.callbackQuery(/^mint_confirm:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'mint_confirm', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Already processing...' });
      return;
    }
    await ctx.answerCallbackQuery();

    const walletId = parseInt(ctx.match[1], 10);
    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id) {
      await ctx.reply('❌ Wallet not found.');
      return;
    }

    const pending = ctx.session.pendingMint;
    if (!pending || pending.walletId !== walletId) {
      await ctx.reply('❌ No pending mint found. Please start over.');
      return;
    }

    ctx.session.pendingMint = undefined;

    await ctx.editMessageText(
      formatProgressCard(20, 'Submitting verified calldata...'),
      { parse_mode: 'HTML' }
    ).catch(() => {});

    const mintId = insertMint(walletId, {
      shares: pending.shares,
      pay_method: pending.pay,
      total_cost: pending.preview.costValueForDb,
      gas_used: null,
      tx_hash: null,
      referrer: pending.referrer,
      status: 'pending',
      error_reason: null,
    });

    try {
      const result = await executeMint(
        wallet.address,
        wallet.session_dir,
        pending.preview,
        async (stage) => {
          if (stage === 'approving') {
            await ctx.editMessageText(
              formatProgressCard(40, 'Step 1/2 · Approving USDT & confirming block...'),
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else if (stage === 'pending_app') {
            await ctx.editMessageText(
              formatProgressCard(60, 'Waiting for approval in Binance App...'),
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else if (stage === 'minting') {
            await ctx.editMessageText(
              formatProgressCard(75, pending.preview.needsApproval ? 'Step 2/2 · Minting $JAGENT on-chain...' : 'Executing mint on-chain...'),
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        }
      );

      const finalStatus =
        result.status === 'FAILED'
          ? 'failed'
          : result.status === 'PENDING_CONFIRMATION'
            ? 'pending'
            : 'success';
      updateMintStatus(
        mintId,
        finalStatus,
        result.txHash || undefined,
        result.gasUsedBnb,
        result.errorReason
      );

      if (finalStatus === 'failed') {
        clearSessionTimer(walletId);
        await logoutAndWipeSession(wallet.session_dir);
        await ctx.editMessageText(
          `${t('mint_failed', lang, result.errorReason ?? 'Transaction reverted')}\n\n⛽ Gas lost: <code>${esc(result.gasUsedBnb)} BNB</code>\n\n${t('session_logged_out_done', lang)}`,
          {
            parse_mode: 'HTML',
            reply_markup: walletActionsKeyboard(walletId, lang, false),
          }
        );
        return;
      }

      // Close session & 20-min timer immediately once mint finishes cleanly
      clearSessionTimer(walletId);
      await logoutAndWipeSession(wallet.session_dir);

      let rewardLine = '';
      if (finalStatus === 'success') {
        await ctx.editMessageText(
          formatProgressCard(90, 'Confirming reward payout & notifying admin...'),
          { parse_mode: 'HTML' }
        ).catch(() => {});

        // 1. Auto-claim user's $1 reward
        const userReward = await claimWalletRewards(wallet.address, { waitForIndexer: true });
        insertRewardClaim(walletId, {
          amount_usdt: userReward.paidUsdt,
          tx_hash: userReward.txHash ?? null,
          status: userReward.claimed ? 'success' : 'skipped',
          source: 'auto_mint',
          reason: userReward.reason ?? (userReward.claimed ? null : userReward.message),
        });

        rewardLine = userReward.claimed
          ? `\n🎁 <b>Your Reward:</b> <code>${esc(userReward.paidUsdt)} USDT</code>${userReward.txHash ? ` (<a href="https://bscscan.com/tx/${esc(userReward.txHash)}">TX</a>)` : ''}`
          : `\n🎁 <b>Reward:</b> ${esc(userReward.message)}`;

        // 2. Auto-claim admin reward & notify admin on Telegram (non-blocking if follow-up timer needed)
        await claimAdminAndNotify({
          api: bot.api,
          userId: ctx.from!.id,
          username: ctx.from?.username,
          userWallet: wallet.address,
          userWalletLabel: wallet.label,
          userAgentId: wallet.agent_id,
          shares: pending.shares,
          payMethod: pending.pay,
          mintTxHash: result.txHash,
          referrer: pending.referrer,
          userReward,
        });
      }

      const summary = t(
        'mint_success',
        lang,
        result.txHash || 'pending',
        String(pending.shares),
        result.status,
        result.jagentReceived,
        result.newBalances.bnb,
        result.newBalances.usdt,
        result.newBalances.jagent
      );

      await ctx.editMessageText(
        `${renderProgressBar(100)}\n\n${summary}${rewardLine}\n\n${t('session_logged_out_done', lang)}`,
        {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, false, { alreadyMinted: true }),
        }
      );
    } catch (err) {
      logger.error('Mint execution error', { err });
      const reason = err instanceof Error ? err.message : String(err);
      updateMintStatus(mintId, 'failed', undefined, undefined, reason);

      if (err instanceof ContractAddressMismatchError) {
        clearSessionTimer(walletId);
        await logoutAndWipeSession(wallet.session_dir);
        await ctx.editMessageText(
          `${t('mint_contract_guard', lang)}\n\n<pre>${esc(reason)}</pre>`,
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
        );
        return;
      }

      await ctx.editMessageText(t('mint_failed', lang, reason), {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true),
      });
    }
  });

  // Cancel mint
  bot.callbackQuery(/^mint_cancel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const lang = ctx.session.lang;
    ctx.session.pendingMint = undefined;
    await ctx.editMessageText(t('mint_aborted', lang), {
      parse_mode: 'HTML',
      reply_markup: walletActionsKeyboard(walletId, lang, true),
    });
  });
}

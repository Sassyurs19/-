// src/bot/handlers/mint.ts
// Mint flow: pick shares -> pick pay -> Cost Card -> Confirm -> live progress bar ->
// execute -> auto-claim user + admin rewards -> notify admin -> auto-logout session
import fs from 'fs';
import { Bot } from 'grammy';
import { JagentContext } from '../middleware';
import { brandHeader, esc, t } from '../../i18n';
import {
  backToMainKeyboard,
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
import { clearSessionTimer, renderProgressBar, untrackWelcomeMsg } from '../sessionLifecycle';
import { logger } from '../../core/logger';
import { ContractAddressMismatchError, JagentError } from '../../core/errors';
import { config } from '../../config';
import {
  checkUserCooldown,
  releaseWalletOp,
  tryAcquireWalletOp,
} from '../../core/rateLimit';

async function isConnectedSession(sessionDir: string): Promise<boolean> {
  if (!sessionDir || !fs.existsSync(sessionDir)) return false;
  return bawStatus(sessionDir)
    .then((r) => r.success && r.data.status === 'CONNECTED')
    .catch(() => false);
}

function formatProgressCard(percent: number, stageText: string): string {
  return (
    `${brandHeader('Minting · JAGENT')}\n\n` +
    `<blockquote>${renderProgressBar(percent)}\n` +
    `• <b>${esc(stageText)}</b></blockquote>`
  );
}

export function registerMintHandlers(bot: Bot<JagentContext>): void {
  // Start mint flow
  bot.callbackQuery(/^mint_start:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'mint_start', 2000)) {
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

    const connected = await isConnectedSession(wallet.session_dir);
    if (!connected) {
      clearSessionTimer(walletId);
      await ctx.editMessageText(
        `${brandHeader('Session Logged Out')}\n\n<b>Reconnect your wallet to mint.</b>`,
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
        `${brandHeader('Insufficient Quota')}\n\nRemaining: <code>${quotaRemaining}</code> · Need: <b>${sharesPerMint}</b>.`,
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
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
        parse_mode: 'HTML',
        reply_markup: backToMainKeyboard(lang),
      }).catch(() => {});
      return;
    }
    const maxAllowed = Math.min(getAdminSettings().max_shares, 10);
    if (shares < 1 || shares > maxAllowed) {
      await ctx.editMessageText('❌ <b>Invalid share count selected.</b>', {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true, { canMint: wallet.last_check_ok === 1 }),
      });
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
    const walletId = parseInt(ctx.match[1], 10);
    const shares = parseInt(ctx.match[2], 10);
    const pay = ctx.match[3] as 'usdt' | 'bnb';

    if (!tryAcquireWalletOp(walletId)) {
      await ctx.answerCallbackQuery({ text: 'Wallet action in progress...' });
      return;
    }
    await ctx.answerCallbackQuery();

    const wallet = getWallet(walletId);
    if (!wallet || wallet.telegram_id !== ctx.from!.id || !wallet.is_active) {
      releaseWalletOp(walletId);
      await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
        parse_mode: 'HTML',
        reply_markup: backToMainKeyboard(lang),
      }).catch(() => {});
      return;
    }

    const settings = getAdminSettings();
    if (settings.minting_paused) {
      releaseWalletOp(walletId);
      await ctx.editMessageText(t('minting_paused', lang), {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true),
      });
      return;
    }
    if (shares < 1 || shares > Math.min(settings.max_shares, 10)) {
      releaseWalletOp(walletId);
      await ctx.editMessageText('❌ <b>Invalid share count.</b>', {
        parse_mode: 'HTML',
        reply_markup: walletActionsKeyboard(walletId, lang, true),
      });
      return;
    }

    if (!(await isConnectedSession(wallet.session_dir))) {
      releaseWalletOp(walletId);
      clearSessionTimer(walletId);
      await ctx.editMessageText(
        `${brandHeader('Session Logged Out')}\n\n<b>Reconnect your wallet to mint.</b>`,
        { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
      );
      return;
    }

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
    } finally {
      releaseWalletOp(walletId);
    }
  });

  // Confirm mint -> live progress bar -> execute -> user+admin reward claim -> admin notify -> logout
  bot.callbackQuery(/^mint_confirm:(\d+)$/, async (ctx) => {
    const lang = ctx.session.lang;
    if (!checkUserCooldown(ctx.from!.id, 'mint_confirm', 3000)) {
      await ctx.answerCallbackQuery({ text: 'Already processing...' });
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
        ctx.session.pendingMint = undefined;
        await ctx.editMessageText('❌ <b>Wallet not found.</b>', {
          parse_mode: 'HTML',
          reply_markup: backToMainKeyboard(lang),
        }).catch(() => {});
        return;
      }

      const pending = ctx.session.pendingMint;
      if (!pending || pending.walletId !== walletId) {
        const connected = await isConnectedSession(wallet.session_dir);
        await ctx.editMessageText('❌ <b>Pending mint quote expired. Please start again.</b>', {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, connected, {
            canMint: wallet.last_check_ok === 1,
          }),
        }).catch(() => {});
        return;
      }

      if (Date.now() > pending.preview.expiresAt) {
        ctx.session.pendingMint = undefined;
        const connected = await isConnectedSession(wallet.session_dir);
        await ctx.editMessageText('⏰ <b>Mint preview expired. Please re-quote before confirming.</b>', {
          parse_mode: 'HTML',
          reply_markup: walletActionsKeyboard(walletId, lang, connected, {
            canMint: wallet.last_check_ok === 1,
          }),
        }).catch(() => {});
        return;
      }

      if (!(await isConnectedSession(wallet.session_dir))) {
        ctx.session.pendingMint = undefined;
        clearSessionTimer(walletId);
        await ctx.editMessageText(
          `${brandHeader('Session Logged Out')}\n\n<b>Reconnect your wallet to mint.</b>`,
          { parse_mode: 'HTML', reply_markup: walletActionsKeyboard(walletId, lang, false) }
        );
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

        const stillConnected = await isConnectedSession(wallet.session_dir);
        await ctx.editMessageText(t('mint_failed', lang, reason), {
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

  // Cancel mint
  bot.callbackQuery(/^mint_cancel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = parseInt(ctx.match[1], 10);
    const lang = ctx.session.lang;
    ctx.session.pendingMint = undefined;
    const wallet = getWallet(walletId);
    const connected = wallet ? await isConnectedSession(wallet.session_dir) : false;
    await ctx.editMessageText(t('mint_aborted', lang), {
      parse_mode: 'HTML',
      reply_markup: walletActionsKeyboard(walletId, lang, connected, {
        canMint: wallet?.last_check_ok === 1,
      }),
    });
  });
}

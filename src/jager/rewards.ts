// src/jager/rewards.ts
// Auto-claim & manual claim for jager.live invite/mint USDT rewards ($1 invitee + $1/$3 referrer rewards),
// plus automatic admin reward claiming and Telegram notification on every completed mint.
import { Api } from 'grammy';
import { config } from '../config';
import { logger } from '../core/logger';
import { esc } from '../i18n';
import {
  claimInviteRewards,
  ClaimInviteRewardsResponse,
  getAgentStatus,
  getInviteRewardsStatus,
} from './api';

export interface RewardClaimOutcome {
  claimed: boolean;
  paidUsdt: string;
  txHash?: string;
  pendingUsdt: string;
  reason?: string;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatRewardReason(reason?: string): string {
  switch (reason) {
    case 'nothing':
      return 'No pending rewards yet (hourly auto-payout also runs).';
    case 'too-soon':
      return 'Cooldown active (~30s) — retry shortly or let hourly payout settle.';
    case 'busy':
    case 'pending':
      return 'Payout queue busy — rewards remain owed.';
    case 'network':
      return 'BSC node busy — rewards stay owed.';
    case 'paused':
      return 'Payouts temporarily paused — earned rewards remain owed.';
    case 'not-started':
      return 'Reward payouts have not started yet.';
    default:
      return reason ? `Status: ${reason}` : 'Reward claim deferred.';
  }
}

/** Resolve referrer code (.ai handle or 0x address) into a BSC wallet address */
export async function resolveWalletAddress(refOrAddress: string): Promise<string | null> {
  const clean = refOrAddress.trim();
  if (!clean) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(clean)) return clean;

  try {
    const status = await getAgentStatus(clean);
    if (status.wallet && /^0x[0-9a-fA-F]{40}$/.test(status.wallet)) {
      return status.wallet;
    }
  } catch (err) {
    logger.warn('Could not resolve wallet address for referral', {
      ref: clean,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/**
 * Claim pending USDT rewards via POST /api/invite-rewards.
 */
export async function claimWalletRewards(
  address: string,
  opts: { waitForIndexer?: boolean; onlyIfPending?: boolean } = {}
): Promise<RewardClaimOutcome> {
  let pendingUsdt = '0';

  if (opts.waitForIndexer) {
    for (let i = 0; i < 3; i++) {
      await sleep(3_500);
      try {
        const st = await getInviteRewardsStatus(address);
        const pendingNum = Number(st.you?.pending ?? 0);
        if (Number.isFinite(pendingNum) && pendingNum > 0) {
          pendingUsdt = String(pendingNum);
          break;
        }
      } catch {
        // non-fatal
      }
    }
  } else if (opts.onlyIfPending) {
    try {
      const st = await getInviteRewardsStatus(address);
      const pendingNum = Number(st.you?.pending ?? 0);
      pendingUsdt = Number.isFinite(pendingNum) ? String(pendingNum) : '0';
      if (pendingNum <= 0) {
        return {
          claimed: false,
          paidUsdt: '0',
          pendingUsdt: '0',
          reason: 'nothing',
          message: formatRewardReason('nothing'),
        };
      }
    } catch {
      return {
        claimed: false,
        paidUsdt: '0',
        pendingUsdt: '0',
        reason: 'error',
        message: 'Could not check pending rewards.',
      };
    }
  }

  let res: ClaimInviteRewardsResponse;
  try {
    res = await claimInviteRewards(address);
    if (!res.ok && (res.reason === 'busy' || res.reason === 'pending')) {
      await sleep(4_000);
      res = await claimInviteRewards(address);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Invite reward claim API error', { address, msg });
    return {
      claimed: false,
      paidUsdt: '0',
      pendingUsdt,
      reason: 'error',
      message: msg,
    };
  }

  if (res.ok) {
    const paid = String(res.paid ?? (pendingUsdt !== '0' ? pendingUsdt : '1'));
    logger.info('Invite reward claimed', { address, paid, hash: res.hash });
    return {
      claimed: true,
      paidUsdt: paid,
      txHash: res.hash,
      pendingUsdt: '0',
      message: `Claimed ${paid} USDT`,
    };
  }

  return {
    claimed: false,
    paidUsdt: '0',
    pendingUsdt,
    reason: res.reason,
    message: formatRewardReason(res.reason),
  };
}

/**
 * Automatically claim admin's referrer reward after a user completes a mint
 * and send a premium summary notification directly to config.adminId.
 */
export async function claimAdminAndNotify(params: {
  api: Api;
  userId: number;
  username?: string;
  userWallet: string;
  userWalletLabel?: string | null;
  userAgentId?: string | null;
  shares: number;
  payMethod: string;
  mintTxHash: string;
  referrer: string;
  userReward: RewardClaimOutcome;
}): Promise<void> {
  let adminRewardText = 'Skipped (no admin wallet resolved)';
  let adminReward: RewardClaimOutcome | null = null;
  let adminAddress: string | null = null;

  try {
    adminAddress = await resolveWalletAddress(params.referrer || config.adminRef);
    if (adminAddress) {
      // Wait briefly if user reward didn't already wait
      adminReward = await claimWalletRewards(adminAddress);
      if (adminReward.claimed) {
        const txLink = adminReward.txHash
          ? ` (<a href="https://bscscan.com/tx/${esc(adminReward.txHash)}">TX</a>)`
          : '';
        adminRewardText = `✅ Claimed <code>${esc(adminReward.paidUsdt)} USDT</code>${txLink}`;
      } else {
        adminRewardText = `⏳ ${esc(adminReward.message)}`;

        // If back-to-back mint hit 30s cooldown or indexer lag, schedule one clean 35s retry
        if (adminReward.reason === 'too-soon' || adminReward.reason === 'nothing') {
          const retryAddr = adminAddress;
          const retryTimer = setTimeout(async () => {
            try {
              const retryOutcome = await claimWalletRewards(retryAddr, { onlyIfPending: true });
              if (retryOutcome.claimed) {
                const txPart = retryOutcome.txHash
                  ? `\n🔗 TX: <a href="https://bscscan.com/tx/${esc(retryOutcome.txHash)}">View TX</a>`
                  : '';
                await params.api
                  .sendMessage(
                    config.adminId,
                    `<b>✦ ＪＡＧΞＲ · Admin Reward Settled</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Paid</b> — <code>${esc(retryOutcome.paidUsdt)} USDT</code>${txPart ? `\n• <b>TX</b> — <a href="https://bscscan.com/tx/${esc(retryOutcome.txHash!)}">View TX</a>` : ''}</blockquote>`,
                    { parse_mode: 'HTML' }
                  )
                  .catch(() => {});
              }
            } catch {
              // ignore
            }
          }, 35_000);
          retryTimer.unref();
        }
      }
    }
  } catch (err) {
    logger.warn('Admin auto-claim failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    adminRewardText = `⚠️ ${esc(err instanceof Error ? err.message : String(err))}`;
  }

  const userTag = params.username ? `@${esc(params.username)} (<code>${params.userId}</code>)` : `<code>${params.userId}</code>`;
  const userShort = `${params.userWallet.slice(0, 6)}...${params.userWallet.slice(-4)}`;
  const walletPrefix = params.userWalletLabel ? `<b>${esc(params.userWalletLabel)}</b> · ` : '';
  const mintTxLink = params.mintTxHash
    ? `<a href="https://bscscan.com/tx/${esc(params.mintTxHash)}">BscScan</a>`
    : 'Pending';
  const userRewardLine = params.userReward.claimed
    ? `✅ <code>${esc(params.userReward.paidUsdt)} USDT</code>`
    : esc(params.userReward.message);

  const adminMsg =
    `<b>✦ ＪＡＧΞＲ · Mint Completed</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>• <b>User</b> — ${userTag}\n` +
    `• <b>Wallet</b> — ${walletPrefix}<code>${esc(userShort)}</code> (<code>${esc(params.userAgentId ?? 'N/A')}</code>)\n` +
    `• <b>Minted</b> — <b>${params.shares} shares (${esc(params.payMethod.toUpperCase())})</b>\n` +
    `• <b>TX</b> — ${mintTxLink}\n` +
    `• <b>User Reward</b> — ${userRewardLine}\n` +
    `• <b>Admin Reward (<code>${esc(params.referrer || config.adminRef)}</code>)</b> — ${adminRewardText}</blockquote>`;

  await params.api.sendMessage(config.adminId, adminMsg, { parse_mode: 'HTML' }).catch((err) => {
    logger.warn('Failed to send admin mint notification', {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

// src/bot/middleware.ts
// Private-DM enforcement, flood protection, session state, language sync, and welcome cleanup
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { Lang } from '../i18n';
import { getUser, upsertUser } from '../db/repository';
import { MintPreviewResult } from '../jager/mint';
import { SellQuote } from '../jager/sell';
import { checkUserCooldown } from '../core/rateLimit';
import { logger } from '../core/logger';
import { clearWelcomeMsg } from './sessionLifecycle';

export interface SessionData {
  lang: Lang;
  pendingMint?: {
    walletId: number;
    shares: number;
    pay: 'usdt' | 'bnb';
    referrer: string;
    preview: MintPreviewResult;
  };
  pendingSell?: {
    walletId: number;
    fullBalance: string;
    amount: string;
    toToken: 'BNB' | 'USDT';
    quote?: SellQuote;
  };
  connectingWallet?: {
    qrCodeId: string;
    sessionDir: string;
    expireAt: number;
  };
  adminAwait?: 'ref' | 'max_shares';
}

export type JagentContext = Context & SessionFlavor<SessionData>;

function initial(): SessionData {
  return { lang: 'en' };
}

export function setupMiddleware(bot: Bot<JagentContext>): void {
  // Security: Enforce strict private 1-on-1 DM usage — never allow QR codes, wallet details, or admin menus in groups
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Use this bot in private chat only.' }).catch(() => {});
      }
      logger.warn('Blocked non-private chat update', {
        chatType: ctx.chat?.type ?? 'unknown',
        userId: ctx.from?.id,
      });
      return;
    }

    // Flood protection against rapid message spam
    if (ctx.from && ctx.message && !checkUserCooldown(ctx.from.id, 'global_msg', 350)) {
      return;
    }

    return next();
  });

  bot.use(session({ initial }));

  // Auto-create user record, sync language, and remove starting welcome msg upon next user message input
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      upsertUser(ctx.from.id);
      const user = getUser(ctx.from.id);
      if (user) {
        ctx.session.lang = user.lang as Lang;
      }
    }
    if (ctx.message && ctx.chat) {
      await clearWelcomeMsg(ctx.api, ctx.chat.id);
    }
    return next();
  });
}

// src/bot/middleware.ts
// Session, user, and language middleware
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { Lang } from '../i18n';
import { getUser, upsertUser } from '../db/repository';
import { MintPreviewResult } from '../jager/mint';
import { SellQuote } from '../jager/sell';

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
  bot.use(session({ initial }));

  // Auto-create user record and sync saved language preference
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      upsertUser(ctx.from.id);
      const user = getUser(ctx.from.id);
      if (user) {
        ctx.session.lang = user.lang as Lang;
      }
    }
    return next();
  });
}

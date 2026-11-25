// src/admin/admin.ts
// Admin panel (/admin): owner Telegram ID only — set referral code, max shares, pause/resume, view totals
import { Bot } from 'grammy';
import { JagentContext } from '../bot/middleware';
import { esc, t } from '../i18n';
import { adminKeyboard } from '../bot/keyboards';
import {
  getAdminSettings,
  getAdminTotals,
  setAdminSetting,
} from '../db/repository';
import { config } from '../config';
import { logger } from '../core/logger';
import { clearTransientMsgs, trackTransientMsg } from '../bot/sessionLifecycle';

function formatAdminHome(lang: 'en' | 'te'): string {
  const settings = getAdminSettings();
  return (
    `${t('admin_title', lang)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>• <b>Referral</b> — <code>${esc(settings.referral_code || 'not set')}</code>\n` +
    `• <b>Max Shares</b> — <b>${settings.max_shares}</b>\n` +
    `• <b>Minting</b> — <b>${settings.minting_paused ? '⏸ PAUSED' : '▶️ ACTIVE'}</b></blockquote>`
  );
}

/** Extract clean referral code (e.g. from https://jager.live/?ref=sassy19.ai -> sassy19.ai) */
export function parseReferralInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(none|clear|off)$/i.test(trimmed)) return '';

  // URL form: https://jager.live/?ref=alice.ai
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      const refParam = u.searchParams.get('ref')?.trim();
      if (refParam) return refParam;
    }
  } catch {
    // ignore URL parse error
  }

  // .ai handle, alphanumeric ref, or EVM address
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]{2,64}$/.test(trimmed)) return trimmed;
  return null;
}

export function registerAdminHandlers(bot: Bot<JagentContext>): void {
  // /admin command
  bot.command('admin', async (ctx) => {
    const lang = ctx.session.lang;
    if (ctx.from?.id !== config.adminId) {
      await ctx.reply(t('admin_not_authorized', lang), { parse_mode: 'HTML' });
      return;
    }
    ctx.session.adminAwait = undefined;
    await ctx.reply(formatAdminHome(lang), {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(lang),
    });
  });

  // /cancel command clears pending admin input
  bot.command('cancel', async (ctx) => {
    if (ctx.session.adminAwait) {
      ctx.session.adminAwait = undefined;
      await clearTransientMsgs(bot.api, ctx.chat.id);
      await ctx.reply('✕ Cancelled.');
    }
  });

  // Admin panel callback
  bot.callbackQuery('admin_panel', async (ctx) => {
    if (ctx.from?.id !== config.adminId) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.adminAwait = undefined;
    const lang = ctx.session.lang;
    await ctx.editMessageText(formatAdminHome(lang), {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(lang),
    });
  });

  // Set referral code prompt
  bot.callbackQuery('admin_set_ref', async (ctx) => {
    if (ctx.from?.id !== config.adminId) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.adminAwait = 'ref';
    const promptMsg = await ctx.reply(
      '📝 Send referral code (<code>sassy19.ai</code>, link, <code>0x...</code>, or <code>none</code>). /cancel to abort.',
      { parse_mode: 'HTML' }
    );
    trackTransientMsg(ctx.chat!.id, promptMsg.message_id);
  });

  // Set max shares prompt
  bot.callbackQuery('admin_set_max', async (ctx) => {
    if (ctx.from?.id !== config.adminId) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.adminAwait = 'max_shares';
    const promptMsg = await ctx.reply('🔢 Send max shares (<code>1</code>–<code>10</code>). /cancel to abort.', {
      parse_mode: 'HTML',
    });
    trackTransientMsg(ctx.chat!.id, promptMsg.message_id);
  });

  // Pause / resume
  bot.callbackQuery('admin_pause', async (ctx) => {
    if (ctx.from?.id !== config.adminId) return;
    await ctx.answerCallbackQuery();
    setAdminSetting('minting_paused', '1');
    logger.info('Admin paused minting');
    await ctx.editMessageText(`${t('admin_paused', ctx.session.lang)}\n\n${formatAdminHome(ctx.session.lang)}`, {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(ctx.session.lang),
    });
  });

  bot.callbackQuery('admin_resume', async (ctx) => {
    if (ctx.from?.id !== config.adminId) return;
    await ctx.answerCallbackQuery();
    setAdminSetting('minting_paused', '0');
    logger.info('Admin resumed minting');
    await ctx.editMessageText(`${t('admin_resumed', ctx.session.lang)}\n\n${formatAdminHome(ctx.session.lang)}`, {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(ctx.session.lang),
    });
  });

  // View totals
  bot.callbackQuery('admin_totals', async (ctx) => {
    if (ctx.from?.id !== config.adminId) return;
    await ctx.answerCallbackQuery();
    const totals = getAdminTotals();
    const settings = getAdminSettings();
    const text =
      `<b>✦ ＪＡＧΞＲ · Bot Totals</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<blockquote>• <b>Users</b> — <b>${totals.total_users}</b>\n` +
      `• <b>Active Wallets</b> — <b>${totals.total_wallets}</b>\n` +
      `• <b>Mints</b> — <b>${totals.total_mints}</b> (Failed: ${totals.failed_mints})\n` +
      `• <b>Shares Minted</b> — <b>${totals.total_shares}</b>\n` +
      `• <b>Sells</b> — <b>${totals.total_sells}</b> (Failed: ${totals.failed_sells})\n` +
      `• <b>Active Ref</b> — <code>${esc(settings.referral_code || 'none')}</code> · <b>Max</b> ${settings.max_shares} · <b>${settings.minting_paused ? 'PAUSED' : 'ACTIVE'}</b></blockquote>`;
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard(ctx.session.lang),
    });
  });

  // Explicit state-driven text handler for admin inputs
  bot.on('message:text', async (ctx, next) => {
    if (ctx.from?.id !== config.adminId || !ctx.session.adminAwait) {
      return next();
    }
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const mode = ctx.session.adminAwait;
    const lang = ctx.session.lang;

    if (mode === 'ref') {
      const parsed = parseReferralInput(text);
      if (parsed === null) {
        await ctx.reply('❌ Invalid referral format. Send a valid <code>.ai</code> name, <code>0x</code> address, URL, or /cancel.', {
          parse_mode: 'HTML',
        });
        return;
      }
      ctx.session.adminAwait = undefined;
      await clearTransientMsgs(bot.api, ctx.chat!.id);
      setAdminSetting('referral_code', parsed);
      logger.info('Admin updated referral_code', { referral: parsed });
      await ctx.reply(
        parsed ? t('admin_ref_set', lang, parsed) : '✅ Referral code cleared.',
        { parse_mode: 'HTML', reply_markup: adminKeyboard(lang) }
      );
      return;
    }

    if (mode === 'max_shares') {
      const num = parseInt(text, 10);
      if (!/^\d+$/.test(text) || num < 1 || num > 10) {
        await ctx.reply('❌ Please send a whole number between <code>1</code> and <code>10</code> (or /cancel).', {
          parse_mode: 'HTML',
        });
        return;
      }
      ctx.session.adminAwait = undefined;
      await clearTransientMsgs(bot.api, ctx.chat!.id);
      setAdminSetting('max_shares', String(num));
      logger.info('Admin updated max_shares', { maxShares: num });
      await ctx.reply(t('admin_max_shares_set', lang, num), {
        parse_mode: 'HTML',
        reply_markup: adminKeyboard(lang),
      });
      return;
    }

    return next();
  });
}

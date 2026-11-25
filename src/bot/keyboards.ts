// src/bot/keyboards.ts
// All Telegram inline keyboards (clean mobile-first layout; Help, Language & Admin live in TG commands)
import { InlineKeyboard } from 'grammy';
import { Lang, t } from '../i18n';

export function mainMenuKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('btn_connect_wallet', lang), 'connect_wallet').row()
    .text(t('btn_my_wallets', lang), 'my_wallets')
    .text(t('btn_status', lang), 'status_menu');
}

export function walletListKeyboard(
  wallets: Array<{ id: number; address: string; label?: string | null }>,
  lang: Lang
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of wallets) {
    const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
    const name = w.label ?? 'Wallet';
    kb.text(`👛 ${name} · ${short}`, `wallet_select:${w.id}`).row();
  }
  kb.text(t('btn_connect_wallet', lang), 'connect_wallet').row();
  kb.text(t('btn_back', lang), 'main_menu');
  return kb;
}

export function walletActionsKeyboard(
  walletId: number,
  lang: Lang,
  isConnected = true,
  opts: { alreadyMinted?: boolean; canMint?: boolean } = {}
): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (isConnected && !opts.alreadyMinted) {
    kb.text(t('btn_refresh', lang), `check:${walletId}`);
    if (opts.canMint !== false) {
      kb.text(t('btn_mint', lang), `mint_start:${walletId}`);
    }
    kb.row();
    kb.text(t('btn_sell', lang), `sell_start:${walletId}`)
      .text(t('btn_status', lang), `status_wallet:${walletId}:w`).row();
    kb.text(t('btn_disconnect', lang), `disconnect:${walletId}`)
      .text(t('btn_back', lang), 'my_wallets');
  } else {
    kb.text(t('btn_reconnect', lang), 'connect_wallet').row();
    kb.text(t('btn_status', lang), `status_wallet:${walletId}:w`)
      .text(t('btn_back', lang), 'my_wallets');
  }

  return kb;
}

export function shareCountKeyboard(
  walletId: number,
  maxShares: number,
  sharesPerMint: number,
  lang: Lang
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const max = Math.min(maxShares, 10);

  if (sharesPerMint >= 10 && max >= 10) {
    kb.text('🪙 10 Shares', `mint_shares:${walletId}:10`).row();
  } else {
    for (let i = 1; i <= max; i++) {
      kb.text(String(i), `mint_shares:${walletId}:${i}`);
      if (i % 5 === 0) kb.row();
    }
    if (max % 5 !== 0) kb.row();
  }

  kb.text(t('btn_cancel', lang), `wallet_select:${walletId}`);
  return kb;
}

export function payMethodKeyboard(walletId: number, shares: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('btn_pay_usdt', lang), `mint_pay:${walletId}:${shares}:usdt`)
    .text(t('btn_pay_bnb', lang), `mint_pay:${walletId}:${shares}:bnb`).row()
    .text(t('btn_cancel', lang), `wallet_select:${walletId}`);
}

export function mintConfirmKeyboard(walletId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('btn_confirm', lang), `mint_confirm:${walletId}`).row()
    .text(t('btn_cancel', lang), `mint_cancel:${walletId}`);
}

export function sellPercentKeyboard(walletId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text('25%', `sell_pct:${walletId}:25`)
    .text('50%', `sell_pct:${walletId}:50`)
    .text('100%', `sell_pct:${walletId}:100`).row()
    .text(t('btn_cancel', lang), `wallet_select:${walletId}`);
}

export function sellTokenKeyboard(walletId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text('🟡 BNB', `sell_token:${walletId}:BNB`)
    .text('💵 USDT', `sell_token:${walletId}:USDT`).row()
    .text(t('btn_cancel', lang), `wallet_select:${walletId}`);
}

export function sellConfirmKeyboard(walletId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('btn_confirm', lang), `sell_confirm:${walletId}`).row()
    .text(t('btn_cancel', lang), `sell_cancel:${walletId}`);
}

export function connectCancelKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard().text(t('btn_cancel', lang), 'connect_cancel');
}

export function adminKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text('📝 Referral Code', 'admin_set_ref')
    .text('🔢 Max Shares', 'admin_set_max').row()
    .text('⏸ Pause Mint', 'admin_pause')
    .text('▶️ Resume', 'admin_resume').row()
    .text('📊 View Totals', 'admin_totals').row()
    .text(t('btn_back', lang), 'main_menu');
}

export function statusWalletsKeyboard(
  wallets: Array<{ id: number; address: string; label?: string | null; agent_id?: string | null }>,
  lang: Lang
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of wallets) {
    const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
    const name = w.label ?? 'Wallet';
    const caption = w.agent_id ? `📊 ${name} · ${w.agent_id}` : `📊 ${name} · ${short}`;
    kb.text(caption, `status_wallet:${w.id}:s`).row();
  }
  kb.text(t('btn_back', lang), 'main_menu');
  return kb;
}

export type StatusOrigin = 'm' | 's' | 'w';

export function statusDetailKeyboard(
  walletId: number,
  lang: Lang,
  origin: StatusOrigin | boolean = 'w'
): InlineKeyboard {
  const resolved: StatusOrigin =
    origin === true ? 'm' : origin === false ? 'w' : origin;
  const backTarget =
    resolved === 'm'
      ? 'main_menu'
      : resolved === 's'
        ? 'status_menu'
        : `wallet_select:${walletId}`;

  return new InlineKeyboard()
    .text(t('btn_refresh', lang), `status_wallet:${walletId}:${resolved}`)
    .text(t('btn_back', lang), backTarget);
}

export function backToMainKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard().text(t('btn_back', lang), 'main_menu');
}

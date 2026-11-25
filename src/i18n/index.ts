// src/i18n/index.ts
export type Lang = 'en' | 'te';

export const JAGER_TITLE = '<b>━━━━━  ✦ ＪＡＧΞＲ ✦  ━━━━━</b>';

export function brandHeader(subtitle?: string): string {
  return subtitle
    ? `${JAGER_TITLE}\n<b>───  ${esc(subtitle)}  ───</b>`
    : JAGER_TITLE;
}

/** Escape dynamic text for Telegram HTML parse_mode */
export function esc(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Translations = Record<string, string | ((...args: any[]) => string)>;

const en: Translations = {
  welcome: `${brandHeader('Mint Terminal')}

<b>Mint JAGENT safely via your Binance Agentic Wallet.</b>

<blockquote>• <b>Price</b> — Live (~5.55 USDT / share)
• <b>Gas</b> — Min 0.0005 BNB · 2% buffer
• <b>Sell Tax</b> — 2% protocol fee on swaps
• <b>Reward</b> — 1 USDT invitee + 1 USDT ref</blockquote>

🔒 <b>Non-Custodial · Keys never leave Binance App</b>`,

  // Buttons
  btn_connect_wallet: '+ Connect Wallet',
  btn_my_wallets: '👛 Wallets',
  btn_status: '📊 Status',
  btn_check_again: '🔄 Refresh',
  btn_mint: '🪙 Mint JAGENT',
  btn_sell: '💰 Sell',
  btn_disconnect: '🔌 Logout',
  btn_reconnect: '🔗 Reconnect Wallet',
  btn_add_new_wallet: '+ Add New Wallet',
  btn_confirm: '✅ Confirm & Execute',
  btn_cancel: '✕ Cancel',
  btn_back: '← Back',
  btn_refresh: '🔄 Refresh',

  // Connect flow
  connecting: `${brandHeader('Wallet Connect')}\n\n⏳ <b>Initiating QR session...</b>`,
  connect_qr_title: (url: string, code: string, expiry: string) =>
    `${brandHeader('Approve Connection')}

<blockquote><b>1.</b> Open <b>Binance App → Agentic Wallet</b>
<b>2.</b> Scan QR or tap <a href="${esc(url)}">Open Login Link</a></blockquote>

<blockquote>• <b>Code</b> — <code>${esc(code)}</code>
• <b>Expires</b> — <b>${esc(expiry)}</b></blockquote>

⚠️ <b>Never share this link or code.</b>`,
  connect_waiting: '⏳ <b>Waiting for approval in Binance App...</b>',
  connect_success: (addr: string, label?: string) =>
    `${brandHeader(label ? `Connected · ${label}` : 'Connected')}\n\n• <b>Address</b> — <code>${esc(addr)}</code>\n⏳ <b>Running eligibility checks...</b>`,
  connect_failed: `${brandHeader('Connection Failed')}\n\n❌ Please try connecting again.`,
  connect_expired: `${brandHeader('QR Expired')}\n\n⏰ Tap <b>+ Connect Wallet</b> to start fresh.`,
  already_connected: `${brandHeader('Connected')}\n\n✅ <b>Wallet is already connected.</b>`,

  // Logout reasons
  session_logged_out_minted: (reason: string) =>
    `${brandHeader('Session Logged Out')}\n\n<blockquote>🔒 <b>Reason</b> — ${esc(reason)}</blockquote>`,
  session_logged_out_failed:
    `${brandHeader('Session Logged Out')}\n\n🔒 Fix pending items above, then reconnect.`,
  session_logged_out_done: '🔒 <b>Session closed securely.</b>',
  session_pending_refresh:
    '<b>Complete the ❌ items in Binance App, then tap 🔄 Refresh.</b>',

  // Developer mode
  devmode_required: `${brandHeader('Developer Mode')}\n\n🛠 <b>Binance App → Agentic Wallet → Settings → Developer Mode</b>`,

  // Eligibility
  eligibility_title: 'Eligibility Check',
  check_agent_id: 'Agent ID',
  check_devmode: 'Dev Mode',
  check_prev_mint: 'Fresh Wallet',
  check_quota: 'Mint Quota',
  check_usdt: 'USDT',
  check_bnb: 'BNB Gas',
  eligibility_passed: '✅ <b>All clear — ready to mint.</b>',
  eligibility_failed: '⏳ <b>Resolve ❌ items &amp; tap 🔄 Refresh.</b>',
  eligibility_failed_minted: '❌ <b>Already minted — session logged out.</b>',

  // Mint
  mint_pick_shares: (max: number, note = '') =>
    `${brandHeader('Select Shares')}\n\n<b>Choose share amount (max ${esc(max)}):</b>${note ? '\n• <b>' + esc(note) + '</b>' : ''}`,
  mint_pick_pay: `${brandHeader('Payment Method')}\n\n<b>Select your payment token:</b>`,
  btn_pay_usdt: '💵 USDT',
  btn_pay_bnb: '🟡 BNB',
  mint_fetching: `${brandHeader('Simulating Mint')}\n\n⏳ <b>Preparing calldata &amp; gas estimate...</b>`,
  mint_cost_card: (shares: number, price: string, total: string, gas: string, ref: string, pay: string) =>
    `${brandHeader('Mint Summary')}

<blockquote>• <b>Shares</b> — <b>${esc(shares)}</b>
• <b>Unit Price</b> — <b>${esc(price)}</b>
• <b>Total (${esc(pay)})</b> — <code>${esc(total)}</code>
• <b>Est. Gas (+20%)</b> — <b>~${esc(gas)} BNB</b>
• <b>Referrer</b> — <code>${esc(ref || 'none')}</code>
• <b>Slippage</b> — <b>2%</b></blockquote>

⚠️ <b>Self-owned wallet rewards may not pay.</b>`,
  mint_confirm_prompt: '<b>Tap Confirm &amp; Execute to broadcast on-chain.</b>',
  mint_contract_guard: `${brandHeader('Security Alert')}\n\n🛑 <b>Unexpected contract address — mint aborted.</b>`,
  mint_success: (tx: string, shares: string, status: string, received: string, bnb: string, usdt: string, jagent: string) =>
    `${brandHeader('Mint Complete')}

<blockquote>• <b>Shares</b> — <b>${esc(shares)} (${esc(status)})</b>
• <b>Received</b> — <code>${esc(received)} JAGENT</code>
• <b>TX</b> — <a href="https://bscscan.com/tx/${esc(tx)}">View on BscScan</a></blockquote>

<blockquote><b>Updated Balances</b>
• <b>JAGENT</b> — <code>${esc(jagent)}</code>
• <b>USDT</b> — <code>${esc(usdt)}</code>
• <b>BNB</b> — <code>${esc(bnb)}</code></blockquote>`,
  mint_failed: (reason: string) => `${brandHeader('Mint Failed')}\n\n❌ <pre>${esc(reason)}</pre>`,
  mint_aborted: `${brandHeader('Mint Cancelled')}\n\n✕ <b>Operation cancelled.</b>`,

  // Sell
  sell_title: brandHeader('Sell Token'),
  sell_fetching_quote: `${brandHeader('Sell Quote')}\n\n⏳ <b>Fetching live quote (5% slippage)...</b>`,
  sell_quote_card: (amount: string, receive: string, token: string, tax: string, impact: string, gas: string) =>
    `${brandHeader('Sell Quote')}

<blockquote>• <b>Sell</b> — <code>${esc(amount)} JAGENT</code>
• <b>Receive</b> — <code>~${esc(receive)} ${esc(token)}</code>
• <b>Tax</b> — <b>${esc(tax)}%</b> · <b>Slippage</b> — <b>5%</b>
• <b>Impact</b> — <b>${esc(impact)}</b> · <b>Gas</b> — <b>~${esc(gas)} BNB</b></blockquote>`,
  sell_confirm_prompt: '<b>Tap Confirm &amp; Execute to swap.</b>',
  sell_executing: '⏳ <b>Executing swap &amp; awaiting confirmation...</b>',
  sell_success: (tx: string, status: string, received: string, token: string, extra = '') =>
    `${brandHeader('Sell Complete')}

<blockquote>• <b>Status</b> — <b>${esc(status)}</b>
• <b>Received</b> — <code>${esc(received)} ${esc(token)}</code>${extra ? '\n• <b>' + esc(extra) + '</b>' : ''}
• <b>TX</b> — <a href="https://bscscan.com/tx/${esc(tx)}">View on BscScan</a></blockquote>`,
  sell_pending: (orderId: string) => `${brandHeader('Order Processing')}\n\n⏳ <b>Order:</b> <code>${esc(orderId)}</code>`,
  sell_failed: (reason: string) => `${brandHeader('Sell Failed')}\n\n❌ <pre>${esc(reason)}</pre>`,
  sell_aborted: `${brandHeader('Sell Cancelled')}\n\n✕ <b>Swap cancelled.</b>`,

  no_wallets: `${brandHeader('Wallets')}\n\n<b>No wallets linked yet. Tap + Connect Wallet.</b>`,
  status_title: brandHeader('Status & History'),

  // Admin
  admin_title: brandHeader('Admin Console'),
  admin_not_authorized: '⛔ <b>Not authorized.</b>',
  admin_ref_set: (ref: string) => `✅ <b>Referral updated:</b> <code>${esc(ref)}</code>`,
  admin_paused: '⏸ <b>Minting paused.</b>',
  admin_resumed: '▶️ <b>Minting resumed.</b>',
  admin_max_shares_set: (n: number) => `✅ <b>Max shares set to ${esc(n)}.</b>`,

  // Errors
  error_generic: (msg: string) => `${brandHeader('Notice')}\n\n❌ <pre>${esc(msg)}</pre>`,
  error_rate_limit: '⚠️ <b>Too many requests — wait a moment.</b>',
  error_devmode_expired_mid: '⚠️ <b>Developer Mode expired — re-enable in Binance App.</b>',

  help_text: `${brandHeader('Quick Guide')}

<blockquote><b>1. Connect</b> — Scan QR in Binance App → Agentic Wallet
<b>2. Verify</b> — Fresh unminted wallet, .ai ID, Dev Mode &amp; quota
<b>3. Mint</b> — Confirm to mint 10 shares (auto-claims $1 reward)
<b>4. Security</b> — Already-minted wallets logout automatically</blockquote>

<b>Commands:</b> /start · /help · /language · /admin`,

  minting_paused: `⏸ <b>Minting is currently paused by admin.</b>`,
};

const te: Translations = {
  welcome: `${brandHeader('మింట్ టెర్మినల్')}

<b>Binance Agentic Wallet ద్వారా సురక్షితంగా JAGENT మింట్ చేయండి.</b>

<blockquote>• <b>ధర</b> — లైవ్ (~5.55 USDT / షేర్)
• <b>గ్యాస్</b> — కనీసం 0.0005 BNB · 2% బఫర్
• <b>సెల్ ట్యాక్స్</b> — 2% ప్రోటోకాల్ ట్యాక్స్
• <b>రివార్డ్</b> — 1 USDT యూజర్ + 1 USDT రెఫరర్</blockquote>

🔒 <b>ప్రైవేట్ కీలు మీ Binance Appలోనే ఉంటాయి</b>`,

  btn_connect_wallet: '+ కొత్త వాలెట్',
  btn_my_wallets: '👛 నా వాలెట్లు',
  btn_status: '📊 స్థితి',
  btn_check_again: '🔄 రిఫ్రెష్',
  btn_mint: '🪙 మింట్ JAGENT',
  btn_sell: '💰 అమ్మండి',
  btn_disconnect: '🔌 లాగ్‌అవుట్',
  btn_reconnect: '🔗 మళ్ళీ కనెక్ట్',
  btn_add_new_wallet: '+ కొత్త వాలెట్',
  btn_confirm: '✅ నిర్ధారించండి',
  btn_cancel: '✕ రద్దు',
  btn_back: '← వెనుకకు',
  btn_refresh: '🔄 రిఫ్రెష్',

  connecting: `${brandHeader('వాలెట్ కనెక్షన్')}\n\n⏳ <b>QR సెషన్ ప్రారంభమవుతోంది...</b>`,
  connect_qr_title: (url: string, code: string, expiry: string) =>
    `${brandHeader('కనెక్ట్ చేయండి')}

<blockquote><b>1.</b> <b>Binance App → Agentic Wallet</b> తెరవండి
<b>2.</b> QR స్కాన్ చేయండి లేదా <a href="${esc(url)}">లాగిన్ లింక్ తెరవండి</a></blockquote>

<blockquote>• <b>కోడ్</b> — <code>${esc(code)}</code>
• <b>గడువు</b> — <b>${esc(expiry)}</b></blockquote>

⚠️ <b>ఈ లింక్ లేదా కోడ్‌ను ఎవరితోనూ పంచుకోకండి.</b>`,
  connect_waiting: '⏳ <b>Binance Appలో అనుమతి కోసం వేచి ఉన్నాము...</b>',
  connect_success: (addr: string, label?: string) =>
    `${brandHeader(label ? `కనెక్ట్ · ${label}` : 'కనెక్ట్ అయింది')}\n\n• <b>చిరునామా</b> — <code>${esc(addr)}</code>\n⏳ <b>అర్హత తనిఖీ చేస్తోంది...</b>`,
  connect_failed: `${brandHeader('కనెక్షన్ విఫలమైంది')}\n\n❌ దయచేసి మళ్ళీ ప్రయత్నించండి.`,
  connect_expired: `${brandHeader('QR గడువు తీరింది')}\n\n⏰ కొత్తది ప్రారంభించడానికి <b>+ కొత్త వాలెట్</b> నొక్కండి.`,
  already_connected: `${brandHeader('కనెక్ట్ అయింది')}\n\n✅ <b>వాలెట్ ఇప్పటికే కనెక్ట్ అయింది.</b>`,

  session_logged_out_minted: (reason: string) =>
    `${brandHeader('సెషన్ లాగ్‌అవుట్')}\n\n<blockquote>🔒 <b>కారణం</b> — ${esc(reason)}</blockquote>`,
  session_logged_out_failed:
    `${brandHeader('సెషన్ లాగ్‌అవుట్')}\n\n🔒 సమస్యలను సరిచేసి మళ్ళీ కనెక్ట్ చేయండి.`,
  session_logged_out_done: '🔒 <b>సెషన్ సురక్షితంగా మూసివేయబడింది.</b>',
  session_pending_refresh: '<b>Binance Appలో ❌ అంశాలు పూర్తి చేసి 🔄 రిఫ్రెష్ నొక్కండి.</b>',

  devmode_required: `${brandHeader('డెవలపర్ మోడ్')}\n\n🛠 <b>Binance App → Agentic Wallet → Settings → Developer Mode</b>`,

  eligibility_title: 'అర్హత తనిఖీ',
  check_agent_id: 'Agent ID',
  check_devmode: 'డెవలపర్ మోడ్',
  check_prev_mint: 'ఫ్రెష్ వాలెట్',
  check_quota: 'మింట్ కోటా',
  check_usdt: 'USDT',
  check_bnb: 'BNB గ్యాస్',
  eligibility_passed: '✅ <b>అన్ని తనిఖీలు పాస్ — మింట్‌కు సిద్ధం!</b>',
  eligibility_failed: '⏳ <b>❌ అంశాలు పరిష్కరించి 🔄 రిఫ్రెష్ నొక్కండి.</b>',
  eligibility_failed_minted: '❌ <b>ఇప్పటికే మింట్ అయింది — లాగ్‌అవుట్.</b>',

  mint_pick_shares: (max: number, note = '') =>
    `${brandHeader('షేర్లు ఎంచుకోండి')}\n\n<b>షేర్లు (గరిష్టంగా ${esc(max)}):</b>${note ? '\n• <b>' + esc(note) + '</b>' : ''}`,
  mint_pick_pay: `${brandHeader('చెల్లింపు విధానం')}\n\n<b>చెల్లింపు టోకెన్ ఎంచుకోండి:</b>`,
  btn_pay_usdt: '💵 USDT',
  btn_pay_bnb: '🟡 BNB',
  mint_fetching: `${brandHeader('సిద్ధం చేస్తోంది')}\n\n⏳ <b>సిమ్యులేషన్ &amp; గ్యాస్ అంచనా...</b>`,
  mint_cost_card: (shares: number, price: string, total: string, gas: string, ref: string, pay: string) =>
    `${brandHeader('మింట్ సారాంశం')}

<blockquote>• <b>షేర్లు</b> — <b>${esc(shares)}</b>
• <b>షేర్ ధర</b> — <b>${esc(price)}</b>
• <b>మొత్తం (${esc(pay)})</b> — <code>${esc(total)}</code>
• <b>గ్యాస్ (+20%)</b> — <b>~${esc(gas)} BNB</b>
• <b>రెఫరర్</b> — <code>${esc(ref || 'none')}</code>
• <b>స్లిప్పేజ్</b> — <b>2%</b></blockquote>

⚠️ <b>ఒకే వ్యక్తి వాలెట్లకు రెఫెరల్ బహుమతులు చెల్లించబడకపోవచ్చు.</b>`,
  mint_confirm_prompt: '<b>ఆన్-చెయిన్ అమలుకు నిర్ధారించండి నొక్కండి.</b>',
  mint_contract_guard: `${brandHeader('భద్రతా హెచ్చరిక')}\n\n🛑 <b>అనుకోని కాంట్రాక్ట్ చిరునామా — మింట్ ఆపబడింది.</b>`,
  mint_success: (tx: string, shares: string, status: string, received: string, bnb: string, usdt: string, jagent: string) =>
    `${brandHeader('మింట్ పూర్తయింది')}

<blockquote>• <b>షేర్లు</b> — <b>${esc(shares)} (${esc(status)})</b>
• <b>పొందినది</b> — <code>${esc(received)} JAGENT</code>
• <b>TX</b> — <a href="https://bscscan.com/tx/${esc(tx)}">BscScan లో చూడండి</a></blockquote>

<blockquote><b>కొత్త బ్యాలెన్సులు</b>
• <b>JAGENT</b> — <code>${esc(jagent)}</code>
• <b>USDT</b> — <code>${esc(usdt)}</code>
• <b>BNB</b> — <code>${esc(bnb)}</code></blockquote>`,
  mint_failed: (reason: string) => `${brandHeader('మింట్ విఫలమైంది')}\n\n❌ <pre>${esc(reason)}</pre>`,
  mint_aborted: `${brandHeader('మింట్ రద్దు')}\n\n✕ <b>మింట్ రద్దు చేయబడింది.</b>`,

  sell_title: brandHeader('టోకెన్ అమ్మకం'),
  sell_fetching_quote: `${brandHeader('విక్రయ కోట్')}\n\n⏳ <b>లైవ్ కోట్ తీసుకుంటోంది (5% స్లిప్పేజ్)...</b>`,
  sell_quote_card: (amount: string, receive: string, token: string, tax: string, impact: string, gas: string) =>
    `${brandHeader('విక్రయ కోట్')}

<blockquote>• <b>అమ్మకం</b> — <code>${esc(amount)} JAGENT</code>
• <b>పొందటం</b> — <code>~${esc(receive)} ${esc(token)}</code>
• <b>ట్యాక్స్</b> — <b>${esc(tax)}%</b> · <b>స్లిప్పేజ్</b> — <b>5%</b>
• <b>ప్రభావం</b> — <b>${esc(impact)}</b> · <b>గ్యాస్</b> — <b>~${esc(gas)} BNB</b></blockquote>`,
  sell_confirm_prompt: '<b>స్వాప్ చేయడానికి నిర్ధారించండి నొక్కండి.</b>',
  sell_executing: '⏳ <b>స్వాప్ అమలు చేస్తోంది...</b>',
  sell_success: (tx: string, status: string, received: string, token: string, extra = '') =>
    `${brandHeader('అమ్మకం పూర్తయింది')}

<blockquote>• <b>స్థితి</b> — <b>${esc(status)}</b>
• <b>పొందినది</b> — <code>${esc(received)} ${esc(token)}</code>${extra ? '\n• <b>' + esc(extra) + '</b>' : ''}
• <b>TX</b> — <a href="https://bscscan.com/tx/${esc(tx)}">BscScan లో చూడండి</a></blockquote>`,
  sell_pending: (orderId: string) => `${brandHeader('ఆర్డర్ ప్రాసెస్')}\n\n⏳ <code>${esc(orderId)}</code>`,
  sell_failed: (reason: string) => `${brandHeader('అమ్మకం విఫలమైంది')}\n\n❌ <pre>${esc(reason)}</pre>`,
  sell_aborted: `${brandHeader('అమ్మకం రద్దు')}\n\n✕ <b>అమ్మకం రద్దు చేయబడింది.</b>`,

  no_wallets: `${brandHeader('నా వాలెట్లు')}\n\n<b>వాలెట్లు లేవు. + కొత్త వాలెట్ నొక్కండి.</b>`,
  status_title: brandHeader('స్థితి & చరిత్ర'),

  admin_title: brandHeader('అడ్మిన్ కన్సోల్'),
  admin_not_authorized: '⛔ <b>అనుమతి లేదు.</b>',
  admin_ref_set: (ref: string) => `✅ <b>రెఫెరల్:</b> <code>${esc(ref)}</code>`,
  admin_paused: '⏸ <b>మింటింగ్ పాజ్ అయింది.</b>',
  admin_resumed: '▶️ <b>మింటింగ్ ప్రారంభమైంది.</b>',
  admin_max_shares_set: (n: number) => `✅ <b>గరిష్ట షేర్లు: ${esc(n)}</b>`,

  error_generic: (msg: string) => `${brandHeader('సమాచారం')}\n\n❌ <pre>${esc(msg)}</pre>`,
  error_rate_limit: '⚠️ <b>దయచేసి కొద్దిగా ఆగండి.</b>',
  error_devmode_expired_mid: '⚠️ <b>డెవలపర్ మోడ్ గడువు తీరింది.</b>',

  help_text: `${brandHeader('గైడ్')}

<blockquote><b>1. కనెక్ట్</b> — Binance App లో QR స్కాన్ చేయండి
<b>2. తనిఖీ</b> — ఫ్రెష్ వాలెట్, .ai ID, Dev Mode &amp; కోటా
<b>3. మింట్</b> — 10 షేర్లు మింట్ చేయండి ($1 రివార్డ్ ఆటో క్లెయిమ్)
<b>4. భద్రత</b> — ఇప్పటికే మింట్ అయిన వాలెట్ తక్షణ లాగ్‌అవుట్</blockquote>

<b>కమాండ్లు:</b> /start · /help · /language · /admin`,

  minting_paused: '⏸ <b>అడ్మిన్ మింటింగ్ పాజ్ చేశారు.</b>',
};

const translations: Record<Lang, Translations> = { en, te };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function t(key: string, lang: Lang = 'en', ...args: any[]): string {
  const dict = translations[lang] ?? translations.en;
  const val = dict[key] ?? translations.en[key] ?? key;
  if (typeof val === 'function') {
    return val(...args);
  }
  return val as string;
}

export function tFn(lang: Lang): (key: string, ...args: unknown[]) => string {
  return (key: string, ...args: unknown[]) => t(key, lang, ...args);
}

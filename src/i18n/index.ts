// src/i18n/index.ts
export type Lang = 'en' | 'te';

const LINE = '━━━━━━━━━━━━━━━━━━━━';

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
  welcome: `<b>✦ ＪＡＧΞＲ · Mint Terminal</b>
${LINE}
<b>Mint JAGENT safely using your Binance Agentic Wallet.</b>

<blockquote><b>Terms &amp; Pricing</b>
• <b>Price</b> — Live rate (~5.55 USDT / share)
• <b>Gas</b> — Min 0.0005 BNB · 2% USDT buffer
• <b>Sell Tax</b> — 2% protocol fee on swaps
• <b>Notice</b> — Self-owned wallet rewards may not pay</blockquote>

🔒 <b>Non-Custodial · Keys never leave your Binance App</b>`,

  // Buttons
  btn_connect_wallet: '+ Connect Wallet',
  btn_my_wallets: '👛 Wallets',
  btn_status: '📊 Status',
  btn_check_again: '🔄 Refresh',
  btn_mint: '🪙 Mint JAGENT',
  btn_sell: '💰 Sell',
  btn_disconnect: '🔌 Logout',
  btn_reconnect: '🔗 Reconnect Wallet',
  btn_confirm: '✅ Confirm & Execute',
  btn_cancel: '✕ Cancel',
  btn_back: '← Back',
  btn_refresh: '🔄 Refresh',

  // Connect flow
  connecting: `<b>✦ ＪＡＧΞＲ · Wallet Connect</b>\n${LINE}\n<b>Initiating QR session...</b>`,
  connect_qr_title: (url: string, code: string, expiry: string) =>
    `<b>✦ ＪＡＧΞＲ · Approve Connection</b>
${LINE}
<blockquote><b>1.</b> Open <b>Binance App → Agentic Wallet</b>
<b>2.</b> Scan QR or tap <a href="${esc(url)}">Open Login Link</a></blockquote>

• <b>Pairing Code</b> — <code>${esc(code)}</code>
• <b>Expires</b> — <b>${esc(expiry)}</b>

⚠️ <b>Never share this link or code with anyone.</b>`,
  connect_waiting: '⏳ <b>Waiting for approval in Binance App...</b>',
  connect_success: (addr: string, label?: string) =>
    `✅ <b>Connected${label ? ` · ${esc(label)}` : ''}</b> · <code>${esc(addr)}</code>\n<b>Running eligibility checks...</b>`,
  connect_failed: `❌ <b>Connection Failed</b>\n${LINE}\nPlease try connecting again.`,
  connect_expired: `⏰ <b>QR Code Expired</b>\n${LINE}\nTap <b>+ Connect Wallet</b> to start fresh.`,
  already_connected: '✅ <b>Wallet is already connected.</b>',

  // Logout reasons
  session_logged_out_minted: (reason: string) =>
    `🔒 <b>Session Logged Out</b>\n${LINE}\n<blockquote><b>Reason:</b> ${esc(reason)}</blockquote>`,
  session_logged_out_failed:
    `🔒 <b>Session Logged Out</b>\n${LINE}\n<b>Fix the pending issues above, then reconnect.</b>`,
  session_logged_out_done: '🔒 <b>Session closed securely.</b>',
  session_pending_refresh:
    '<b>Complete the ❌ items in Binance App, then tap 🔄 Refresh.</b>',

  // Developer mode
  devmode_required: `🛠 <b>Enable Developer Mode</b>\n${LINE}\n<b>Binance App → Agentic Wallet → Settings → Developer Mode</b>`,

  // Eligibility
  eligibility_title: '<b>✦ ＪＡＧΞＲ · Eligibility Check</b>',
  check_agent_id: 'Agent ID (.ai)',
  check_devmode: 'Developer Mode',
  check_prev_mint: 'Fresh Wallet Status',
  check_quota: 'Mint Quota',
  check_usdt: 'USDT Balance',
  check_bnb: 'BNB Gas',
  eligibility_passed: '✅ <b>All checks passed — ready to mint.</b>',
  eligibility_failed: '⏳ <b>Pending checks</b> — resolve &amp; tap <b>🔄 Refresh</b>.',
  eligibility_failed_minted: '❌ <b>Already minted before</b> — wallet logged out.',

  // Mint
  mint_pick_shares: (max: number, note = '') =>
    `<b>✦ ＪＡＧΞＲ · Select Shares</b>\n${LINE}\n<b>Choose share amount (max ${esc(max)}):</b>${note ? '\n• <b>' + esc(note) + '</b>' : ''}`,
  mint_pick_pay: `<b>✦ ＪＡＧΞＲ · Payment Method</b>\n${LINE}\n<b>Select your payment token:</b>`,
  btn_pay_usdt: '💵 USDT',
  btn_pay_bnb: '🟡 BNB',
  mint_fetching: `<b>✦ ＪＡＧΞＲ · Simulating</b>\n${LINE}\n⏳ <b>Preparing calldata &amp; gas estimate...</b>`,
  mint_cost_card: (shares: number, price: string, total: string, gas: string, ref: string, pay: string) =>
    `<b>✦ ＪＡＧΞＲ · Mint Summary</b>
${LINE}
<blockquote>• <b>Shares</b> — <b>${esc(shares)}</b>
• <b>Unit Price</b> — <b>${esc(price)}</b>
• <b>Total (${esc(pay)})</b> — <code>${esc(total)}</code>
• <b>Est. Gas (+20%)</b> — <b>~${esc(gas)} BNB</b>
• <b>Referrer</b> — <code>${esc(ref || 'none')}</code>
• <b>Slippage</b> — <b>2%</b></blockquote>

⚠️ <b>Self-owned wallet referral rewards may not be paid by ＪＡＧΞＲ.</b>`,
  mint_confirm_prompt: '<b>Tap Confirm &amp; Execute to broadcast on-chain.</b>',
  mint_contract_guard: `🛑 <b>SECURITY ALERT</b>\n${LINE}\n<b>Unexpected contract address detected — mint aborted.</b>`,
  mint_success: (tx: string, shares: string, status: string, received: string, bnb: string, usdt: string, jagent: string) =>
    `<b>✦ ＪＡＧΞＲ · Mint Complete</b>
${LINE}
<blockquote>• <b>Shares</b> — <b>${esc(shares)} (${esc(status)})</b>
• <b>Received</b> — <code>${esc(received)} JAGENT</code>
• <b>Transaction</b> — <a href="https://bscscan.com/tx/${esc(tx)}">View on BscScan</a></blockquote>

<blockquote><b>Updated Balances</b>
• <b>JAGENT</b> — <code>${esc(jagent)}</code>
• <b>USDT</b> — <code>${esc(usdt)}</code>
• <b>BNB</b> — <code>${esc(bnb)}</code></blockquote>`,
  mint_failed: (reason: string) => `❌ <b>Mint Failed</b>\n${LINE}\n<pre>${esc(reason)}</pre>`,
  mint_aborted: '✕ <b>Mint cancelled.</b>',

  // Sell
  sell_title: '<b>✦ ＪＡＧΞＲ · Sell Token</b>',
  sell_fetching_quote: `<b>✦ ＪＡＧΞＲ · Sell Quote</b>\n${LINE}\n⏳ <b>Fetching live quote (5% max slippage)...</b>`,
  sell_quote_card: (amount: string, receive: string, token: string, tax: string, impact: string, gas: string) =>
    `<b>✦ ＪＡＧΞＲ · Sell Quote</b>
${LINE}
<blockquote>• <b>Sell</b> — <code>${esc(amount)} JAGENT</code>
• <b>Receive</b> — <code>~${esc(receive)} ${esc(token)}</code>
• <b>Sell Tax</b> — <b>${esc(tax)}%</b> · <b>Slippage</b> — <b>5%</b>
• <b>Price Impact</b> — <b>${esc(impact)}</b>
• <b>Est. Gas</b> — <b>~${esc(gas)} BNB</b></blockquote>`,
  sell_confirm_prompt: '<b>Tap Confirm &amp; Execute to swap.</b>',
  sell_executing: '⏳ <b>Executing swap &amp; awaiting confirmation...</b>',
  sell_success: (tx: string, status: string, received: string, token: string, extra = '') =>
    `<b>✦ ＪＡＧΞＲ · Sell Complete</b>
${LINE}
<blockquote>• <b>Status</b> — <b>${esc(status)}</b>
• <b>Received</b> — <code>${esc(received)} ${esc(token)}</code>${extra ? '\n• <b>' + esc(extra) + '</b>' : ''}
• <b>Transaction</b> — <a href="https://bscscan.com/tx/${esc(tx)}">View on BscScan</a></blockquote>`,
  sell_pending: (orderId: string) => `⏳ <b>Order Processing</b>\n<b>Order:</b> <code>${esc(orderId)}</code>`,
  sell_failed: (reason: string) => `❌ <b>Sell Failed</b>\n${LINE}\n<pre>${esc(reason)}</pre>`,
  sell_aborted: '✕ <b>Sell cancelled.</b>',

  no_wallets: `<b>✦ ＪＡＧΞＲ · Wallets</b>\n${LINE}\n<b>No wallets connected yet. Tap + Connect Wallet to start.</b>`,
  status_title: `<b>✦ ＪＡＧΞＲ · Status &amp; History</b>`,

  // Admin
  admin_title: '<b>✦ ＪＡＧΞＲ · Admin Console</b>',
  admin_not_authorized: '⛔ <b>Not authorized.</b>',
  admin_ref_set: (ref: string) => `✅ <b>Referral updated:</b> <code>${esc(ref)}</code>`,
  admin_paused: '⏸ <b>Minting paused.</b>',
  admin_resumed: '▶️ <b>Minting resumed.</b>',
  admin_max_shares_set: (n: number) => `✅ <b>Max shares set to ${esc(n)}.</b>`,

  // Errors
  error_generic: (msg: string) => `❌ <b>Error</b>\n${LINE}\n<pre>${esc(msg)}</pre>`,
  error_rate_limit: '⚠️ <b>Too many requests — wait a moment.</b>',
  error_devmode_expired_mid: '⚠️ <b>Developer Mode expired — re-enable in Binance App.</b>',

  help_text: `<b>✦ ＪＡＧΞＲ · Guide</b>
${LINE}
<blockquote><b>1. Connect</b> — Scan QR in Binance App → Agentic Wallet
<b>2. Verify</b> — Fresh unminted wallet, .ai ID, Dev Mode, quota &amp; balance
<b>3. Mint</b> — Approve &amp; confirm to mint 10 shares (auto-claims $1 USDT reward)
<b>4. Security</b> — Already-minted accounts logout right away; pending checks have 20 min</blockquote>

<b>Commands:</b> /start · /help · /language · /admin`,

  minting_paused: `⏸ <b>Minting is currently paused by admin.</b>`,
};

const te: Translations = {
  welcome: `<b>✦ ＪＡＧΞＲ · మింట్ టెర్మినల్</b>
${LINE}
<b>మీ Binance Agentic Wallet ద్వారా సురక్షితంగా JAGENT మింట్ చేయండి.</b>

<blockquote><b>వివరాలు &amp; నిబంధనలు</b>
• <b>ధర</b> — లైవ్ (~5.55 USDT / షేర్)
• <b>గ్యాస్</b> — కనీసం 0.0005 BNB · 2% USDT బఫర్
• <b>సెల్ ట్యాక్స్</b> — 2% ప్రోటోకాల్ ట్యాక్స్
• <b>గమనిక</b> — ఒకే వ్యక్తి వాలెట్లకు రెఫెరల్ బహుమతులు చెల్లించబడకపోవచ్చు</blockquote>

🔒 <b>ప్రైవేట్ కీలు మీ Binance Appలోనే ఉంటాయి</b>`,

  btn_connect_wallet: '+ కొత్త వాలెట్',
  btn_my_wallets: '👛 నా వాలెట్లు',
  btn_status: '📊 స్థితి',
  btn_check_again: '🔄 రిఫ్రెష్',
  btn_mint: '🪙 మింట్ JAGENT',
  btn_sell: '💰 అమ్మండి',
  btn_disconnect: '🔌 లాగ్‌అవుట్',
  btn_reconnect: '🔗 మళ్ళీ కనెక్ట్',
  btn_confirm: '✅ నిర్ధారించండి',
  btn_cancel: '✕ రద్దు',
  btn_back: '← వెనుకకు',
  btn_refresh: '🔄 రిఫ్రెష్',

  connecting: `<b>✦ ＪＡＧΞＲ · కనెక్షన్</b>\n${LINE}\n<b>QR సెషన్ ప్రారంభమవుతోంది...</b>`,
  connect_qr_title: (url: string, code: string, expiry: string) =>
    `<b>✦ ＪＡＧΞＲ · కనెక్ట్ చేయండి</b>
${LINE}
<blockquote><b>1.</b> <b>Binance App → Agentic Wallet</b> తెరవండి
<b>2.</b> QR స్కాన్ చేయండి లేదా <a href="${esc(url)}">లాగిన్ లింక్ తెరవండి</a></blockquote>

• <b>పెయిరింగ్ కోడ్</b> — <code>${esc(code)}</code>
• <b>గడువు</b> — <b>${esc(expiry)}</b>

⚠️ <b>ఈ లింక్ లేదా కోడ్‌ను ఎవరితోనూ పంచుకోకండి.</b>`,
  connect_waiting: '⏳ <b>Binance Appలో అనుమతి కోసం వేచి ఉన్నాము...</b>',
  connect_success: (addr: string, label?: string) =>
    `✅ <b>కనెక్ట్ అయింది${label ? ` · ${esc(label)}` : ''}</b> · <code>${esc(addr)}</code>\n<b>అర్హత తనిఖీ చేస్తోంది...</b>`,
  connect_failed: `❌ <b>కనెక్షన్ విఫలమైంది</b>\n${LINE}\nదయచేసి మళ్ళీ ప్రయత్నించండి.`,
  connect_expired: `⏰ <b>QR కోడ్ గడువు తీరింది</b>\n${LINE}\nకొత్తది ప్రారంభించడానికి <b>+ కొత్త వాలెట్</b> నొక్కండి.`,
  already_connected: '✅ <b>వాలెట్ ఇప్పటికే కనెక్ట్ అయింది.</b>',

  session_logged_out_minted: (reason: string) =>
    `🔒 <b>సెషన్ లాగ్‌అవుట్ అయింది</b>\n${LINE}\n<blockquote><b>కారణం:</b> ${esc(reason)}</blockquote>`,
  session_logged_out_failed:
    `🔒 <b>సెషన్ లాగ్‌అవుట్ అయింది</b>\n${LINE}\n<b>సమస్యలను సరిచేసి మళ్ళీ కనెక్ట్ చేయండి.</b>`,
  session_logged_out_done: '🔒 <b>సెషన్ సురక్షితంగా మూసివేయబడింది.</b>',
  session_pending_refresh: '<b>Binance Appలో ❌ అంశాలు పూర్తి చేసి 🔄 రిఫ్రెష్ నొక్కండి.</b>',

  devmode_required: `🛠 <b>డెవలపర్ మోడ్ ఆన్ చేయండి</b>\n${LINE}\n<b>Binance App → Agentic Wallet → Settings → Developer Mode</b>`,

  eligibility_title: '<b>✦ ＪＡＧΞＲ · అర్హత తనిఖీ</b>',
  check_agent_id: 'Agent ID (.ai)',
  check_devmode: 'డెవలపర్ మోడ్',
  check_prev_mint: 'ఫ్రెష్ వాలెట్ స్థితి',
  check_quota: 'మింట్ కోటా',
  check_usdt: 'USDT బ్యాలెన్స్',
  check_bnb: 'BNB గ్యాస్',
  eligibility_passed: '✅ <b>అన్ని తనిఖీలు పాస్ — మింట్‌కు సిద్ధం!</b>',
  eligibility_failed: '⏳ <b>పెండింగ్ అంశాలు</b> — పరిష్కరించి <b>🔄 రిఫ్రెష్</b> నొక్కండి.',
  eligibility_failed_minted: '❌ <b>ఇప్పటికే మింట్ అయింది</b> — వాలెట్ లాగ్‌అవుట్ చేయబడింది.',

  mint_pick_shares: (max: number, note = '') =>
    `<b>✦ ＪＡＧΞＲ · షేర్లు ఎంచుకోండి</b>\n${LINE}\n<b>షేర్లు (గరిష్టంగా ${esc(max)}):</b>${note ? '\n• <b>' + esc(note) + '</b>' : ''}`,
  mint_pick_pay: `<b>✦ ＪＡＧΞＲ · చెల్లింపు విధానం</b>\n${LINE}\n<b>చెల్లింపు టోకెన్ ఎంచుకోండి:</b>`,
  btn_pay_usdt: '💵 USDT',
  btn_pay_bnb: '🟡 BNB',
  mint_fetching: `<b>✦ ＪＡＧΞＲ · సిద్ధం చేస్తోంది</b>\n${LINE}\n⏳ <b>సిమ్యులేషన్ &amp; గ్యాస్ అంచనా...</b>`,
  mint_cost_card: (shares: number, price: string, total: string, gas: string, ref: string, pay: string) =>
    `<b>✦ ＪＡＧΞＲ · మింట్ సారాంశం</b>
${LINE}
<blockquote>• <b>షేర్లు</b> — <b>${esc(shares)}</b>
• <b>షేర్ ధర</b> — <b>${esc(price)}</b>
• <b>మొత్తం (${esc(pay)})</b> — <code>${esc(total)}</code>
• <b>గ్యాస్ (+20%)</b> — <b>~${esc(gas)} BNB</b>
• <b>రెఫరర్</b> — <code>${esc(ref || 'none')}</code>
• <b>స్లిప్పేజ్</b> — <b>2%</b></blockquote>

⚠️ <b>ఒకే వ్యక్తి వాలెట్లకు ＪＡＧΞＲ రెఫెరల్ బహుమతులు చెల్లించబడకపోవచ్చు.</b>`,
  mint_confirm_prompt: '<b>ఆన్-చెయిన్ అమలుకు నిర్ధారించండి నొక్కండి.</b>',
  mint_contract_guard: `🛑 <b>భద్రతా హెచ్చరిక</b>\n${LINE}\n<b>అనుకోని కాంట్రాక్ట్ చిరునామా — మింట్ ఆపబడింది.</b>`,
  mint_success: (tx: string, shares: string, status: string, received: string, bnb: string, usdt: string, jagent: string) =>
    `<b>✦ ＪＡＧΞＲ · మింట్ పూర్తయింది</b>
${LINE}
<blockquote>• <b>షేర్లు</b> — <b>${esc(shares)} (${esc(status)})</b>
• <b>పొందినది</b> — <code>${esc(received)} JAGENT</code>
• <b>లావాదేవీ</b> — <a href="https://bscscan.com/tx/${esc(tx)}">BscScan లో చూడండి</a></blockquote>

<blockquote><b>కొత్త బ్యాలెన్సులు</b>
• <b>JAGENT</b> — <code>${esc(jagent)}</code>
• <b>USDT</b> — <code>${esc(usdt)}</code>
• <b>BNB</b> — <code>${esc(bnb)}</code></blockquote>`,
  mint_failed: (reason: string) => `❌ <b>మింట్ విఫలమైంది</b>\n${LINE}\n<pre>${esc(reason)}</pre>`,
  mint_aborted: '✕ <b>మింట్ రద్దు చేయబడింది.</b>',

  sell_title: '<b>✦ ＪＡＧΞＲ · టోకెన్ అమ్మకం</b>',
  sell_fetching_quote: `<b>✦ ＪＡＧΞＲ · విక్రయ కోట్</b>\n${LINE}\n⏳ <b>లైవ్ కోట్ తీసుకుంటోంది (5% స్లిప్పేజ్)...</b>`,
  sell_quote_card: (amount: string, receive: string, token: string, tax: string, impact: string, gas: string) =>
    `<b>✦ ＪＡＧΞＲ · విక్రయ కోట్</b>
${LINE}
<blockquote>• <b>అమ్మకం</b> — <code>${esc(amount)} JAGENT</code>
• <b>పొందటం</b> — <code>~${esc(receive)} ${esc(token)}</code>
• <b>ట్యాక్స్</b> — <b>${esc(tax)}%</b> · <b>స్లిప్పేజ్</b> — <b>5%</b>
• <b>ప్రభావం</b> — <b>${esc(impact)}</b>
• <b>గ్యాస్</b> — <b>~${esc(gas)} BNB</b></blockquote>`,
  sell_confirm_prompt: '<b>స్వాప్ చేయడానికి నిర్ధారించండి నొక్కండి.</b>',
  sell_executing: '⏳ <b>స్వాప్ అమలు చేస్తోంది...</b>',
  sell_success: (tx: string, status: string, received: string, token: string, extra = '') =>
    `<b>✦ ＪＡＧΞＲ · అమ్మకం పూర్తయింది</b>
${LINE}
<blockquote>• <b>స్థితి</b> — <b>${esc(status)}</b>
• <b>పొందినది</b> — <code>${esc(received)} ${esc(token)}</code>${extra ? '\n• <b>' + esc(extra) + '</b>' : ''}
• <b>లావాదేవీ</b> — <a href="https://bscscan.com/tx/${esc(tx)}">BscScan లో చూడండి</a></blockquote>`,
  sell_pending: (orderId: string) => `⏳ <b>ఆర్డర్ ప్రాసెస్ అవుతోంది</b>\n<code>${esc(orderId)}</code>`,
  sell_failed: (reason: string) => `❌ <b>అమ్మకం విఫలమైంది</b>\n${LINE}\n<pre>${esc(reason)}</pre>`,
  sell_aborted: '✕ <b>అమ్మకం రద్దు చేయబడింది.</b>',

  no_wallets: `<b>✦ ＪＡＧΞＲ · నా వాలెట్లు</b>\n${LINE}\n<b>వాలెట్లు లేవు. + కొత్త వాలెట్ నొక్కండి.</b>`,
  status_title: '<b>✦ ＪＡＧΞＲ · స్థితి &amp; చరిత్ర</b>',

  admin_title: '<b>✦ ＪＡＧΞＲ · అడ్మిన్ కన్సోల్</b>',
  admin_not_authorized: '⛔ <b>అనుమతి లేదు.</b>',
  admin_ref_set: (ref: string) => `✅ <b>రెఫెరల్:</b> <code>${esc(ref)}</code>`,
  admin_paused: '⏸ <b>మింటింగ్ పాజ్ అయింది.</b>',
  admin_resumed: '▶️ <b>మింటింగ్ ప్రారంభమైంది.</b>',
  admin_max_shares_set: (n: number) => `✅ <b>గరిష్ట షేర్లు: ${esc(n)}</b>`,

  error_generic: (msg: string) => `❌ <b>లోపం</b>\n${LINE}\n<pre>${esc(msg)}</pre>`,
  error_rate_limit: '⚠️ <b>దయచేసి కొద్దిగా ఆగండి.</b>',
  error_devmode_expired_mid: '⚠️ <b>డెవలపర్ మోడ్ గడువు తీరింది.</b>',

  help_text: `<b>✦ ＪＡＧΞＲ · గైడ్</b>
${LINE}
<blockquote><b>1. కనెక్ట్</b> — Binance App లో QR స్కాన్ చేయండి
<b>2. తనిఖీ</b> — ఫ్రెష్ వాలెట్, .ai ID, Dev Mode, కోటా &amp; బ్యాలెన్స్
<b>3. మింట్</b> — నిర్ధారించి 10 షేర్లు మింట్ చేయండి ($1 రివార్డ్ ఆటో క్లెయిమ్)
<b>4. భద్రత</b> — ఇప్పటికే మింట్ అయిన వాలెట్ తక్షణ లాగ్‌అవుట్; పెండింగ్ అంశాలకు 20 ని.</blockquote>

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

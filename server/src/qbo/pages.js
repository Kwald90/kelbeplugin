// The few HTML pages the QuickBooks connection serves outside the app (docs/integrations/quickbooks.md
// 2.2, 7.2): the connect interstitial, the "done" page the iOS browser lands on and the page behind
// Intuit's disconnect URL. Static text, no scripts, nothing from QuickBooks; the only dynamic values
// (the Fishtape company name and the requester's email) are escaped.
import { BRAND } from '../brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Headers for the done and disconnected pages. */
export const PAGE_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

/**
 * Headers for the interstitial: the same, plus form-action for its one POST. Browsers also apply
 * form-action to the redirect that answers the POST, so Intuit's authorize origin is allowed too.
 * @param {string} authorizeUrl Intuit's authorize endpoint (config.qbo.oauth.authorize)
 */
export function interstitialHeaders(authorizeUrl) {
  let intuit = '';
  try { intuit = ` ${new URL(authorizeUrl).origin}`; } catch { /* no extra origin */ }
  return Object.freeze({
    ...PAGE_HEADERS,
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${intuit}; frame-ancestors 'none'; base-uri 'none'`,
  });
}

const STYLE = `body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1d2330}
main{max-width:460px;margin:8vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px}.row{display:flex;gap:12px;align-items:center;margin-top:20px}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 18px;background:#2ca01c;color:#fff;cursor:pointer}
a{color:#0d5bd7}.muted{color:#5b6475;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#12151b;color:#e6e9ef}main{background:#1c2029;box-shadow:none}.muted{color:#a2a9b8}a{color:#7fb0ff}}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * The connect interstitial: names the Fishtape company and the person who asked, so a QuickBooks
 * admin sent someone else's link can see whose books it would connect to (TM-QBO-01).
 * @param {{ tenantName: string, userEmail: string|null, ticket: string, action?: string, cancelUrl: string }} o
 */
export function interstitialPage({ tenantName, userEmail, ticket, action = '/api/v1/qbo/oauth/start', cancelUrl }) {
  return page(`Connect QuickBooks to ${BRAND.name}`, `<h1>Connect QuickBooks</h1>
<p>Connect QuickBooks to the ${esc(BRAND.name)} company <strong>${esc(tenantName)}</strong>, requested by <strong>${esc(userEmail || 'a company admin')}</strong>.</p>
<p class="muted">Only continue if you work with ${esc(tenantName)} and expected this. The next page is Intuit's, where you choose the QuickBooks company.</p>
<form method="post" action="${esc(action)}"><input type="hidden" name="ticket" value="${esc(ticket)}">
<div class="row"><button type="submit">Connect</button><a href="${esc(cancelUrl)}">Cancel</a></div></form>`);
}

/** What each connect result says on the done page (no data, fixed text). */
export const RESULT_TEXT = {
  ok: ['QuickBooks is connected', `QuickBooks is connected. Go back to ${BRAND.name}.`],
  state_invalid: ['This link has expired', `The connect link expired or was already used. Go back to ${BRAND.name} and press Connect to QuickBooks again.`],
  forbidden: ['Not allowed', 'Only an owner or admin of the company can connect QuickBooks.'],
  plan: ['Not in your plan', `QuickBooks sync is part of the ${BRAND.name} Pro plan and up.`],
  denied: ['Not connected', `QuickBooks was not connected. You can try again from ${BRAND.name} any time.`],
  exchange_failed: ['Something went wrong', `QuickBooks did not finish connecting. Go back to ${BRAND.name} and try again in a minute.`],
  not_canada: ['Canadian companies only', `${BRAND.name} connects to Canadian QuickBooks Online companies only.`],
  not_cad: ['Canadian dollars only', `${BRAND.name} connects to QuickBooks companies whose home currency is the Canadian dollar.`],
  realm_in_use: ['Already connected elsewhere', `This QuickBooks company is connected to another ${BRAND.name} company. Go back to ${BRAND.name} to see your options.`],
  wrong_company: ['A different QuickBooks company', `That is not the QuickBooks company this ${BRAND.name} company was connected to. Reconnect with the same company.`],
  purge_required: ['Delete the old links first', `This ${BRAND.name} company still has links to another QuickBooks company. Delete them in ${BRAND.name} first, then connect.`],
  unavailable: ['Not available', `QuickBooks is not available on this ${BRAND.name} server.`],
};

/** @param {string} result */
export function donePage(result) {
  const [title, text] = RESULT_TEXT[result] || RESULT_TEXT.exchange_failed;
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p class="muted">You can close this window.</p>`);
}

/** Behind Intuit's disconnect URL: it changes nothing (it carries no proof of who calls, 2.7). */
export function disconnectedPage() {
  return page(`${BRAND.name} and QuickBooks`, `<h1>Disconnected from QuickBooks</h1>
<p>${esc(BRAND.name)} is disconnected from QuickBooks. To connect again, sign in to ${esc(BRAND.name)} and open QuickBooks.</p>`);
}

// HQ Mail reading pane. Received HTML (already sanitized by the server, src/email/sanitize.js)
// is shown in a sandboxed iframe built from srcdoc:
//   - sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox": no allow-scripts,
//     so nothing in a message can ever run; same-origin only so this page can apply the
//     sanitized styles through CSSOM (the HQ CSP blocks style attributes) and size the frame.
//   - a strict CSP of its own (meta in srcdoc) on top of the HQ page's, which it inherits.
//   - remote images are blocked by the server until "Show images", then come through the
//     server's image proxy; links open in a new tab with noopener/noreferrer.
import { MAIL_ICONS as I } from './icons.js';

const FRAME_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
// The message canvas. Mail is written for a light page, so it stays light in dark mode, as in Outlook.
const FRAME_BASE = 'html{background:#fff;color:#1c1b19}body{margin:16px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}'
  + 'img{max-width:100%;height:auto}img[data-ft-blocked]{display:inline-block;min-width:24px;min-height:18px;background:#f1efea;outline:1px dashed #b9b4a9}'
  + 'table{max-width:100%}pre,.ft-text{white-space:pre-wrap;font:inherit;margin:0}a{color:#1f5fb8}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d8d3c8;color:#5f5a51}';

/**
 * The message body in a sandboxed, scriptless iframe.
 * @param {(tag: string, props?: object, ...children: any[]) => HTMLElement} h
 * @param {{ html: string, css: string, bodyStyle: string }} render
 * @param {{ onKey?: (e: KeyboardEvent) => void, onMailto?: (address: string) => void }} [o]
 */
export function messageFrame(h, render, o = {}) {
  const frame = h('iframe', {
    class: 'mail-frame', title: 'Message', referrerpolicy: 'no-referrer',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`
    + `<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"></head><body>${render.html}</body></html>`;
  let ro = null;
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return;
    try {
      const sheets = [];
      const base = new win.CSSStyleSheet();
      base.replaceSync(FRAME_BASE);
      sheets.push(base);
      if (render.css) {
        const s = new win.CSSStyleSheet();
        try { s.replaceSync(render.css); sheets.push(s); } catch { /* a rule the browser rejects: skip the sheet */ }
      }
      doc.adoptedStyleSheets = sheets;
    } catch { /* very old browser: unstyled but safe */ }
    if (render.bodyStyle) doc.body.style.cssText += `;${render.bodyStyle}`;
    for (const el of doc.querySelectorAll('[data-ft-style]')) el.style.cssText = el.getAttribute('data-ft-style');
    doc.addEventListener('click', (e) => {
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('mailto:') && o.onMailto) { o.onMailto(decodeURIComponent(href.slice(7).split('?')[0])); return; }
      window.open(href, '_blank', 'noopener,noreferrer');
    });
    if (o.onKey) doc.addEventListener('keydown', o.onKey);
    const fit = () => { frame.style.height = `${Math.max(140, doc.documentElement.scrollHeight + 4)}px`; };
    fit();
    ro = new ResizeObserver(fit);
    ro.observe(doc.documentElement);
  });
  return { el: frame, destroy: () => ro?.disconnect() };
}

const who = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '');
const list = (l) => (l || []).map(who).join('; ');

const EVENT_LABEL = {
  processed: 'Accepted by SendGrid', delivered: 'Delivered', deferred: 'Delayed', bounce: 'Bounced', dropped: 'Dropped', spamreport: 'Marked as spam',
  open: 'Opened', click: 'Clicked', unsubscribe: 'Unsubscribed', group_unsubscribe: 'Unsubscribed', group_resubscribe: 'Resubscribed',
};

/** Where an outgoing message is, as Outlook would say it. */
export function deliveryState(m) {
  const d = m.deliveryStatus;
  if (m.sendStatus === 'failed') return { tone: 'danger', label: 'Not sent', text: m.deliveryDetail || 'Sending failed.' };
  if (m.sendStatus === 'queued' || m.sendStatus === 'sending') return { tone: 'info', label: 'In the Outbox', text: m.sendStatus === 'sending' ? 'Sending now.' : 'Waiting to be sent. The worker sends queued mail every minute.' };
  if (d === 'deferred') return { tone: 'warning', label: 'Delayed', text: m.deliveryDetail || 'The receiving server asked SendGrid to try again later.' };
  if (d === 'delivered') return { tone: 'success', label: 'Delivered', text: 'The receiving server accepted it.' };
  if (d === 'spamreport') return { tone: 'warning', label: 'Marked as spam', text: 'The recipient reported it as spam.' };
  if (d === 'processed') return { tone: 'neutral', label: 'Sent', text: 'SendGrid accepted it and is delivering it.' };
  return { tone: 'neutral', label: 'Sent', text: 'Handed to SendGrid. Delivery events appear here when the Event Webhook is set up.' };
}

function eventsTable(ui, events) {
  const { h } = ui;
  if (!events?.length) return null;
  return h('ol', { class: 'mail-events' }, events.map((e) => h('li', { class: `ev-${e.event}` },
    h('span', { class: 'when' }, ui.fmtDateTime(e.at)),
    h('strong', null, EVENT_LABEL[e.event] || e.event),
    e.recipient ? h('span', { class: 'muted' }, e.recipient) : null,
    e.reason ? h('span', { class: 'why' }, e.reason) : null)));
}

/**
 * The reading pane for one message.
 * @param {object} ctx { ui, onShowImages, onOpen(id), onToDrafts(id), onKey, onMailto, download(url) }
 * @param {object} m GET /api/hq/mail/messages/:id
 */
export function messageView(ctx, m) {
  const { ui } = ctx;
  const { h } = ui;
  const parts = [];
  parts.push(h('header', { class: 'mail-read-head' },
    h('h2', null, m.subject || '(no subject)'),
    h('div', { class: 'mail-badges' },
      m.flagged ? ui.badge('Flagged', 'danger') : null,
      m.spam ? ui.badge(`Junk${m.spamScore != null ? ` · score ${m.spamScore}` : ''}`, 'warning') : null,
      m.assignedName ? ui.badge(`Assigned to ${m.assignedName}`, 'info') : null,
      m.source === 'support' ? ui.badge('In-app support', 'accent') : null,
      ui.badge(m.mailbox.name, 'neutral'))));
  parts.push(h('dl', { class: 'mail-meta' },
    h('dt', null, 'From'), h('dd', null, who(m.from) || '—'),
    m.replyTo?.length && who(m.replyTo[0]) !== who(m.from) ? [h('dt', null, 'Reply to'), h('dd', null, list(m.replyTo))] : null,
    h('dt', null, 'To'), h('dd', null, list(m.to) || '—'),
    m.cc?.length ? [h('dt', null, 'Cc'), h('dd', null, list(m.cc))] : null,
    m.bcc?.length ? [h('dt', null, 'Bcc'), h('dd', null, list(m.bcc))] : null,
    h('dt', null, m.direction === 'out' ? 'Sent' : 'Received'), h('dd', null, ui.fmtDateTime(m.direction === 'out' ? (m.sentAt || m.date) : m.date))));

  if (m.meta?.kind === 'support') {
    const s = m.meta;
    parts.push(h('div', { class: 'mail-card info' },
      h('strong', null, `Support request ${s.reference || ''}`),
      h('dl', { class: 'hq-kv' },
        h('dt', null, 'Company'), h('dd', null, `${s.tenantName || '—'}${s.plan ? ` (${s.plan})` : ''}`),
        h('dt', null, 'Person'), h('dd', null, `${s.userName || '—'}${s.role ? `, ${s.role}` : ''}`),
        h('dt', null, 'App version'), h('dd', null, s.appVersion || '—'),
        s.page ? [h('dt', null, 'Screen'), h('dd', null, s.page)] : null,
        h('dt', null, 'Category'), h('dd', null, s.category || '—'))));
  }

  if (m.direction === 'out' && m.folder !== 'drafts') {
    const st = deliveryState(m);
    parts.push(h('div', { class: ['mail-card', st.tone] },
      h('div', { class: 'mail-card-head' }, h('strong', null, st.label), h('span', null, st.text)),
      eventsTable(ui, m.events),
      m.sendStatus === 'failed' || m.sendStatus === 'queued'
        ? h('div', { class: 'mail-card-actions' }, ui.button(m.sendStatus === 'failed' ? 'Edit and send again' : 'Stop sending', { size: 'sm', icon: I.drafts, onClick: () => ctx.onToDrafts(m.id) }))
        : null));
  }

  if (m.render.blockedImages > 0 || m.render.trackers > 0) {
    parts.push(h('div', { class: 'mail-images-bar' },
      ui.icon(I.notsent, 16),
      h('span', null, m.render.images === 'allow'
        ? 'Pictures are shown through Fishtape\'s image proxy.'
        : `${m.render.blockedImages ? `${m.render.blockedImages} picture${m.render.blockedImages === 1 ? '' : 's'} blocked to protect your privacy.` : ''}${m.render.trackers ? ` ${m.render.trackers} tracking pixel${m.render.trackers === 1 ? '' : 's'} removed.` : ''}`.trim()),
      m.render.images === 'allow' ? null : ui.button('Show images', { size: 'sm', onClick: ctx.onShowImages })));
  }

  const files = (m.attachments || []).filter((a) => !a.inline);
  if (files.length || m.rawAvailable) {
    parts.push(h('ul', { class: 'mail-attachments', 'aria-label': 'Attachments' },
      files.map((a) => h('li', null, h('a', { href: `/api/hq/mail/attachments/${a.id}`, download: a.filename, rel: 'noopener' },
        ui.icon(I.clip, 16), h('span', { class: 'name' }, a.filename), h('span', { class: 'size' }, size(a.size))))),
      m.rawAvailable ? h('li', { class: 'raw' }, h('a', { href: `/api/hq/mail/messages/${m.id}/raw`, download: 'message.eml', rel: 'noopener' }, ui.icon('download', 16), h('span', { class: 'name' }, 'Original (.eml)'))) : null));
  }

  const frame = messageFrame(h, m.render, { onKey: ctx.onKey, onMailto: ctx.onMailto });
  parts.push(h('div', { class: 'mail-body' }, frame.el));

  const others = (m.thread || []).filter((t) => t.id !== m.id);
  if (others.length) {
    parts.push(h('section', { class: 'mail-thread', 'aria-label': 'Conversation' },
      h('h3', null, `Conversation (${m.thread.length})`),
      m.thread.map((t) => h('button', {
        type: 'button', class: ['mail-thread-item', t.id === m.id ? 'current' : null, t.read ? null : 'unread'], disabled: t.id === m.id,
        onClick: () => ctx.onOpen(t.id),
      },
      h('span', { class: 'who' }, t.direction === 'out' ? `To ${list(t.to)}` : who(t.from)),
      h('span', { class: 'when' }, ui.fmtDateTime(t.date)),
      h('span', { class: 'prev' }, t.preview || t.subject),
      t.direction === 'out' && t.sendStatus === 'failed' ? ui.badge('Not sent', 'danger') : null))));
  }
  return { el: h('article', { class: 'mail-read', 'aria-label': m.subject || 'Message' }, parts), destroy: frame.destroy };
}

/** A system email (password reset, invite, alert): who, status and events, never the body. */
export function systemView(ctx, s) {
  const { ui } = ctx;
  const { h } = ui;
  const st = deliveryState({ sendStatus: s.status, deliveryStatus: s.deliveryStatus, deliveryDetail: s.status === 'failed' ? s.error : s.deliveryDetail });
  return {
    el: h('article', { class: 'mail-read' },
      h('header', { class: 'mail-read-head' }, h('h2', null, s.subject), h('div', { class: 'mail-badges' }, ui.badge('System email', 'neutral'), s.template ? ui.badge(s.template, 'info') : null)),
      h('dl', { class: 'mail-meta' },
        h('dt', null, 'To'), h('dd', null, s.to),
        h('dt', null, 'Queued'), h('dd', null, ui.fmtDateTime(s.createdAt)),
        h('dt', null, 'Sent'), h('dd', null, s.sentAt ? ui.fmtDateTime(s.sentAt) : '—'),
        h('dt', null, 'Attempts'), h('dd', null, String(s.attempts)),
        h('dt', null, 'Provider'), h('dd', null, s.provider || '—')),
      h('div', { class: ['mail-card', st.tone] }, h('div', { class: 'mail-card-head' }, h('strong', null, st.label), h('span', null, st.text)), eventsTable(ui, s.events)),
      h('p', { class: 'muted hq-small' }, s.note)),
    destroy: () => {},
  };
}

export function size(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

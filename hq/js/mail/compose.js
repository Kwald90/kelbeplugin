// HQ Mail compose: new mail, reply, reply all, forward and drafts, in the reading pane or a
// pop-out window. A small rich-text editor (bold, italic, lists, links). Pasted content comes
// in as plain text, so no outside markup (or inline styles the CSP would block) gets in; the
// server sanitizes the HTML again before it is stored or sent.
import { api, post } from '../api.js';
import { MAIL_ICONS as I } from './icons.js';
import { size } from './reader.js';

const MAX_UPLOAD = 20 * 1024 * 1024;

const who = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '');
const splitList = (s) => String(s || '').split(/[;,]\s*|\n/).map((x) => x.trim()).filter(Boolean);
const prefixed = (subject, p) => (new RegExp(`^${p}:`, 'i').test(subject || '') ? subject : `${p}: ${subject || ''}`.trim());

/** A contenteditable editor with a toolbar. Returns { el, editor }. */
export function richEditor(ui, { html = '', label = 'Message', onChange } = {}) {
  const { h } = ui;
  const editor = h('div', { class: 'mail-editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, spellcheck: 'true' });
  editor.innerHTML = html; // server-sanitized HTML (compose mode: no styles, no remote images)
  const cmd = (name, value = null) => () => {
    editor.focus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(name, false, value);
    onChange?.();
  };
  const link = async () => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const raw = await ui.promptDialog('Link address (https://… or mailto:…)', { title: 'Insert link', value: 'https://' });
    const url = String(raw || '').trim();
    if (!url) return;
    if (!/^(https?:\/\/\S+|mailto:\S+)$/i.test(url)) { ui.toast('Use a link that starts with https:// or mailto:', 'error'); return; }
    editor.focus();
    if (range && !range.collapsed) {
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('createLink', false, url);
    } else {
      // Nothing selected: insert the address itself as the link text.
      const a = h('a', { href: url }, url);
      const r = range || (() => { const x = document.createRange(); x.selectNodeContents(editor); x.collapse(false); return x; })();
      r.insertNode(a);
      r.setStartAfter(a);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    onChange?.();
  };
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') || '';
    document.execCommand('insertText', false, text);
    onChange?.();
  });
  editor.addEventListener('drop', (e) => { if (e.dataTransfer?.types?.includes('text/html')) e.preventDefault(); });
  editor.addEventListener('input', () => onChange?.());
  const tool = (icon, title, fn) => h('button', { type: 'button', class: 'btn ghost sm icon', title, 'aria-label': title, onMousedown: (e) => e.preventDefault(), onClick: fn }, ui.icon(icon, 16));
  const bar = h('div', { class: 'mail-tools', role: 'toolbar', 'aria-label': 'Formatting' },
    tool(I.bold, 'Bold (Ctrl+B)', cmd('bold')), tool(I.italic, 'Italic (Ctrl+I)', cmd('italic')),
    tool(I.ul, 'Bulleted list', cmd('insertUnorderedList')), tool(I.ol, 'Numbered list', cmd('insertOrderedList')),
    tool(I.link, 'Link (Ctrl+K)', link), tool(I.clear, 'Clear formatting', cmd('removeFormat')));
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
  });
  return { el: h('div', { class: 'mail-editor-wrap' }, bar, editor), editor };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** The "From:/Sent:/To:/Subject:" block above a quoted message, built as DOM (text escaped). */
function quoteBlock(ui, m) {
  const { h } = ui;
  const line = (k, v) => (v ? h('div', null, h('b', null, `${k}: `), v) : null);
  const block = h('div', null,
    h('br'), h('hr'),
    line('From', who(m.from)), line('Sent', ui.fmtDateTime(m.date)), line('To', (m.to || []).map(who).join('; ')),
    line('Cc', (m.cc || []).map(who).join('; ')), line('Subject', m.subject));
  const quote = h('blockquote');
  quote.innerHTML = m.quoteHtml || ''; // server-sanitized (compose mode)
  block.append(quote);
  return block;
}

/**
 * Open a compose pane.
 * @param {object} ctx { ui, overview, mailboxId, onClose(reason), onSent(id), popout?: boolean }
 * @param {{ mode: 'new'|'reply'|'replyAll'|'forward'|'draft', message?: object, to?: string }} o
 */
export function composer(ctx, o) {
  const { ui } = ctx;
  const { h } = ui;
  const mailboxes = ctx.overview.mailboxes;
  const m = o.message || null;
  const own = new Set(mailboxes.flatMap((b) => [b.address, b.fromAddress, ...(b.aliases || [])]).filter(Boolean).map((x) => x.toLowerCase()));
  const notOwn = (a) => a?.address && !own.has(a.address.toLowerCase());
  let mailboxId = (m?.mailbox?.id && mailboxes.some((b) => b.id === m.mailbox.id) ? m.mailbox.id : null) || ctx.mailboxId || mailboxes[0]?.id;
  let draftId = o.mode === 'draft' ? m.id : null;
  let dirty = false;
  let busy = false;
  const attachments = [];

  // Recipients and subject by mode, as Outlook fills them.
  let to = [], cc = [], bcc = [], subject = '';
  if (o.mode === 'reply' || o.mode === 'replyAll') {
    const back = m.direction === 'out' ? m.to : (m.replyTo?.length ? m.replyTo : [m.from]);
    to = back.filter(notOwn).map(who);
    if (o.mode === 'replyAll') {
      to = [...to, ...(m.direction === 'out' ? [] : m.to.filter(notOwn).map(who))];
      cc = (m.cc || []).filter(notOwn).map(who);
    }
    subject = prefixed(m.subject, 'RE');
  } else if (o.mode === 'forward') {
    subject = prefixed(m.subject, 'FW');
  } else if (o.mode === 'draft') {
    to = m.to.map(who); cc = m.cc.map(who); bcc = m.bcc.map(who); subject = m.subject;
    for (const a of m.attachments || []) attachments.push({ id: a.id, filename: a.filename, size: a.size });
  }
  if (o.to) to = [o.to];
  to = [...new Set(to)]; cc = [...new Set(cc)].filter((x) => !to.includes(x));

  const signature = () => mailboxes.find((b) => b.id === mailboxId)?.signatureHtml || '';
  const fromSel = h('select', { class: 'input', 'aria-label': 'From', onChange: (e) => { mailboxId = e.target.value; dirty = true; } },
    mailboxes.map((b) => h('option', { value: b.id, selected: b.id === mailboxId }, `${b.fromName || b.name} <${b.fromAddress || b.address}>`)));
  const input = (label, value) => h('input', { class: 'input', type: 'text', value: value.join('; '), 'aria-label': label, autocomplete: 'off', spellcheck: 'false', onInput: () => { dirty = true; } });
  const toIn = input('To', to);
  const ccIn = input('Cc', cc);
  const bccIn = input('Bcc', bcc);
  const subjIn = h('input', { class: 'input', type: 'text', value: subject, 'aria-label': 'Subject', maxlength: 900, onInput: () => { dirty = true; } });
  const ccRow = h('label', { class: ['mail-field', cc.length ? null : 'hidden'] }, h('span', null, 'Cc'), ccIn);
  const bccRow = h('label', { class: ['mail-field', bcc.length ? null : 'hidden'] }, h('span', null, 'Bcc'), bccIn);

  const startHtml = o.mode === 'draft' ? (m.draft?.html || '') : `<p><br></p>${signature()}`;
  const ed = richEditor(ui, { html: startHtml, onChange: () => { dirty = true; } });
  if (m && ['reply', 'replyAll', 'forward'].includes(o.mode)) ed.editor.append(quoteBlock(ui, m));

  const chips = h('ul', { class: 'mail-attachments edit', 'aria-label': 'Attachments' });
  const drawChips = () => {
    ui.clear(chips);
    for (const a of attachments) {
      chips.append(h('li', null, h('span', { class: 'chip' }, ui.icon(I.clip, 14), h('span', { class: 'name' }, a.filename), h('span', { class: 'size' }, a.uploading ? 'uploading…' : size(a.size)),
        h('button', { type: 'button', class: 'btn ghost sm icon', title: `Remove ${a.filename}`, 'aria-label': `Remove ${a.filename}`, onClick: () => { attachments.splice(attachments.indexOf(a), 1); dirty = true; drawChips(); } }, ui.icon('x', 14)))));
    }
  };
  drawChips();
  if (o.mode === 'forward' && m.attachments?.some((a) => !a.inline)) {
    const placeholder = { id: null, filename: 'Attachments from the original', size: 0, uploading: true };
    attachments.push(placeholder);
    drawChips();
    post(`/api/hq/mail/messages/${m.id}/forward-attachments`).then((r) => {
      attachments.splice(attachments.indexOf(placeholder), 1, ...r.data.filter((a) => !a.inline).map((a) => ({ id: a.id, filename: a.filename, size: a.size })));
      drawChips();
    }).catch((e) => { attachments.splice(attachments.indexOf(placeholder), 1); drawChips(); ui.toast(`Attachments could not be copied: ${e.message}`, 'error', 4500); });
  }

  async function attach() {
    const file = await ui.pickFile('*/*');
    if (!file) return;
    if (file.size > MAX_UPLOAD) { ui.toast('Attachments are limited to 20 MB.', 'error'); return; }
    const a = { id: null, filename: file.name, size: file.size, uploading: true };
    attachments.push(a);
    drawChips();
    try {
      const r = await post('/api/hq/mail/uploads', { filename: file.name, contentType: file.type || 'application/octet-stream', data: await fileToBase64(file) });
      Object.assign(a, { id: r.id, uploading: false, size: r.size });
      dirty = true;
    } catch (e) {
      attachments.splice(attachments.indexOf(a), 1);
      ui.toast(`${file.name} could not be attached: ${e.message}`, 'error', 4500);
    }
    drawChips();
  }

  function payload() {
    return {
      mailboxId, ...(draftId ? { draftId } : {}),
      to: splitList(toIn.value), cc: splitList(ccIn.value), bcc: splitList(bccIn.value),
      subject: subjIn.value.trim(), html: ed.editor.innerHTML,
      ...(m && (o.mode === 'reply' || o.mode === 'replyAll') ? { replyToId: m.id } : {}),
      ...(m && o.mode === 'forward' ? { forwardOfId: m.id } : {}),
      attachmentIds: attachments.filter((a) => a.id).map((a) => a.id),
    };
  }

  async function saveDraft({ quiet = false } = {}) {
    if (busy) return null;
    if (attachments.some((a) => a.uploading)) { ui.toast('Wait for the attachments to finish uploading.', 'info'); return null; }
    busy = true;
    try {
      const r = await post('/api/hq/mail/drafts', payload());
      draftId = r.id;
      dirty = false;
      if (!quiet) ui.toast('Draft saved', 'success');
      return r.id;
    } catch (e) {
      ui.toast(e.message, 'error', 4500);
      return null;
    } finally { busy = false; }
  }

  async function send() {
    if (busy) return;
    const p = payload();
    if (!p.to.length && !p.cc.length && !p.bcc.length) { ui.toast('Add at least one recipient.', 'error'); toIn.focus(); return; }
    if (attachments.some((a) => a.uploading)) { ui.toast('Wait for the attachments to finish uploading.', 'info'); return; }
    if (!p.subject && !(await ui.confirmDialog('Send this message without a subject?', { title: 'No subject', okLabel: 'Send anyway', danger: false }))) return;
    busy = true;
    sendBtn.disabled = true;
    try {
      const r = await post('/api/hq/mail/send', p);
      dirty = false;
      ui.toast('Sent. It is in the Outbox until SendGrid has it.', 'success');
      ctx.onSent?.(r.id);
    } catch (e) {
      ui.toast(e.message, 'error', 5000);
    } finally { busy = false; sendBtn.disabled = false; }
  }

  async function discard() {
    if (dirty && !(await ui.confirmDialog('Discard this message?', { title: 'Discard', okLabel: 'Discard' }))) return;
    if (draftId && o.mode !== 'draft') await api('/api/hq/mail/messages', { method: 'PATCH', body: { ids: [draftId], folder: 'trash' } }).catch(() => {});
    dirty = false;
    ctx.onClose?.('discard');
  }

  async function popOut() {
    const id = await saveDraft({ quiet: true });
    if (!id) return;
    const w = window.open(`/hq/#/mail/compose/${id}`, '_blank', 'popup,width=920,height=780');
    if (!w) { ui.toast('The browser blocked the new window. Allow pop-ups for HQ.', 'error', 4500); return; }
    ctx.onClose?.('popout');
  }

  const sendBtn = ui.button('Send', { variant: 'primary', icon: I.sent, onClick: send, title: 'Send (Ctrl+Enter)' });
  const el = h('section', { class: ['mail-compose', ctx.popout ? 'popout' : null], 'aria-label': 'New message' },
    h('div', { class: 'mail-compose-bar' },
      sendBtn,
      ui.button('Attach', { icon: I.clip, onClick: attach }),
      ui.button('Save draft', { variant: 'ghost', icon: 'save', onClick: () => saveDraft() }),
      h('span', { class: 'grow' }),
      ctx.popout ? null : ui.button('', { variant: 'ghost', icon: I.popout, title: 'Open in a new window', onClick: popOut }),
      ui.button('', { variant: 'ghost', icon: 'trash', title: 'Discard', onClick: discard })),
    h('div', { class: 'mail-fields' },
      h('label', { class: 'mail-field' }, h('span', null, 'From'), fromSel),
      h('label', { class: 'mail-field' }, h('span', null, 'To'), toIn,
        h('span', { class: 'mail-field-more' },
          h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { ccRow.classList.remove('hidden'); ccIn.focus(); } }, 'Cc'),
          h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { bccRow.classList.remove('hidden'); bccIn.focus(); } }, 'Bcc'))),
      ccRow, bccRow,
      h('label', { class: 'mail-field' }, h('span', null, 'Subject'), subjIn)),
    chips,
    ed.el);
  return {
    el, send, saveDraft, discard,
    isDirty: () => dirty,
    focus: () => (o.mode === 'reply' || o.mode === 'replyAll' || o.mode === 'draft' ? ed.editor : toIn).focus(),
  };
}

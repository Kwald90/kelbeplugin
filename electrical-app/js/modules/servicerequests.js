// Service requests (#/servicerequests): the resi service-shop front door, office side. Two tabs:
//   - Inbox: incoming kind:'service' leads (lib/service-requests.js serviceInbox), newest/most
//     urgent first, triaged into a scheduled job (reuses the Leads won->create-job path) or declined.
//   - Booking setup: claim the public booking slug, choose which service types and intake fields the
//     form offers, edit the confirmation message, and copy the hosted link + iframe embed snippet.
// The form's content is ordinary settings (settings.booking, synced like everything else); only the
// slug lives server-side (routes/v1/booking.js) because it is globally unique.
import { serviceInbox, summarizeRequest, urgencyLabel, urgencyRank, SERVICE_TYPES } from '../lib/service-requests.js';
import { OPTIONAL_FIELDS, normalizeBooking, embedSnippet, hostedLink, slugProblem, suggestSlug } from '../lib/booking.js';
import { setStage, openLeadSheet } from './leads.js';
import { api, session } from '../session.js';

const URGENCY_TONE = { emergency: 'danger', urgent: 'warning', soon: 'info', flexible: 'neutral' };

async function copyText(ui, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    ui.toast(`${label} copied`, 'success');
  } catch {
    ui.toast('Copy failed — select the text and copy it', 'error');
  }
}

// ---------- inbox ----------

function inboxView(ctx, body) {
  const { store, ui } = ctx;
  const { h } = ui;
  const requests = serviceInbox(store.list('leads'));
  ui.clear(body);
  if (!requests.length) {
    body.append(ui.empty({
      icon: 'mail', title: 'No service requests yet',
      text: 'Requests from your public booking page land here. Turn on your booking page in Booking setup and share the link.',
    }));
    return;
  }
  body.append(ui.table({
    columns: [
      { key: 'title', label: 'Request', render: (r) => h('div', null,
        h('div', { style: { fontWeight: 600 } }, r.contactName || r.title || 'Service request'),
        h('div', { class: 'muted crm-sub' }, summarizeRequest(r))) },
      { key: 'urgency', label: 'Urgency', sort: (r) => urgencyRank(r.urgency),
        render: (r) => ui.badge(urgencyLabel(r.urgency).split(' — ')[0] || 'Flexible', URGENCY_TONE[r.urgency] || 'neutral') },
      { key: 'contact', label: 'Contact', render: (r) => h('div', { class: 'muted crm-sub' }, [r.phone, r.email].filter(Boolean).join(' · ') || '—') },
      { key: 'when', label: 'Received', sort: (r) => r.createdAt || '', render: (r) => (r.createdAt ? ui.fmtDate(r.createdAt, { month: 'short', day: 'numeric' }) : '—') },
      { key: 'actions', label: '', render: (r) => h('div', { class: 'row' },
        ui.button('Schedule', { variant: 'primary', icon: 'briefcase', onClick: (e) => { e.stopPropagation(); setStage(ctx, store.get('leads', r.id), 'won'); } }),
        ui.button('Decline', { icon: 'x', onClick: async (e) => {
          e.stopPropagation();
          if (await ui.confirmDialog(`Decline the request from ${r.contactName || 'this customer'}?`, { okLabel: 'Decline', danger: true })) {
            setStage(ctx, store.get('leads', r.id), 'lost');
          }
        } })) },
    ],
    rows: requests,
    onRowClick: (r) => openLeadSheet(ctx, store.get('leads', r.id)),
  }));
}

// ---------- booking setup ----------

function fieldRow(ui, label, control, hint) {
  const { h } = ui;
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'muted crm-sub' }, hint) : null);
}

function setupView(ctx, body) {
  const { store, ui } = ctx;
  const { h } = ui;
  ui.clear(body);

  const s = store.settings();
  const booking = normalizeBooking(s.booking);
  // Server-held slug state (loaded below). Null until known.
  const state = { slug: '', enabled: false, loaded: false };

  const save = (patch) => {
    const next = normalizeBooking({ ...booking, ...patch });
    Object.assign(booking, next);
    store.saveSettings({ booking: next });
  };

  // --- the public link + embed snippet (shown once a slug is live) ---
  const linkCard = h('div', { class: 'card stack' });
  const renderLink = () => {
    ui.clear(linkCard);
    if (!state.loaded) { linkCard.append(h('p', { class: 'muted' }, 'Loading your booking link…')); return; }
    if (!state.slug) {
      linkCard.append(h('p', { class: 'muted' }, 'Claim a web address below to get your booking link and embed snippet.'));
      return;
    }
    const url = hostedLink(location.origin, state.slug);
    const snippet = embedSnippet(location.origin, state.slug);
    linkCard.append(
      h('h3', null, 'Your booking page'),
      h('div', { class: 'row' },
        ui.badge(state.enabled ? 'Live' : 'Off', state.enabled ? 'success' : 'neutral'),
        h('span', { class: 'muted crm-sub' }, state.enabled ? 'Accepting requests' : 'Turn it on below to accept requests')),
      fieldRow(ui, 'Hosted link (share directly)',
        h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: url }), ui.button('Copy', { icon: 'copy', onClick: () => copyText(ui, url, 'Link') }),
          ui.button('Open', { icon: 'external', onClick: () => window.open(url, '_blank', 'noopener') }))),
      fieldRow(ui, 'Embed on your website (paste this HTML)',
        h('div', { class: 'stack' }, h('textarea', { class: 'input', readonly: true, rows: 3 }, snippet), ui.button('Copy embed code', { icon: 'copy', onClick: () => copyText(ui, snippet, 'Embed code') }))));
  };

  // --- slug claim + on/off (server-backed) ---
  const claimCard = h('div', { class: 'card stack' });
  const renderClaim = () => {
    ui.clear(claimCard);
    if (session.isDemo() || !session.online) {
      claimCard.append(h('h3', null, 'Booking web address'),
        h('p', { class: 'muted' }, 'Sign in to your company and connect to the internet to claim your public booking address.'));
      return;
    }
    const slugInput = h('input', { class: 'input', value: state.slug || suggestSlug(s.company?.name), placeholder: 'your-shop', maxlength: 63, 'aria-label': 'Booking web address' });
    const status = h('div', { class: 'muted crm-sub' });
    const enableToggle = h('input', { type: 'checkbox', checked: state.enabled });
    const claim = async () => {
      const slug = String(slugInput.value || '').trim().toLowerCase();
      const problem = slugProblem(slug);
      if (problem) { status.textContent = problem; return; }
      status.textContent = 'Saving…';
      try {
        const out = await api.put('/api/v1/booking', { slug, enabled: enableToggle.checked });
        state.slug = out.page?.slug || slug; state.enabled = Boolean(out.page?.enabled);
        status.textContent = '';
        ui.toast('Booking page saved', 'success');
        renderClaim(); renderLink();
      } catch (e) {
        status.textContent = e.code === 'slug_taken' ? 'That address is already in use. Try another.'
          : e.code === 'feature_not_in_plan' ? 'Online booking is on the Fully Loaded plan and up.'
            : e.message || 'Could not save. Try again.';
      }
    };
    claimCard.append(
      h('h3', null, 'Booking web address'),
      fieldRow(ui, 'Address',
        h('div', { class: 'row' }, h('span', { class: 'muted' }, '…/book/'), slugInput, ui.button('Save', { variant: 'primary', onClick: claim })),
        'Lower-case letters, numbers and dashes. This is the public link customers use.'),
      h('label', { class: 'row' }, enableToggle, h('span', null, 'Accept requests (turn the page on)')),
      status);
    enableToggle.addEventListener('change', () => { if (state.slug) claim(); });
  };

  // --- what the form offers (settings) ---
  const formCard = h('div', { class: 'card stack' });
  const businessName = h('input', { class: 'input', value: booking.businessName, placeholder: s.company?.name || 'Your shop', maxlength: 120 });
  businessName.addEventListener('change', () => save({ businessName: businessName.value }));
  const intro = h('textarea', { class: 'input', rows: 2, maxlength: 600 }, booking.intro);
  intro.addEventListener('change', () => save({ intro: intro.value }));
  const confirmation = h('textarea', { class: 'input', rows: 2, maxlength: 600 }, booking.confirmation);
  confirmation.addEventListener('change', () => save({ confirmation: confirmation.value }));

  const typeChecks = SERVICE_TYPES.map((t) => {
    const cb = h('input', { type: 'checkbox', checked: booking.serviceTypes.includes(t.id) });
    cb.addEventListener('change', () => {
      const set = new Set(booking.serviceTypes);
      if (cb.checked) set.add(t.id); else set.delete(t.id);
      save({ serviceTypes: SERVICE_TYPES.map((x) => x.id).filter((id) => set.has(id)) });
    });
    return h('label', { class: 'row' }, cb, h('span', null, t.label));
  });

  const fieldChecks = OPTIONAL_FIELDS.map((f) => {
    const cb = h('input', { type: 'checkbox', checked: booking.fields[f.id] !== false });
    cb.addEventListener('change', () => save({ fields: { ...booking.fields, [f.id]: cb.checked } }));
    return h('label', { class: 'row' }, cb, h('span', null, f.label));
  });

  const contactPhone = h('input', { class: 'input', type: 'tel', value: booking.contactPhone, placeholder: s.company?.phone || '', maxlength: 40 });
  contactPhone.addEventListener('change', () => save({ contactPhone: contactPhone.value }));
  const contactEmail = h('input', { class: 'input', type: 'email', value: booking.contactEmail, placeholder: s.company?.email || '', maxlength: 254 });
  contactEmail.addEventListener('change', () => save({ contactEmail: contactEmail.value }));

  formCard.append(
    h('h3', null, 'Your booking form'),
    fieldRow(ui, 'Business name on the form', businessName),
    fieldRow(ui, 'Intro (optional)', intro),
    fieldRow(ui, 'Service types you offer', h('div', { class: 'stack' }, typeChecks)),
    fieldRow(ui, 'Intake fields to ask for', h('div', { class: 'stack' }, fieldChecks)),
    fieldRow(ui, 'Confirmation message', confirmation),
    fieldRow(ui, 'Contact phone (optional)', contactPhone),
    fieldRow(ui, 'Contact email (optional)', contactEmail));

  body.append(h('div', { class: 'stack' }, claimCard, linkCard, formCard));
  renderClaim();
  renderLink();

  // Load the server-held slug state (owner/admin only).
  if (!session.isDemo() && session.online) {
    api.get('/api/v1/booking').then((out) => {
      state.slug = out.page?.slug || ''; state.enabled = Boolean(out.page?.enabled); state.loaded = true;
      renderClaim(); renderLink();
    }).catch(() => { state.loaded = true; renderLink(); });
  } else {
    state.loaded = true; renderLink();
  }
}

export default {
  id: 'servicerequests',
  title: 'Service requests',
  icon: 'mail',
  group: 'sales',
  perm: 'leads',
  render(root, ctx) {
    const { ui } = ctx;
    const { h } = ui;
    let view = ctx.query.view === 'setup' ? 'setup' : 'inbox';
    const tabsHolder = h('div');
    const body = h('div');

    const draw = () => {
      ui.clear(tabsHolder).append(ui.tabs(
        [{ id: 'inbox', label: 'Inbox' }, { id: 'setup', label: 'Booking setup' }], view,
        (v) => { view = v; draw(); }));
      if (view === 'setup') setupView(ctx, body);
      else inboxView(ctx, body);
    };

    root.append(ui.page({
      title: 'Service requests',
      subtitle: 'Bookings from your public booking page, triaged into jobs',
    }, h('div', { class: 'stack' }, tabsHolder, body)));
    draw();

    // Keep the inbox live; leave the setup form alone while it is being edited.
    return ctx.store.on('*', (e) => { if (view === 'inbox' && ['leads', 'settings'].includes(e.coll)) inboxView(ctx, body); });
  },
};

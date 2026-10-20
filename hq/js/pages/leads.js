// Sales pipeline: leads from the pricing page's "Let's talk" form, the services page and the
// contact form, by stage.
// #/leads/<id> opens one lead.
import { get, patch } from '../api.js';
import { ago } from '../fmt.js';

const STAGE_LABEL = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost' };
// Where a lead came from (hq_leads.source): the pricing page, a services-page card (svc-<id>) or the contact form.
const SERVICE_LABEL = {
  'setup-integrations': 'Setup and integrations', 'data-import': 'Data import', 'price-book': 'Price book', 'crew-training': 'Crew training',
  'plan-templates': 'Plan templates', enterprise: 'Enterprise',
};
export function sourceLabel(source) {
  if (!source || source === 'pricing') return 'Pricing page';
  if (source === 'svc-contact') return 'Contact form';
  if (source.startsWith('svc-')) return `Services: ${SERVICE_LABEL[source.slice(4)] || source.slice(4)}`;
  return source;
}

export default {
  render(root, { ui, params, nav }) {
    const { h } = ui;
    let data = null;
    const board = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    root.append(ui.page({ title: 'Leads', subtitle: 'Enquiries from the pricing page, the services page and the contact form' }, board));

    async function load() {
      try { data = await get('/api/hq/leads'); } catch (e) { ui.clear(board); board.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); return; }
      draw();
      if (params[0]) open(params[0]);
    }

    function draw() {
      ui.clear(board);
      if (!data.data.length) {
        board.append(ui.empty({ icon: 'funnel', title: 'No leads yet', text: 'The "Let\'s talk" form on the pricing page creates them here and emails HQ_NOTIFY_EMAIL.' }));
        return;
      }
      board.append(h('div', { class: 'kanban' }, data.stages.map((stage) => {
        const items = data.data.filter((l) => l.stage === stage);
        return h('section', { class: 'kanban-col', 'aria-label': STAGE_LABEL[stage] },
          h('header', null, STAGE_LABEL[stage], ui.badge(String(items.length))),
          items.map((l) => h('div', { class: 'kanban-card hq-lead-card', tabindex: 0, onClick: () => nav(`leads/${l.id}`), onKeydown: (e) => { if (e.key === 'Enter') nav(`leads/${l.id}`); } },
            h('div', { class: 'title' }, l.company),
            h('div', { class: 'meta' }, [l.teamSize ? `${l.teamSize} people` : null, l.province, ago(l.createdAt)].filter(Boolean).join(' · ')),
            h('div', { class: 'meta' }, sourceLabel(l.source)),
            l.nextStepAt ? h('div', { class: 'meta' }, `Next: ${ui.fmtDate(l.nextStepAt)}`) : null,
            l.valueCents ? h('div', { class: 'meta' }, ui.fmtMoney(l.valueCents, { whole: true })) : null)));
      })));
    }

    function open(id) {
      const l = data.data.find((x) => x.id === id);
      if (!l) { ui.toast('No such lead', 'error'); nav('leads'); return; }
      const contact = h('dl', { class: 'hq-kv' },
        h('dt', null, 'Name'), h('dd', null, l.name),
        h('dt', null, 'Email'), h('dd', null, h('a', { href: `mailto:${l.email}` }, l.email)),
        h('dt', null, 'Phone'), h('dd', null, l.phone ? h('a', { href: `tel:${l.phone}` }, l.phone) : '—'),
        h('dt', null, 'Company'), h('dd', null, l.company),
        h('dt', null, 'Team size'), h('dd', null, l.teamSize || '—'),
        h('dt', null, 'Province'), h('dd', null, l.province || '—'),
        h('dt', null, 'Source'), h('dd', null, sourceLabel(l.source)),
        h('dt', null, 'Received'), h('dd', null, ui.fmtDateTime(l.createdAt)),
        h('dt', null, 'Owner'), h('dd', null, l.ownerName || 'Unassigned'));
      ui.formSheet({
        title: l.company,
        extra: h('div', { class: 'stack' }, contact, l.message ? h('div', { class: 'card flat', style: { whiteSpace: 'pre-wrap' } }, l.message) : null),
        fields: [
          { label: 'Stage', name: 'stage', type: 'select', value: l.stage, options: data.stages.map((s) => ({ value: s, label: STAGE_LABEL[s] })) },
          { label: 'Next step', name: 'nextStepAt', type: 'date', value: l.nextStepAt || '' },
          { label: 'Deal value (CAD / year)', name: 'valueCents', type: 'money', value: l.valueCents },
          { label: 'Assign to me', name: 'assignToMe', type: 'checkbox', value: false },
          { label: 'Notes', name: 'notes', type: 'textarea', value: l.notes, span: true },
        ],
        submitLabel: 'Save',
        onSubmit: (v) => {
          const body = { stage: v.stage, nextStepAt: v.nextStepAt || null, valueCents: v.valueCents || null, notes: v.notes };
          if (v.assignToMe) body.assignToMe = true;
          patch(`/api/hq/leads/${l.id}`, body).then(() => { ui.toast('Lead saved', 'success'); nav('leads'); }).catch((e) => ui.toast(e.message, 'error'));
        },
      });
    }

    load();
    return () => {};
  },
};

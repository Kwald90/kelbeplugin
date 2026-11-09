// Get paid — the close-the-sale flow (docs/releases/r1-get-paid.md): one guided sequence per job,
// quote -> customer approval -> invoice -> payment, so a field tech closes and collects at the house
// without hopping between five screens. It owns NONE of the estimate, invoice or Stripe logic: it
// reuses the real functions — the estimate sign + accept (acceptSideEffects + esign), the existing
// invoice-from-estimate builder (#/invoices/new?estimateId=), and the Stripe pay-link tools — and
// only adds the connective tissue and the "what's next" checklist on top.
import { docTotals, moneyFormatter } from '../lib/money.js';
import { buildSignature, signatureSheet, queueSignatureFirst } from '../lib/esign.js';
import { moduleOn } from '../lib/modules.js';
import { invoiceOnlineTools } from './integrations.js';
import { acceptSideEffects } from './estimates.js';
import {
  pickEstimate, invoiceForEstimate, owing, steps, flowComplete, currentStep, progress,
} from '../lib/getpaid.js';

const jobLabel = (j) => (j ? `${j.number ? `${j.number} · ` : ''}${j.title || 'Job'}` : 'Job');

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/getpaid.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/getpaid.css';
  document.head.append(link);
}

export default {
  id: 'getpaid',
  title: 'Get paid',
  icon: 'dollar-sign',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    loadCss();
    const [jobId] = ctx.params;
    if (jobId) return renderFlow(root, ctx, jobId);
    return renderList(root, ctx);
  },
};

// ---------- the chooser: jobs with a quote, closest-to-paid last ----------
function renderList(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const host = h('div');

  function draw() {
    ui.clear(host);
    const ests = store.list('estimates');
    const invoices = store.list('invoices');
    const payments = store.list('payments');
    const rows = store.list('jobs')
      .map((job) => {
        const estimate = pickEstimate(ests, job.id);
        if (!estimate) return null; // the flow starts from a quote
        const invoice = invoiceForEstimate(invoices, estimate.id);
        const bal = owing(invoice, payments);
        const st = steps({ estimate, invoice, bal });
        return { job, estimate, invoice, prog: progress(st), done: flowComplete(st), next: currentStep(st) };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.done) - Number(b.done) || b.prog.done - a.prog.done
        || String(b.job.number || '').localeCompare(String(a.job.number || '')));

    host.append(ui.table({
      columns: [
        { key: 'job', label: 'Job', render: (r) => jobLabel(r.job), sort: (r) => r.job.number || '' },
        { key: 'step', label: 'Next step', render: (r) => (r.done ? ui.badge('Paid', 'success') : ui.badge(r.next ? r.next.label : '—', 'warning')) },
        { key: 'prog', label: 'Progress', align: 'right', render: (r) => `${r.prog.done}/${r.prog.total}`, sort: (r) => r.prog.done },
      ],
      rows,
      onRowClick: (r) => nav(`#/getpaid/${r.job.id}`),
      empty: ui.empty({
        icon: 'dollar-sign',
        title: 'Nothing to close yet',
        text: 'Get paid walks a job from quote to signature to invoice to payment in one place. Start by creating an estimate on a job; it will show up here, ready to close.',
        action: ui.button('All estimates', { href: '#/estimates' }),
      }),
    }));
  }

  root.append(ui.page({
    title: 'Get paid',
    subtitle: 'Close the sale in one flow: quote → customer approval → invoice → payment.',
  }, host));
  draw();
  const off = ['estimates', 'invoices', 'payments', 'jobs'].map((c) => store.on(c, () => { if (!document.querySelector('.sheet, .dialog')) draw(); }));
  return () => off.forEach((fn) => fn && fn());
}

// ---------- the flow for one job ----------
function renderFlow(root, ctx, jobId) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const job = store.get('jobs', jobId);
  if (!job) { ui.toast('That job is gone.', 'error'); nav('#/getpaid'); return; }
  const host = h('div', { class: 'gp-flow' });

  function model() {
    const estimate = pickEstimate(store.list('estimates'), jobId);
    const invoice = invoiceForEstimate(store.list('invoices'), estimate?.id);
    const bal = owing(invoice, store.list('payments'));
    return { estimate, invoice, bal, st: steps({ estimate, invoice, bal }) };
  }

  function draw() {
    ui.clear(host);
    const money = moneyFormatter(store.settings());
    const { estimate, invoice, bal, st } = model();
    const byKey = Object.fromEntries(st.map((s) => [s.key, s]));

    const progHost = h('div', { class: 'gp-progress' },
      st.map((s) => h('span', { class: `gp-dot gp-${s.state}`, title: s.label }, s.done ? '✓' : '')));

    if (flowComplete(st)) {
      host.append(h('div', { class: 'gp-paid' },
        h('div', { class: 'gp-paid-icon' }, '✓'),
        h('h3', null, 'Paid in full'),
        h('p', { class: 'muted' }, `${invoice.number || 'The invoice'} is settled. Nice work.`),
        h('div', { class: 'row' },
          ui.button('Open the invoice', { icon: 'receipt', href: `#/invoices/${invoice.id}` }),
          ui.button('Open the job', { variant: 'ghost', icon: 'briefcase', href: `#/jobs/${job.id}` }))));
    }

    // Step 1 — Quote
    host.append(stepCard(ctx, byKey.quote, 'Quote', {
      done: estimate ? h('div', null, h('strong', null, estimate.number || 'Estimate'), ' · ',
        money(docTotals(estimate).totalCents), ' ', ui.button('View', { size: 'sm', variant: 'ghost', href: `#/estimates/${estimate.id}` })) : null,
      action: byKey.quote.state === 'now'
        ? ui.button('Start a quote', { variant: 'primary', icon: 'file-text', onClick: () => nav(`#/estimates/new?jobId=${job.id}`) })
        : null,
    }));

    // Step 2 — Customer approval (signature)
    host.append(stepCard(ctx, byKey.sign, 'Customer approval', {
      done: estimate && estimate.status === 'accepted'
        ? h('div', { class: 'muted' }, `Accepted${estimate.signedName ? ` by ${estimate.signedName}` : ''}${estimate.signedAt ? ` · ${ui.fmtDate(estimate.signedAt)}` : ''}${estimate.acceptedVia === 'manual' ? ' (recorded)' : ''}`) : null,
      action: byKey.sign.state === 'now' && estimate
        ? h('div', { class: 'row' },
          ui.button('Get signature', { variant: 'primary', icon: 'pen', onClick: () => getSignature(ctx, estimate, draw) }),
          ui.button('Approved in person / by phone', { size: 'sm', variant: 'ghost', onClick: () => manualAccept(ctx, estimate, draw) }))
        : null,
    }));

    // Step 3 — Invoice
    host.append(stepCard(ctx, byKey.invoice, 'Invoice', {
      done: invoice ? h('div', null, h('strong', null, invoice.number || 'Invoice'), ' · ', money(docTotals(invoice).totalCents),
        typeof bal === 'number' && bal > 0 ? h('span', { class: 'muted' }, ` · ${money(bal)} owing`) : null, ' ',
        ui.button('View', { size: 'sm', variant: 'ghost', href: `#/invoices/${invoice.id}` })) : null,
      action: byKey.invoice.state === 'now' && estimate
        ? ui.button('Create the invoice', { variant: 'primary', icon: 'receipt', onClick: () => nav(`#/invoices/new?estimateId=${estimate.id}`) })
        : null,
    }));

    // Step 4 — Get paid
    const payActive = byKey.pay.state === 'now' && invoice;
    const payCard = stepCard(ctx, byKey.pay, 'Get paid', {
      done: invoice && typeof bal === 'number' && bal <= 0 ? h('div', { class: 'muted' }, 'Paid in full.') : null,
      action: payActive
        ? h('div', { class: 'stack' },
          h('div', { class: 'gp-owing' }, `${money(bal)} owing`),
          invoiceOnlineTools(ctx, invoice, bal),
          h('div', { class: 'row' },
            ui.button('Record cash / cheque', { size: 'sm', icon: 'dollar-sign', onClick: () => nav(`#/invoices/${invoice.id}`) }),
            ui.button('Refresh', { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: draw })),
          moduleOn(store.settings(), 'integrations') ? null : h('p', { class: 'muted gp-hint' }, 'Turn on Payments in Settings → Integrations to take a card on the spot; otherwise record the payment by hand.'))
        : null,
    });
    host.append(payCard);

    host.prepend(progHost);
  }

  root.append(ui.page({
    title: `Get paid — ${jobLabel(job)}`,
    subtitle: 'Walk this job from quote to payment.',
    actions: [ui.button('All jobs to close', { variant: 'ghost', icon: 'list', href: '#/getpaid' })],
  }, host));
  draw();
  const off = ['estimates', 'invoices', 'payments', 'signatures'].map((c) => store.on(c, () => { if (!document.querySelector('.sheet, .dialog')) draw(); }));
  return () => off.forEach((fn) => fn && fn());
}

// A step row: the state marker, the title, a done summary or the active action.
function stepCard(ctx, step, title, { done, action }) {
  const { ui } = ctx;
  const { h } = ui;
  const mark = step.done ? '✓' : (step.state === 'now' ? '●' : '○');
  return h('div', { class: `gp-step gp-${step.state}` },
    h('div', { class: 'gp-mark', 'aria-hidden': 'true' }, mark),
    h('div', { class: 'gp-body' },
      h('div', { class: 'gp-step-title' }, title,
        step.state === 'now' ? ui.badge('Now', 'warning') : (step.done ? ui.badge('Done', 'success') : null)),
      done || null,
      action || (step.state === 'blocked' ? h('p', { class: 'muted gp-hint' }, 'Finish the step above first.') : null)));
}

// Capture a signature on this estimate and accept it — the same path as the Estimates screen's
// "Sign on this device", so the signature-first sync, budget side-effects and status all match.
function getSignature(ctx, est, redraw) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const t = docTotals(est);
  const job = est.jobId ? store.get('jobs', est.jobId) : null;
  signatureSheet(ui, {
    title: `Sign ${est.number || 'estimate'}`, job, captureLocation: store.settings().tickets?.captureLocation !== false, askEmail: true,
    summary: h('div', { class: 'stack' },
      h('div', { class: 'title' }, `${est.number || ''} · ${est.title || ''}`.trim()),
      h('ul', { class: 'gp-lines' }, (est.lines || []).map((l) => h('li', null, `${l.qty ?? ''} ${l.description || ''}`.trim()))),
      h('div', { class: 'gp-total' }, `Total with tax: ${money(t.totalCents)}`),
      est.validUntil ? h('div', { class: 'muted' }, `Valid until ${ui.fmtDate(est.validUntil)}`) : null),
    agreementText: 'I accept this estimate and the work it describes at the total shown.',
    onSigned: async (s) => {
      const sig = await buildSignature({
        docType: 'estimate', doc: est, jobId: est.jobId || null, clientId: est.clientId || null, ...s,
        capturedBy: { employeeId: auth.current().id || null, name: auth.who().name }, device: navigator.userAgent.slice(0, 120),
      });
      store.add('signatures', sig);
      store.update('estimates', est.id, { status: 'accepted', signatureId: sig.id, signedAt: sig.signedAt, signedName: sig.signerName, acceptedVia: 'signature' }, { summary: `${est.number || 'Estimate'} signed` });
      queueSignatureFirst(store, sig.id, [{ coll: 'estimates', id: est.id }]);
      acceptSideEffects(store, store.get('estimates', est.id), ui);
      ui.toast(`${est.number || 'Estimate'} signed by ${sig.signerName}`, 'success');
      redraw();
    },
  });
}

// Record approval given in person or by phone (no on-device signature) — mirrors Estimates' accept.
function manualAccept(ctx, est, redraw) {
  const { store, ui } = ctx;
  const { h } = ui;
  const s = ui.openSheet({
    title: 'Record customer approval', dialog: true,
    body: h('p', null, `Record approval for ${est.number || 'this estimate'} only after you have it from the customer in person or by phone. This updates the estimate; it does not capture a signature.`),
    actions: [
      ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
      ui.button('Record approval', {
        variant: 'primary', icon: 'check', onClick: () => {
          store.update('estimates', est.id, { status: 'accepted', acceptedVia: 'manual' }, { summary: `${est.number || 'Estimate'} approved` });
          acceptSideEffects(store, store.get('estimates', est.id), ui);
          if (est.leadId && moduleOn(store.settings(), 'leads')) {
            const l = store.get('leads', est.leadId);
            if (l && l.stage !== 'won') store.update('leads', l.id, { stage: 'won' });
          }
          ui.toast(`${est.number || 'Estimate'} approved`, 'success');
          s.close();
          redraw();
        },
      }),
    ],
  });
}

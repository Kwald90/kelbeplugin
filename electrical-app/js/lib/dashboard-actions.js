// Read-only next actions derived from existing records. No inferred approvals or mutations.
import { moduleOn, hrefModule } from './modules.js';
import { jobBillingMode, unbilledTm } from './tm.js';

/** Route permissions occasionally differ from the module id. */
export function dashboardRouteAllowed(settings, can, href) {
  const module = hrefModule(href);
  const permission = { materials: 'jobs' }[module] || module;
  return Boolean(module && moduleOn(settings, module) && can(permission));
}

/** Ranked office actions. Dates are local YYYY-MM-DD; totals reuse the invoice builder. */
export function dashboardActions({ settings, can, seesMoney, day, jobs = [], estimates = [],
  schedule = [], tasks = [], overdue = [], tmSources = {}, money = String }) {
  const rows = [];
  const allowed = (href) => dashboardRouteAllowed(settings, can, href);
  const add = (row) => { if (allowed(row.href)) rows.push(row); };
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  if (allowed('#/workplan')) for (const task of tasks.filter((t) => t.status === 'blocked')) {
    const block = (task.blocks || []).filter((b) => !b.resolvedAt).at(-1);
    add({ kind: 'blocked', tone: 'danger', iconName: 'alert', title: task.title || 'Blocked task',
      detail: block?.reason || 'The crew reported a blocker.', action: 'Review blocker',
      href: task.planId ? `#/workplan/${task.planId}` : '#/today?view=crew' });
  }

  if (seesMoney && allowed('#/invoices')) for (const invoice of overdue) {
    if (!(invoice.balanceCents > 0)) continue;
    add({ kind: 'overdue', tone: 'danger', iconName: 'receipt', title: `${invoice.number || 'Invoice'} is overdue`,
      detail: `${money(invoice.balanceCents)} outstanding`, action: 'Review invoice', href: `#/invoices/${invoice.id}` });
  }

  const promptedJobs = new Set();
  if (allowed('#/estimates') && allowed('#/jobs')) for (const estimate of estimates.filter((e) => e.status === 'accepted')) {
    const job = jobById.get(estimate.jobId) || jobs.find((j) => j.estimateId === estimate.id);
    if (!job) {
      add({ kind: 'accepted', tone: 'accent', iconName: 'file-text', title: estimate.title || estimate.number || 'Accepted quote',
        detail: 'Accepted quote has no linked job.', action: 'Create job', href: `#/estimates/${estimate.id}` });
    } else if (!promptedJobs.has(job.id) && allowed('#/schedule') && ['lead', 'scheduled'].includes(job.status)
      && !job.startDate && !schedule.some((s) => s.jobId === job.id && s.date >= day)) {
      promptedJobs.add(job.id);
      add({ kind: 'schedule', tone: 'accent', iconName: 'calendar', title: job.title || job.number || 'Accepted work',
        detail: 'Accepted work has no start date or upcoming crew visit.', action: 'Plan visit', href: `#/jobs/${job.id}?tab=schedule` });
    }
  }

  if (seesMoney && allowed('#/invoices') && allowed('#/jobs')) for (const job of jobs) {
    if (jobBillingMode(job) !== 'tm' || ['lead', 'invoiced'].includes(job.status)) continue;
    const unbilled = unbilledTm({ ...tmSources, job, settings });
    if (unbilled.empty) continue;
    add({ kind: 'unbilled', tone: 'info', iconName: 'receipt', title: job.title || job.number || 'Time & material job',
      detail: unbilled.missingCost ? 'Time or material ready to bill; some material needs a price.' : `${money(unbilled.totalCents)} ready to bill before tax`,
      action: 'Review billing', href: `#/jobs/${job.id}?tab=money` });
  }
  return rows;
}

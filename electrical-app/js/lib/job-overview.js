// Read-only job overview. Project only operational fields; billing stays in existing money views.
export function jobOverview({ job, day, employeeId, manager = false, readOnly = false,
  can = () => false, on = () => false, seesMoney = false, schedule = [], tasks = [], materials = [], hold = false }) {
  const allowed = (module) => on(module) && can(({ materials: 'jobs', tickets: 'jobs' })[module] || module);
  const jobHref = `#/jobs/${job.id}`;
  const visits = allowed('schedule') ? schedule.filter((s) => s.jobId === job.id && s.date >= day).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const visitDate = visits[0]?.date || null;
  const nextVisit = visitDate ? { date: visitDate, crewIds: [...new Set(visits.filter((s) => s.date === visitDate).map((s) => s.employeeId).filter(Boolean))],
    notes: [...new Set(visits.filter((s) => s.date === visitDate).map((s) => s.note).filter(Boolean))] } : null;
  const visibleTasks = (allowed('workplan') || allowed('today')) ? tasks.filter((t) => t.jobId === job.id
    && t.status && t.status !== 'draft' && (manager || (employeeId && t.employeeId === employeeId))) : [];
  const taskHref = (task) => allowed('workplan') && task.planId ? `#/workplan/${task.planId}` : allowed('today') ? `#/today${manager ? '?view=crew' : ''}` : null;
  const blockers = visibleTasks.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: t.title || 'Blocked task', employeeId: t.employeeId,
    reason: (t.blocks || []).filter((b) => !b.resolvedAt).at(-1)?.reason || 'No reason recorded', href: taskHref(t) }));
  const upcomingTasks = visibleTasks.filter((t) => ['todo', 'in-progress'].includes(t.status) && t.date >= day)
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.order || 0) - Number(b.order || 0))
    .map((t) => ({ id: t.id, title: t.title || 'Task', date: t.date, status: t.status, employeeId: t.employeeId, href: taskHref(t) }));
  const needs = allowed('materials') ? materials.filter((r) => r.jobId === job.id && !['fulfilled', 'cancelled'].includes(r.status))
    .sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)))
    .map((r) => ({ id: r.id, itemId: r.itemId, description: r.description || 'Material', qty: r.qty, unit: r.unit,
      urgent: Boolean(r.urgent), status: r.status || 'requested' })) : [];
  const pendingChanges = (job.changeOrders || []).filter((c) => c.status === 'pending').length;
  let next = null;
  if (hold || job.status === 'on-hold') next = { title: 'Confirm the job can proceed', detail: 'Work is on hold. Check with the office before the next visit.',
    label: 'Review customer', href: manager && allowed('clients') && job.clientId ? `#/clients/${job.clientId}` : null, tone: 'warning' };
  else if (blockers.length) next = { title: 'Clear the blocker', detail: blockers[0].title, label: 'Review task', href: blockers[0].href, tone: 'danger' };
  else if (needs.some((r) => r.urgent)) next = { title: 'Check the urgent material request', detail: 'Confirm what the crew needs before work continues.', label: 'Review material', href: `${jobHref}?tab=materials`, tone: 'warning' };
  else if (pendingChanges) next = { title: 'Review the scope change', detail: `${pendingChanges} change order${pendingChanges === 1 ? ' is' : 's are'} pending.`, label: 'Review changes', href: `${jobHref}?tab=changes` };
  else if (job.status === 'complete' && seesMoney && allowed('invoices')) next = { title: 'Review final billing', detail: 'Check invoices and remaining work before marking the job invoiced.', label: 'Review billing', href: `${jobHref}?tab=money` };
  else if (!['complete', 'invoiced', 'cancelled'].includes(job.status)) {
    if (!manager && upcomingTasks.length) next = { title: 'Your next task', detail: upcomingTasks[0].title, label: 'Open My day', href: upcomingTasks[0].href };
    else if (!nextVisit && manager && !readOnly && allowed('schedule')) next = { title: job.kind === 'service' ? 'Book the service visit' : 'Plan the next visit',
      detail: 'No crew visit is scheduled from today onward.', label: 'Open schedule', href: '#/schedule' };
    else if (nextVisit) next = { title: 'Prepare for the next visit', detail: 'Check the scope, crew and material before heading to site.', label: 'Review schedule', href: `${jobHref}?tab=schedule` };
    else if (allowed('drawings')) next = { title: 'Review the work on site', detail: 'Open the job drawings and confirm the scope.', label: 'Open drawings', href: `${jobHref}?tab=drawings` };
  }
  return { nextVisit, blockers, upcomingTasks, needs, pendingChanges, next };
}

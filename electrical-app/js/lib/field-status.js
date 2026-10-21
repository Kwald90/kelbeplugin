// Plain-language field feedback. Queue state is not a guarantee of durable local storage.
export function fieldSyncStatus(status, { demo = false } = {}) {
  if (!status) return demo
    ? { tone: 'neutral', title: 'Demo on this device', detail: 'Demo changes are not sent to a company.' }
    : { tone: 'neutral', title: 'Sync status unavailable', detail: 'Open sync details to check this connection.' };
  const waiting = Math.max(0, Number(status.waiting) || 0);
  const rejected = Math.max(0, Number(status.rejected) || 0);
  const count = (n) => `${n} change${n === 1 ? '' : 's'}`;
  // Rejections need attention even while another change is syncing or the device is offline.
  if (rejected) return {
    tone: 'danger', title: `${count(rejected)} not accepted by the server`,
    detail: `${waiting ? `${count(waiting)} also waiting. ` : ''}${status.state === 'offline' ? 'You are offline. ' : ''}Open sync details to review and retry.`,
  };
  if (status.state === 'error') return { tone: 'danger', title: 'Sync needs attention', detail: `${waiting ? `${count(waiting)} waiting. ` : ''}The last sync failed. Open details to retry.` };
  if (status.state === 'offline') return { tone: 'warning', title: 'Offline', detail: waiting ? `${count(waiting)} waiting to reach the server. Sync resumes when connected.` : 'Showing the information available on this device. New company updates need a connection.' };
  if (status.state === 'syncing') return { tone: 'info', title: 'Syncing', detail: waiting ? `${count(waiting)} waiting for server confirmation.` : 'Checking for updates from your company.' };
  if (waiting) return { tone: 'info', title: `${count(waiting)} waiting to sync`, detail: 'These changes have not reached the server yet.' };
  if (!status.lastSyncAt) return { tone: 'neutral', title: 'Waiting for first sync', detail: 'No completed sync has been reported on this device.' };
  return { tone: 'success', title: 'Changes synced', detail: 'No changes are waiting for the server.' };
}

/** Refuse another employee's shift even if a caller supplies the wrong entry. */
export function personalShiftStatus(entry, employeeId) {
  if (!employeeId) return { title: 'Time clock needs an employee link', detail: 'Ask the office to link your account to your employee record.', tone: 'neutral' };
  if (!entry || entry.employeeId !== employeeId || !entry.clockIn || entry.clockOut) return { title: 'Not clocked in', detail: 'Starting a task does not start payroll time.', tone: 'neutral' };
  return { title: entry.breakStart ? 'On break' : entry.kind === 'travel' ? 'Clocked in: travelling' : 'Clocked in', detail: 'Task progress and payroll time are recorded separately.', tone: 'info', clockIn: entry.clockIn, since: entry.breakStart || entry.clockIn, jobId: entry.jobId || null };
}

/** Only contact fields explicitly permitted by the caller are returned. */
export function fieldSiteDetails(job, client, { canSeeJobs = false, canSeeClients = false } = {}) {
  if (!canSeeJobs || !job) return null;
  const phone = canSeeClients && client?.phone ? String(client.phone) : '';
  const dial = phone.replace(/[^\d+]/g, '');
  return {
    jobId: job.id, title: job.title || job.number || 'Job site', address: job.address || '',
    directions: job.address ? 'https://maps.apple.com/?daddr=' + encodeURIComponent(job.address) : null,
    contactName: canSeeClients ? client?.name || '' : '',
    phone, phoneHref: /\d/.test(dial) ? 'tel:' + dial : null,
  };
}

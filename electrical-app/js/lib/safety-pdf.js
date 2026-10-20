// Toolbox talk attendance record as a PDF (lib/pdf.js, no dependencies). Pure: runs in
// Node for tests. Signatures are JPEG data URLs, embedded as images.
import { createPdf, createFlow, PDF_COLORS } from './pdf.js';

/**
 * talkPdf(talk, { company, jobLabel, leaderName, nameOf(employeeId) }) -> Uint8Array
 */
export function talkPdf(talk, { company = {}, jobLabel = '', leaderName = '', nameOf = () => '' } = {}) {
  const doc = createPdf({ title: `Toolbox talk: ${talk.title || ''}`, subject: 'Toolbox talk attendance', creator: 'Fishtape' });
  const flow = createFlow(doc, { footer: (n, total) => [`${company.name || ''} · Toolbox talk record`, `Page ${n} of ${total}`] });
  flow.heading(company.name || 'Toolbox talk', { size: 11, rule: false });
  flow.heading(`Toolbox talk: ${talk.title || 'Untitled'}`, { size: 16 });
  flow.fields([
    ['Date', [talk.date, talk.time].filter(Boolean).join(' ')], ['Job', jobLabel || '—'],
    ['Leader', leaderName || '—'], ['Location', talk.location || ''],
    ['Status', talk.status || 'scheduled'], ['Attendees', String((talk.attendees || []).length)],
  ]);
  if ((talk.points || []).length) {
    flow.heading('Key points', { size: 12 });
    talk.points.forEach((p, i) => flow.paragraph(`${i + 1}. ${p}`, { size: 10 }));
  }
  if ((talk.questions || []).length) {
    flow.heading('Questions for the crew', { size: 12 });
    talk.questions.forEach((q) => flow.paragraph(`• ${q}`, { size: 10 }));
  }
  if (talk.notes) { flow.heading('Notes and crew concerns', { size: 12 }); flow.paragraph(talk.notes); }

  flow.heading('Attendance', { size: 12 });
  const list = talk.attendees || [];
  if (!list.length) flow.paragraph('Nobody has signed yet.', { color: PDF_COLORS.MUTED });
  const rowH = 46;
  for (const a of list) {
    flow.ensure(rowH);
    const y = flow.y;
    const name = a.name || nameOf(a.employeeId) || '—';
    doc.text(name, flow.left, y + 18, { size: 10, bold: true });
    doc.text([a.company, a.at ? new Date(a.at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : ''].filter(Boolean).join(' · '), flow.left, y + 32, { size: 8.5, color: PDF_COLORS.MUTED });
    let ref = null;
    try { ref = a.signature?.dataUrl ? doc.addJpeg(a.signature.dataUrl) : null; } catch { ref = null; }
    const sx = flow.left + flow.width * 0.55, sw = 120, sh = 40;
    if (ref) doc.image(ref, sx, y + 2, sw, sh);
    else doc.text('(no signature)', sx, y + 24, { size: 8.5, color: PDF_COLORS.MUTED });
    doc.line(flow.left, y + rowH - 2, flow.right, y + rowH - 2, { width: 0.5, color: PDF_COLORS.RULE });
    flow.y = y + rowH;
  }
  flow.finish();
  return doc.toBytes();
}

// Equipment and site inspection templates, results and recurring due dates. Pure.
// Frequencies are defaults a manager can change per inspection; sources and VERIFY notes
// are in docs/safety/README.md. Item wording is ours.

/** [id, title, default frequency in days (0 = before each use, tracked daily), items: [text, ref?]] */
export const TEMPLATES = [
  {
    id: 'ladder', title: 'Portable ladder', frequencyDays: 1, asset: 'Ladder no.', items: [
      ['Rails and rungs straight, not cracked, bent or split', 'CSA Z11'], ['Feet and pads present and in good shape'],
      ['Spreaders lock (stepladder)'], ['Labels and duty rating legible', 'CSA Z11'],
      ['Non-conductive (fibreglass) for electrical work'], ['No paint or tape hiding defects'], ['Clean: no oil, mud or ice on rungs'],
    ],
  },
  {
    id: 'scaffold', title: 'Scaffold', frequencyDays: 1, asset: 'Scaffold location', items: [
      ['Base plates and mudsills on firm ground'], ['Frames plumb, braced and pinned'], ['Guardrails, midrails and toe boards in place'],
      ['Platform fully planked, planks secured and overlapping'], ['Safe access (ladder or stair)'], ['Tied in to the structure as required'],
      ['Clear of overhead lines (limit of approach)'], ['Inspected after high wind or weather'],
    ],
  },
  {
    id: 'scissor-lift', title: 'Scissor lift / elevating work platform', frequencyDays: 1, asset: 'Unit no.', items: [
      ['Operator trained and familiar with this model', 'CSA B354'], ['Pre-use inspection: hydraulics, no leaks', 'CSA B354'],
      ['Guardrails and gate close and latch'], ['Emergency lowering and stop work'], ['Tires, wheels and pothole guards'],
      ['Tilt alarm and descent alarm work'], ['Annual inspection sticker current', 'CSA B354'], ['Manual in the holder'],
    ],
  },
  {
    id: 'cords', title: 'Extension cords and power tools', frequencyDays: 1, asset: 'Cord / tool set', items: [
      ['Jacket not cut, crushed or taped'], ['Ground pin present on plugs'], ['Rated for the load and for outdoor use'],
      ['Protected by GFCI on site', 'CEC Section 76'], ['Strain relief intact at plug and connector'], ['Tool guards and switches work'],
    ],
  },
  {
    id: 'temp-power', title: 'Temporary power panel', frequencyDays: 7, asset: 'Panel', items: [
      ['Enclosure closed, covers and blanks in place', 'CEC Section 76'], ['GFCI receptacles test and trip', 'CEC Section 76'],
      ['Circuits labelled'], ['Grounding and bonding intact'], ['Protected from weather and vehicle damage'],
      ['Cords not run through doors or windows'], ['Clear working space in front of the panel'],
    ],
  },
  {
    id: 'ppe', title: 'PPE check', frequencyDays: 30, asset: 'Worker or kit', items: [
      ['Hard hat: no cracks, suspension good, within service life'], ['Safety glasses clean, not scratched'],
      ['Arc-rated clothing rating matches labels, no holes or contamination', 'CSA Z462'],
      ['Rubber insulating gloves air-tested, within retest date', 'CSA Z462'], ['Harness: webbing, stitching, D-ring, inspection tag'],
      ['Hearing and respiratory protection available and fit'],
    ],
  },
  {
    id: 'first-aid', title: 'First-aid kit', frequencyDays: 90, asset: 'Kit location', items: [
      ['Kit contents match the provincial list for the crew size'], ['Nothing expired or used up'], ['Inspection card dated and signed', 'ON Reg. 1101 s.6'],
      ['Kit location posted, with names of first aiders'], ['Eyewash available where needed'],
    ],
  },
  {
    id: 'extinguisher', title: 'Fire extinguisher', frequencyDays: 30, asset: 'Extinguisher no.', items: [
      ['In its place, visible and not blocked', 'NFPA 10'], ['Pressure gauge in the green'], ['Pin and tamper seal in place'],
      ['No damage, corrosion or leaks; hose clear'], ['Annual service tag current', 'NFPA 10'], ['Right class for the hazard (ABC / C for electrical)'],
    ],
  },
  {
    id: 'site', title: 'General site inspection', frequencyDays: 7, asset: 'Area', items: [
      ['Housekeeping: walkways clear, cords off the floor'], ['Openings covered or guarded'], ['Lockouts and tags in place and current'],
      ['Panels closed; energized parts guarded', 'CSA Z462'], ['Emergency info, muster point and first aid posted'],
      ['WHMIS labels on containers, SDS available', 'WHMIS 2015'], ['Lighting adequate'], ['Fire extinguishers in place'],
    ],
  },
];

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;

const addDays = (day, n) => {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(n || 0))).toISOString().slice(0, 10);
};

/** A new inspection from a template. */
export function newInspection(t, { jobId = null, assetTag = '', date, inspectorId = null }) {
  return {
    templateId: t.id, title: t.title, jobId, assetTag, date, inspectorId,
    items: t.items.map(([text, ref], i) => ({ id: `${t.id}-${i + 1}`, text, ref: ref || '', result: 'open', note: '', photos: [] })),
    result: 'in-progress', frequencyDays: t.frequencyDays, nextDue: null, completedAt: null, signature: null, notes: '',
  };
}

/** Overall result: 'fail' if any item failed, 'pass' when every item is pass or N/A, else 'in-progress'. */
export function inspectionResult(items) {
  const list = items || [];
  if (list.some((i) => i.result === 'fail')) return 'fail';
  if (list.length && list.every((i) => i.result === 'pass' || i.result === 'na')) return 'pass';
  return 'in-progress';
}

export const failedItems = (insp) => (insp?.items || []).filter((i) => i.result === 'fail');

/** Next due day: date + frequency (0 or empty = not recurring). */
export function nextDueDate(insp) {
  const f = Number(insp?.frequencyDays);
  if (!insp?.date || !Number.isFinite(f) || f <= 0) return null;
  return addDays(insp.date, f);
}

/** The key that makes inspections "the same thing inspected again". */
export const assetKey = (i) => [i.templateId || 'other', String(i.assetTag || '').trim().toLowerCase(), i.jobId || ''].join('|');

/**
 * Recurring inspections: the latest completed inspection of each asset and when the next
 * is due. state: 'overdue' (past due), 'due' (due today or within `soonDays`), 'ok'.
 * In-progress inspections don't count as done.
 */
export function inspectionSchedule(inspections, today, soonDays = 3) {
  const latest = new Map();
  for (const i of inspections || []) {
    if (!i || !i.date || i.result === 'in-progress' || !i.result) continue;
    const k = assetKey(i);
    const cur = latest.get(k);
    if (!cur || i.date > cur.date || (i.date === cur.date && String(i.updatedAt || '') > String(cur.updatedAt || ''))) latest.set(k, i);
  }
  const out = [];
  for (const [key, i] of latest) {
    const due = i.nextDue || nextDueDate(i);
    if (!due) continue;
    const state = due < today ? 'overdue' : due <= addDays(today, soonDays) ? 'due' : 'ok';
    out.push({ key, inspection: i, templateId: i.templateId, assetTag: i.assetTag || '', jobId: i.jobId || null, lastDate: i.date, lastResult: i.result, nextDue: due, state });
  }
  return out.sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

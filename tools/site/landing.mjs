// Landing pages: /for/<slug>. Audience pages, province pages (facts read from the app's own
// data: js/lib/cec/provinces.js, js/lib/cec/amendments.js, js/lib/tax.js and
// js/lib/safety-reporting.js) and "switching from" pages (import presets from js/lib/importers.js,
// described in docs/code/imports.md).
import { ADOPTION } from '../../electrical-app/js/lib/cec/provinces.js';
import { AMENDMENTS } from '../../electrical-app/js/lib/cec/amendments.js';
import { ratesOn, describeTaxes, treatmentsFor, TREATMENTS, treatmentHint, provinceName } from '../../electrical-app/js/lib/tax.js';
import { PROVINCES as SAFETY } from '../../electrical-app/js/lib/safety-reporting.js';

/** Today's date as YYYY-MM-DD (tax rates are dated). The build's --date option pins it in tests. */
let today = new Date().toISOString().slice(0, 10);
export const setBuildDate = (d) => { today = d; };

/** The facts a province page shows, all from the app's data. */
export function provinceFacts(code) {
  const a = ADOPTION[code];
  const taxes = ratesOn(code, today).map((p) => ({ ...p, applies: { material: true, labour: true, other: true } }));
  const treatment = treatmentsFor(code)[0];
  const s = SAFETY[code];
  return {
    code,
    name: provinceName(code),
    codeInForce: a.inForce,
    edition: a.edition,
    effective: a.effective,
    instrument: a.instrument,
    authority: a.authority,
    permitNote: a.permitNote || '',
    tax: describeTaxes(taxes),
    taxTreatment: TREATMENTS[treatment].label,
    // The "standard" hint is written for every province at once (it mentions QST); say it plainly.
    taxHint: treatment === 'standard' ? `${describeTaxes(taxes)} on materials, labour and other lines.` : treatmentHint(treatment, code),
    amendments: (AMENDMENTS[code] || []).map((x) => ({ rule: x.rule, summary: x.summary })),
    wcb: s ? { name: s.wcb.name, form: s.wcb.form, deadline: s.wcb.deadline } : null,
    regulator: s ? s.regulator.name : null,
  };
}

const AUDIENCE = [
  {
    slug: 'residential-electricians',
    name: 'Residential electricians',
    title: 'Software for residential and service electricians in Canada · Fishtape',
    description: 'Book, dispatch, quote and invoice service calls on site and get paid, then win the repeat work with maintenance agreements. Plus lay out a house to CEC 26-722 and check it before the inspector. For Canadian residential electricians.',
    eyebrow: 'For residential and service electricians',
    h1: 'The residential service shop, from the booking to the review',
    lede: 'Book the call, dispatch the tech, quote and invoice on site and get paid, then win the repeat work. Plus the CEC tools to lay out a house and catch it before the inspector does.',
    shot: ['plan-canvas', 'A house floor plan with receptacles placed in each room'],
    points: [
      ['Book, dispatch and roll', 'Schedule the job and assign the tech, with a GPS time clock and geofencing on the crew. Online booking and an on-the-way ETA for the customer are coming.', '/features/crew-time'],
      ['Quote and invoice on site', 'Price it from your price book and reusable assemblies, send the invoice from the driveway and take the card by link.', '/features/estimating-invoicing'],
      ['Win the repeat work', 'Recurring maintenance agreements and a per-site asset registry bring customers back. Review requests and membership plans are coming.', '/features/crm-leads'],
      ['Lay out a house in minutes', 'Auto-place receptacles, switches, lights and smoke alarms room by room, checked for spacing, GFCI, AFCI and tamper-resistant before the inspector sees it.', '/features/box-placement'],
      ['Leads that get followed up', 'Facebook ad leads straight into the pipeline, with a follow-up text and email on a schedule.', '/features/crm-leads'],
      ['Panel and service sizing', '8-200 service calculations, panel schedules and voltage drop with the rule numbers.', '/features/cec-calculators'],
    ],
    features: ['estimating-invoicing', 'box-placement', 'crm-leads', 'cec-calculators'],
  },
  {
    slug: 'commercial-industrial',
    name: 'Commercial and industrial contractors',
    title: 'Software for commercial and industrial electrical contractors · Fishtape',
    description: 'Multi-page plan sets, takeoff, 347/600 V panel schedules, conduit bending, work plans by phase, crew KPIs, test and commissioning reports, safety records and permits for Canadian commercial and industrial electrical contractors.',
    eyebrow: 'For commercial and industrial',
    h1: 'Plan sets, conduit and crews on commercial and industrial jobs',
    lede: 'Bring in the full drawing set, take off from every sheet, plan the job by phase and day, and keep the safety, permit and commissioning paperwork with the job. Arc-flash labels, a control-panel and I/O package, punch lists and daily logs are coming.',
    shot: ['work-plan', 'A work plan board for a commercial job, tasks by worker and day'],
    points: [
      ['Full plan sets', 'Every sheet of the PDF as its own drawing, grouped, with the sheet labels. Take off from each.', '/features/plans-takeoff'],
      ['Conduit, bent right', 'Offsets, saddles, 90s, rolling offsets and segment bends for EMT, rigid and PVC up to trade size 103.', '/features/pipe-bending'],
      ['347/600 V and three phase', 'Panel schedules with phase balance, conductor sizing, voltage drop, motors and conduit fill.', '/features/cec-calculators'],
      ['Work plans and crew KPIs', 'Tasks per worker per day, published to My day, with photos as proof, on-time against blocked hours.', '/features/work-plans'],
      ['Test and commissioning', 'Megger, bonding, GFCI-trip and torque readings with an automatic pass/fail and the instrument\'s cal date.', '/features'],
      ['Safety, permits and inspections', 'FLHAs, toolbox talks with signatures, inspections and incident reports, with the right permit authority for the province.', '/features/safety'],
    ],
    features: ['plans-takeoff', 'work-plans', 'safety', 'pipe-bending'],
  },
  {
    slug: 'solo-electricians',
    name: 'Solo electricians',
    title: 'Software for solo electricians and two-person crews · Fishtape',
    description: 'Quotes, invoices, CEC calculators, pipe bending and wire runs on your phone or iPad, offline. Starter includes two users. Built for Canadian electricians working on their own.',
    eyebrow: 'For solo electricians',
    h1: 'Your whole business on the iPad in the truck',
    lede: 'Quote at the kitchen table, bend pipe in the basement with no signal, invoice before you leave. Starter covers you and a helper.',
    shot: ['estimate', 'An estimate on the iPad with materials, labour and HST'],
    starter: true,
    points: [
      ['Quotes in minutes', 'Your price book, your labour rate, the right tax for your province. Send it from the job.', '/features/estimating-invoicing'],
      ['The code book maths', 'Conductor size, voltage drop, box fill and service calculations with the rule numbers.', '/features/cec-calculators'],
      ['Pipe bending and wire runs', 'Marks for every bend, wire totals with allowances. Offline.', '/features/pipe-bending'],
      ['Safety paperwork too', 'FLHAs and incident reports are in every plan, even when it\'s just you.', '/features/safety'],
      ['Clients and leads', 'Every client, job and quote in one place, and a pipeline for the next ones.', '/features/crm-leads'],
      ['No caps on your work', 'As many invoices, estimates, jobs, clients and drawings as you make.', '/pricing'],
    ],
    features: ['estimating-invoicing', 'cec-calculators', 'pipe-bending', 'wire-runs'],
  },
];

const PROVINCE_PAGES = [
  { slug: 'ontario', description: "Fishtape for Ontario electrical contractors: CEC calculators and drawing checks with the OESC amendments, ESA on your permits, HST on every estimate and invoice, and WSIB reporting prompts.", codes: ['ON'], titleTail: 'OESC and ESA', h1: 'Built for Ontario electrical contractors and the OESC', lede: 'The calculators and drawing checks follow the Ontario Electrical Safety Code, Ontario\'s amendments included, and every estimate and invoice charges HST at the right rate.', extra: 'ESA notifications, plan review thresholds and Ontario\'s Table 39 for service conductors are in the app.' },
  { slug: 'british-columbia', description: "Fishtape for BC electrical contractors: CEC 2024 as BC adopted it, Technical Safety BC on your permits, GST and PST handled the way BC contractors charge it, and WorkSafeBC prompts.", codes: ['BC'], titleTail: 'Technical Safety BC and PST', h1: 'Built for BC electrical contractors', lede: 'CEC 2024 as BC adopted it, Technical Safety BC on your permits, and PST handled the way BC contractors charge it: real property contracts, goods that stay goods, or supply only.', extra: 'BC has no deviations from CEC 2024 this cycle, so the national rules apply as written.' },
  { slug: 'alberta', description: "Fishtape for Alberta electrical contractors: CEC 2024 with Alberta's variance, permits through your municipality or accredited agency, GST on invoices, and WCB-Alberta prompts.", codes: ['AB'], titleTail: 'CEC 2024 and Alberta variances', h1: 'Built for Alberta electrical contractors', lede: 'CEC 2024 with Alberta\'s variances, permits through your municipality or accredited agency, and GST only on your invoices.', extra: 'Alberta permits come from the accredited municipality or agency for the site; Fishtape keeps the permit and inspection dates with the job.' },
  { slug: 'saskatchewan', description: "Fishtape for Saskatchewan electrical contractors: CEC 2024 with the Saskatchewan Interpretations, TSASK permits, PST on the whole contract, and WCB Saskatchewan prompts.", codes: ['SK'], titleTail: 'TSASK and PST', h1: 'Built for Saskatchewan electrical contractors', lede: 'CEC 2024 with the 2024 Saskatchewan Interpretations, TSASK permits, and PST on the whole contract, labour included, the way Saskatchewan charges it.', extra: 'Saskatchewan\'s interpretations on outdoor receptacles, AFCI and GFCI are on the CEC checklists for Saskatchewan companies.' },
  { slug: 'manitoba', description: "Fishtape for Manitoba electrical contractors: the Manitoba Electrical Code, Manitoba Hydro or City of Winnipeg permits, RST on the whole contract, and WCB Manitoba prompts.", codes: ['MB'], titleTail: 'Manitoba Electrical Code and RST', h1: 'Built for Manitoba electrical contractors', lede: 'The Manitoba Electrical Code (CEC 2024 with the Manitoba schedule), permits through Manitoba Hydro or the City of Winnipeg, and RST on the whole contract, labour included.', extra: 'Manitoba\'s voltage drop rule applies to branch circuits only, and the calculator says so for Manitoba companies.' },
  { slug: 'atlantic-canada', description: "Fishtape for electrical contractors in New Brunswick, Nova Scotia, PEI and Newfoundland and Labrador: CEC 2024 with NB and PEI rules, each province's inspection office, and HST at its rate.", codes: ['NB', 'NS', 'PE', 'NL'], titleTail: 'NB, NS, PEI and NL', h1: 'Built for electrical contractors in Atlantic Canada', lede: 'CEC 2024 with New Brunswick\'s and PEI\'s own rules, the right inspection office for each province, and HST at each province\'s rate, Nova Scotia\'s 14 % included.', extra: 'New Brunswick\'s own dwelling receptacle rule (26-722) and PEI\'s Schedule 1 are on the checklists for companies in those provinces.' },
];

const SWITCHING = [
  {
    slug: 'switching-from-jobber',
    from: 'Jobber',
    title: 'Switching from Jobber',
    description: 'Moving from Jobber? Export your clients from Jobber and import them into Fishtape with the Jobber preset, then add the electrical side: CEC calculators, plans, bending and wire runs.',
    h1: 'Moving from Jobber? Bring your clients with you.',
    lede: 'Export your clients from Jobber, pick the Jobber preset in Fishtape\'s Import screen, and they come across with their addresses, tags and company names. Then add the electrical side.',
    presets: ['Jobber clients: names, companies, emails, phones, addresses and tags. A client with several properties comes in once; the repeat rows are skipped.', 'Your price book and jobs from any spreadsheet, using the generic import with a template for each.'],
    exportSteps: ['In Jobber, export your client list as a CSV.', 'Export your products and services, or keep your price book in a spreadsheet.'],
  },
  {
    slug: 'switching-from-housecall-pro',
    from: 'Housecall Pro',
    title: 'Switching from Housecall Pro',
    description: 'Moving from Housecall Pro? Export your customers and import them into Fishtape with the Housecall Pro preset, then work to the CEC with calculators, plans, bending and wire runs.',
    h1: 'Moving from Housecall Pro? Your customers come too.',
    lede: 'Export your customer list from Housecall Pro and import it with the Housecall Pro preset. Fishtape matches the columns by name, finds duplicates and lets you check everything before it saves.',
    presets: ['Housecall Pro customers: names, companies, emails, phones and addresses, matched by field name whichever columns your export includes.', 'Price book items, jobs and employees from any spreadsheet with the generic import.'],
    exportSteps: ['In Housecall Pro, export your customer list.', 'Keep the columns you want in the list view before exporting; Fishtape matches them by name.'],
  },
  {
    slug: 'switching-from-quickbooks',
    from: 'QuickBooks',
    title: 'QuickBooks Online: import and export',
    description: 'Import your customers and products and services from QuickBooks Online, run the jobs in Fishtape, and export customers, invoices and payments back to QuickBooks Online for your books.',
    h1: 'Keep QuickBooks for the books. Run the jobs in Fishtape.',
    lede: 'Bring your customers and products and services in from QuickBooks Online. Run quotes, jobs and invoices in Fishtape, then export customers, invoices and payments in QuickBooks\' own import format.',
    presets: ['QuickBooks Online customers, matched loosely by column name since Intuit doesn\'t publish its export headers.', 'QuickBooks Online products and services: names, SKUs, descriptions, prices and units, as your price book.'],
    exportSteps: ['In QuickBooks Online, export your customer list and your products and services to Excel or CSV.', 'Import them into Fishtape with the QuickBooks presets.'],
    qbo: true,
  },
];

export const LANDING = [
  ...AUDIENCE.map((p) => ({ kind: 'audience', ...p })),
  ...PROVINCE_PAGES.map((p) => {
    const facts = p.codes.map(provinceFacts);
    const names = facts.map((f) => f.name);
    const name = p.codes.length > 1 ? 'Atlantic Canada' : names[0];
    const authorities = facts.map((f) => f.authority.name.replace(/ \(.*\)$/, '')).join(', ');
    return {
      kind: 'province',
      ...p,
      name,
      facts,
      title: `Electrical contractor software for ${name}${p.titleTail ? `: ${p.titleTail}` : ''} · Fishtape`,
      eyebrow: `Fishtape in ${name}`,
      shot: ['calculators', 'A CEC calculator using the province and code book set in Settings, with rule references'],
    };
  }),
  ...SWITCHING.map((p) => ({ kind: 'switching', name: p.qbo ? 'QuickBooks Online' : `Switching from ${p.from}`, eyebrow: p.qbo ? 'Fishtape and QuickBooks' : `Switching from ${p.from}`, shot: ['estimate', 'An estimate in Fishtape built from an imported price book'], ...p, title: `${p.title} · Fishtape` })),
];

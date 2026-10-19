// Code adoption and inspection authorities by province and territory, as of
// 2026-10-19. Full sources and notes: docs/code/adoption.md (S-numbers below).

export const CODE_BOOKS = [
  { id: 'CEC-2024', label: 'Canadian Electrical Code 2024 (CSA C22.1:24)', short: 'CEC 2024' },
  { id: 'NEC-2023', label: 'US National Electrical Code 2023 (NFPA 70)', short: 'NEC 2023' },
];

export const codeBookOf = (settings) => (settings?.codeBook === 'NEC-2023' ? 'NEC-2023' : 'CEC-2024');

/**
 * ADOPTION[province] = { edition, effective (YYYY-MM-DD), inForce (short text), instrument,
 *   authority: { name, url }, permitNote, verify? }
 */
export const ADOPTION = {
  ON: {
    edition: 'CEC 2024', effective: '2025-05-01', inForce: 'Ontario Electrical Safety Code 29th ed. (CEC 2024 + Ontario amendments) since 2025-05-01',
    instrument: 'O. Reg. 164/99 as amended by O. Reg. 449/24', // S1, S4
    authority: { name: 'Electrical Safety Authority (ESA)', url: 'https://esasafe.com' },
    permitNote: 'File a notification with ESA before starting (or within 48 h if not practicable); ESA gives connection authorization before the installation is used (OESC 2-004).',
  },
  BC: {
    edition: 'CEC 2024', effective: '2025-03-04', inForce: 'BC Electrical Code (CEC 2024, no BC deviations) since 2025-03-04',
    instrument: 'Electrical Safety Regulation, B.C. Reg. 100/2004 s.20, amended by B.C. Reg. 118/2024', // S5, S6
    authority: { name: 'Technical Safety BC', url: 'https://www.technicalsafetybc.ca' },
    permitNote: 'Some local governments issue their own electrical permits (for example Burnaby and Vancouver). Check which one covers the site.',
  },
  AB: {
    edition: 'CEC 2024', effective: '2025-04-01', inForce: 'CEC 2024 since 2025-04-01, with Alberta variances',
    instrument: 'Electrical Code Regulation under the Safety Codes Act', // S8, S9
    authority: { name: 'Municipality or accredited agency (Alberta Safety Codes)', url: 'https://www.alberta.ca/electrical-codes-and-standards.aspx' },
    permitNote: 'Permits come from the accredited municipality or agency for the site.',
  },
  SK: {
    edition: 'CEC 2024', effective: '2025-06-01', inForce: 'CEC 2024 with 2024 Saskatchewan Interpretations, enforced since 2025-06-01',
    instrument: 'The Electrical Inspection Act, 1993 s.5', // S11, S12
    authority: { name: 'Technical Safety Authority of Saskatchewan (TSASK)', url: 'https://www.tsask.ca/electrical' },
    permitNote: 'Electrical permits and inspections moved from SaskPower to TSASK on 2021-02-01.',
  },
  MB: {
    edition: 'CEC 2024', effective: '2026-04-01', inForce: 'Manitoba Electrical Code (CEC 2024 + Manitoba schedule) since 2026-04-01',
    instrument: 'Man. Reg. 30/2026', // S15, S16
    authority: { name: 'Manitoba Hydro (outside Winnipeg) / City of Winnipeg', url: 'https://www.hydro.mb.ca' },
    permitNote: 'Inside Winnipeg, permits and inspections are by the City of Winnipeg; elsewhere by Manitoba Hydro.',
  },
  NB: {
    edition: 'CEC 2024', effective: '2026-03-15', inForce: 'CEC 2024 with NB Rule 26-722 since 2026-03-15',
    instrument: 'N.B. Reg. 84-165 as amended by N.B. Reg. 2026-5', // S19
    authority: { name: 'Technical Inspection Services, NB Department of Public Safety', url: 'https://www.gnb.ca/en/topic/laws-safety/licensing-inspections/technical-inspections.html' },
  },
  NS: {
    edition: 'CEC 2024', effective: '2024-07-02', inForce: 'CEC 2024, no amendments, since 2024-07-02',
    instrument: 'Electrical Code Regulations, Electrical Installation and Inspection Act s.6', // S21
    authority: { name: 'Nova Scotia Power electrical inspections', url: 'https://www.nspower.ca/your-home/building-renovating/electrical-inspections' },
    permitNote: 'Permits and inspections come from the supplying utility\'s inspection department; the Provincial Chief Electrical Inspector oversees.',
  },
  PE: {
    edition: 'CEC 2024', effective: '2024-10-05', inForce: 'CEC 2024 with PEI Schedule 1 since 2024-10-05',
    instrument: 'Electrical Inspection and Code Regulations (EC757/18), amended by EC2024-874', // S23
    authority: { name: 'PEI Chief Electrical Inspector, Inspection Services', url: 'https://www.princeedwardisland.ca/en/information/housing-land-and-communities/electrical-work-in-pei' },
  },
  NL: {
    edition: 'CEC 2024', effective: '2024-07-01', inForce: 'CEC 2024 for permits issued since 2024-07-01',
    instrument: 'Public Safety Act, Electrical Regulations', // S25
    authority: { name: 'Electrical Safety Services, NL Department of Government Services', url: 'https://www.gov.nl.ca/gs/' },
  },
  YT: {
    edition: 'CEC 2024', effective: '2025-04-01', inForce: 'CEC 2024 since 2025-04-01',
    instrument: 'Electrical Protection Act (Bulletin 25-01)', // S27
    authority: { name: 'Building Safety and Standards, Government of Yukon', url: 'https://yukon.ca' },
  },
  NT: {
    edition: 'CEC 2024', effective: '2024-10-01', inForce: 'CEC 2024, enforced since 2024-10-01',
    instrument: 'Electrical Protection Act and Regulations', // S28
    authority: { name: 'GNWT Department of Infrastructure, Electrical/Mechanical Safety', url: 'https://www.inf.gov.nt.ca' },
  },
  NU: {
    edition: 'CEC 2015', effective: '2015-10-01', inForce: 'Last adoption found: CEC 2015 (2015-10-01). Check the edition in force',
    instrument: 'Electrical Protection Regulations s.4', // S29
    authority: { name: 'Office of the Chief Electrical Inspector, Service Nunavut', url: 'https://www.gov.nu.ca' },
    verify: true,
  },
  QC: {
    edition: 'CEC 2021', effective: '2026-03-26', inForce: 'Code de construction, Chapitre V – Électricité (based on CEC 2021) since 2026-03-26. Fishtape does not cover Quebec yet',
    instrument: 'Construction Code regulation (Gazette 2026-03-11)', // S31, S32
    authority: { name: 'Régie du bâtiment du Québec (RBQ)', url: 'https://www.rbq.gouv.qc.ca' },
  },
};

/** Adoption facts for a province, or null. */
export function adoptionFor(province) {
  return ADOPTION[province] || null;
}

/** Default permit authority name for a province (used on new permits). */
export function permitAuthority(province) {
  return ADOPTION[province]?.authority?.name || '';
}

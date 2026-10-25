// Breaker part-number generator: build the catalogue (SKU) number for a circuit from its family,
// poles, amps and type. Pure, no DOM, offline, CSP-safe. Canada-grounded (canadabreakers.ca and the
// makers' CA catalogues). Never crosses families — the family comes from the panel line.
//
// What is confident vs not:
//  - Core single/double/triple-pole, tandem (AABB) and the defined quad forms are deterministic and
//    returned confident:true — these follow a fixed prefix+pole+amp rule.
//  - GFCI / AFCI / dual-function and plug-on-neutral vs pigtail variants are returned as the best
//    Canadian-correct string with confident:false and a note to verify/edit: those suffixes vary by
//    revision and by the panel's neutral style, so the field tech confirms the stamped number.
//
// Canadian specifics vs US: Square D dual-function suffix is 'DF' (CA), not 'DFC' (US); Siemens
// protected types append 'CSA'; GE poles are a two-digit code (11/21/31) on THQL.

/** The breaker types this generator understands (aligns with panel-templates BREAKER_TYPES). */
export const TYPES = ['standard', 'tandem', 'quad', 'gfci', 'afci', 'dual'];

// GE/ABB THQL encodes the pole count as a two-digit code; THQP uses a plain pole digit.
const THQL_POLE = { 1: '11', 2: '21', 3: '31' };

// Per-family builders. Each family is self-contained; nothing here mixes prefixes across families.
const FAMILIES = {
  // Square D in Canada carries the CSA "C" prefix: Homeline is CHOM(T), QO is CQO
  // (Schneider CA catalogue, e.g. CHOM115GFI). US HOM/QO numbers are not CSA-certified here.
  QO: {
    label: 'Square D QO', poleRepr: (p) => String(p), tandemPrefix: 'CQO',
    protected: { gfci: (s) => `CQO${s}GFI`, afci: (s, pon) => `CQO${s}${pon ? 'PCAFI' : 'CAFI'}`, dual: (s) => `CQO${s}DF` },
  },
  HOM: {
    label: 'Square D Homeline', poleRepr: (p) => String(p), tandemPrefix: 'CHOMT',
    protected: { gfci: (s) => `CHOM${s}GFI`, afci: (s, pon) => `CHOM${s}${pon ? 'PCAFI' : 'CAFI'}`, dual: (s, pon) => `CHOM${s}${pon ? 'PDF' : 'DFC'}` },
  },
  BR: {
    label: 'Eaton BR', poleRepr: (p) => String(p), tandemPrefix: 'BD',
    protected: { gfci: (s) => `GFTCB${s}`, afci: (s) => `BRCAF${s}`, dual: (s) => `BRAFGF${s}` },
  },
  CH: {
    label: 'Eaton CH', poleRepr: (p) => String(p), tandemPrefix: 'CHT',
    protected: { gfci: (s, pon) => `CHF${pon ? 'GFT' : 'GF'}${s}`, afci: (s) => `CHFCAF${s}`, dual: (s) => `CHFAFGF${s}` },
  },
  Q: {
    label: 'Siemens type QP', poleRepr: (p) => String(p), tandemPrefix: 'Q', csa: true,
    protected: { gfci: (s) => `QF${s}ACSA`, afci: (s) => `QA${s}AFCCSA`, dual: (s) => `Q${s}DFCSA` },
  },
  THQL: {
    label: 'GE/ABB Q-Line THQL', poleRepr: (p) => THQL_POLE[p] || String(p), tandemPrefix: 'THQLT',
    protected: { gfci: (s) => `THQL${s}GFT`, afci: (s) => `THQL${s}AF2`, dual: (s) => `THQL${s}DF` },
  },
  THQP: {
    label: 'GE/ABB Q-Line THQP (1/2")', poleRepr: (p) => String(p), tandemPrefix: null,
    protected: { gfci: (s) => `THQP${s}GF`, afci: (s) => `THQP${s}AF`, dual: (s) => `THQP${s}DF` },
  },
};

const isInt = (v) => Number.isInteger(v) && v > 0;
const amp = (v) => String(v);

/**
 * Build the catalogue number for a breaker. Pure.
 * @param {object} spec
 * @param {string} spec.family       generator key: QO | HOM | BR | CH | Q | THQL | THQP
 * @param {number} [spec.poles=1]    1 | 2 | 3 (ignored for tandem/quad, which encode their own poles)
 * @param {number} [spec.amps]       trip rating, A. For a quad it is the inner 2-pole rating (HOM)
 * @param {string} [spec.breakerType='standard']  one of TYPES
 * @param {number[]} [spec.tandemAmps]  tandem: [A, B]; quad: HOM outer pair [A, B], BR the two 2-pole ratings [A, B]
 * @param {string} [spec.neutral]    'pon' (plug-on-neutral) | 'pigtail' — steers protected-type suffix
 * @returns {{number:string, confident:boolean, note:string}}
 */
export function partNumber(spec = {}) {
  const family = String(spec.family || '').toUpperCase();
  const f = FAMILIES[family];
  if (!f) return { number: '', confident: false, note: `Unknown breaker family "${spec.family}" — pick the panel line first.` };

  const type = TYPES.includes(spec.breakerType) ? spec.breakerType : 'standard';
  const poles = isInt(spec.poles) ? spec.poles : 1;
  const pon = spec.neutral === 'pon';

  // --- Tandem: two single-pole breakers in one space, AABB (no pole digit). ---
  if (type === 'tandem') {
    const pair = Array.isArray(spec.tandemAmps) && spec.tandemAmps.length >= 2
      ? spec.tandemAmps
      : [spec.amps, spec.amps];
    if (!f.tandemPrefix) {
      return { number: '', confident: false, note: `${f.label} has no combined tandem body (use two 1/2" breakers). VERIFY.` };
    }
    if (!isInt(pair[0]) || !isInt(pair[1])) return { number: '', confident: false, note: 'Tandem needs two amp ratings.' };
    return { number: `${f.tandemPrefix}${amp(pair[0])}${amp(pair[1])}`, confident: true, note: '' };
  }

  // --- Quad: defined deterministically for Homeline and BR; best-effort elsewhere. ---
  if (type === 'quad') {
    const pair = Array.isArray(spec.tandemAmps) ? spec.tandemAmps : [];
    if (family === 'HOM') {
      // 2x1P outer (the pair) + 1x2P inner (amps): HOMT{A}{B}2{inner}
      if (!isInt(pair[0]) || !isInt(pair[1]) || !isInt(spec.amps)) {
        return { number: '', confident: false, note: 'Homeline quad needs two outer amps (tandemAmps) and the inner 2-pole amps (amps).' };
      }
      return { number: `CHOMT${amp(pair[0])}${amp(pair[1])}2${amp(spec.amps)}`, confident: true, note: '' };
    }
    if (family === 'BR') {
      // Two independent 2-pole breakers: BRD2{A}2{B}
      if (!isInt(pair[0]) || !isInt(pair[1])) {
        return { number: '', confident: false, note: 'BR quad needs the two 2-pole amp ratings (tandemAmps).' };
      }
      return { number: `BRD2${amp(pair[0])}2${amp(pair[1])}`, confident: true, note: '' };
    }
    return { number: '', confident: false, note: `${f.label} quad SKU form is not catalogued here — VERIFY and edit.` };
  }

  // --- Protected types: GFCI / AFCI / dual-function. Best Canadian string, flagged. ---
  if (type === 'gfci' || type === 'afci' || type === 'dual') {
    if (!isInt(spec.amps)) return { number: '', confident: false, note: `${type.toUpperCase()} needs an amp rating.` };
    const s = `${f.poleRepr(poles)}${amp(spec.amps)}`;
    const builder = f.protected[type];
    const number = builder ? builder(s, pon) : '';
    const kind = type === 'dual' ? 'Dual-function (AFCI/GFCI)' : type.toUpperCase();
    const neutralNote = pon ? ' Assumed plug-on-neutral.' : ' Confirm neutral style (plug-on vs pigtail).';
    return {
      number,
      confident: false,
      note: `${kind} ${f.label} suffixes vary by revision — VERIFY the stamped number and edit if needed.${neutralNote}`,
    };
  }

  // --- Standard (and treat hacr/lock-on form-factors as the plain core): prefix+pole+amps. ---
  if (!isInt(spec.amps)) return { number: '', confident: false, note: 'Standard breaker needs an amp rating.' };
  return { number: `${basePrefix(family)}${f.poleRepr(poles)}${amp(spec.amps)}`, confident: true, note: '' };
}

// The plain prefix for the standard core of each family (separate from the tandem prefix).
function basePrefix(family) {
  switch (family) {
    case 'QO': return 'CQO';
    case 'HOM': return 'CHOM';
    case 'BR': return 'BR';
    case 'CH': return 'CH';
    case 'Q': return 'Q';
    case 'THQL': return 'THQL';
    case 'THQP': return 'THQP';
    default: return '';
  }
}

/** The generator family key for a panel catalogue entry, or null when the line has no generator
 *  (proprietary lines such as Federal Pioneer Stab-lok and Leviton). Never guesses across makers. */
export function breakerFamilyFor(catalogEntry) {
  if (!catalogEntry) return null;
  const fam = catalogEntry.family;
  return fam && FAMILIES[fam] ? fam : null;
}

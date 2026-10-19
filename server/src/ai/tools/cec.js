// CEC calculators as tools. These call the app's own pure functions in
// electrical-app/js/lib/cec/ (the same code the Calculators screen runs), so answers
// cite the rule and table numbers that code cites. No CSA text is reproduced: results
// carry numbers, references and the app's own notes, plus a reminder that the
// authority having jurisdiction decides.
import {
  BOOK, SIZES, sizeLabel, ampacity, ampacityTable, ambientFactor, cccFactor, terminationTemp, maxOCPDForConductor,
  sizeConductor, voltageDrop, minSizeForVoltageDrop, maxLengthForVoltageDrop, VD_LIMITS, designCurrent,
  TRADE_SIZES, TRADE_SIZE_IN, CONDUIT_TYPES, CONDUCTOR_TYPES, conduitFill, minConduit,
  TABLE_22, BOXES, boxFill, singleDwelling, livingArea, motor, TABLE_44, TABLE_45,
  ADOPTION, amendmentsFor, ruleParams,
} from '../../../../electrical-app/js/lib/cec/index.js';

const FT = 0.3048;
const FT2 = 0.09290304;
export const AHJ_NOTE = 'Advisory estimate from Fishtape\'s CEC data. Verify against the code in force and with the authority having jurisdiction (inspector) before relying on it.';

const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? n : Math.round(Number(n) * 10 ** d) / 10 ** d);
const size = { type: 'string', enum: SIZES, description: 'Conductor size: AWG (14 ... 4/0) or kcmil (250 ... 500).' };
const material = { type: 'string', enum: ['cu', 'al'], default: 'cu', description: 'cu = copper, al = aluminum.' };
const tempC = (d) => ({ type: 'integer', enum: [60, 75, 90], default: d });
const lengthProps = {
  lengthM: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'One-way run length in metres.' },
  lengthFt: { type: 'number', exclusiveMinimum: 0, maximum: 330000, description: 'One-way run length in feet (use instead of lengthM when the user gave feet).' },
};
const oneWayM = (i) => (i.lengthM != null ? Number(i.lengthM) : i.lengthFt != null ? Number(i.lengthFt) * FT : null);

function province(ctx, input) {
  return input.province || ctx?.context?.province || 'ON';
}

const cite = (refs, extra = {}) => ({ book: `${BOOK.name} (${BOOK.standard})`, references: refs, note: AHJ_NOTE, ...extra });

export const CEC_TOOLS = [
  {
    name: 'cec_ampacity',
    description: 'Allowable ampacity of one conductor size under the CEC (Tables 1-4) with ambient (Table 5A) and bundling (Table 5C) corrections, the termination limit (Rule 4-006) and the largest overcurrent device allowed (Rule 14-104, Table 13). Use it to check a given conductor.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['size'],
      properties: {
        size, material,
        insulationC: { ...tempC(90), description: 'Insulation temperature rating column, °C.' },
        terminationC: { type: 'integer', enum: [60, 75, 90], description: 'Equipment termination rating, °C. Omit to apply the Rule 4-006 default.' },
        ambientC: { type: 'number', minimum: -50, maximum: 100, default: 30 },
        currentCarrying: { type: 'integer', minimum: 1, maximum: 200, default: 3, description: 'Current-carrying conductors in the raceway or cable.' },
        freeAir: { type: 'boolean', default: false, description: 'Single conductor in free air (Tables 1 and 3).' },
      },
    },
    run(_ctx, i) {
      const base = ampacity(i.size, i.material, i.insulationC, i.freeAir);
      if (base == null) return { error: `${sizeLabel(i.size)} ${i.material === 'al' ? 'aluminum' : 'copper'} is not in ${ampacityTable(i.material, i.freeAir).name}.` };
      const amb = ambientFactor(i.ambientC, i.insulationC);
      if (amb == null) return { error: `${i.insulationC} °C insulation is not permitted at ${i.ambientC} °C ambient (Table 5A).` };
      const adj = i.freeAir ? 1 : cccFactor(i.currentCarrying);
      const corrected = base * amb * adj;
      const termC = Math.min(i.terminationC || terminationTemp({ amps: corrected }), i.insulationC);
      const termAmps = ampacity(i.size, i.material, termC, i.freeAir);
      const usable = Math.min(corrected, termAmps);
      return {
        size: sizeLabel(i.size), material: i.material, table: ampacityTable(i.material, i.freeAir).name,
        insulationColumnAmps: base, ambientFactor: amb, bundlingFactor: adj, correctedAmps: round(corrected, 1),
        terminationC: termC, terminationLimitAmps: termAmps, usableAmps: round(usable, 1),
        maxOvercurrentDeviceAmps: maxOCPDForConductor(i.size, i.material, usable),
        ...cite(['Rule 4-004', ampacityTable(i.material, i.freeAir).name, 'Table 5A', 'Table 5C', 'Rule 4-006', 'Rule 14-104', 'Table 13']),
      };
    },
  },
  {
    name: 'cec_conductor_size',
    description: 'Smallest conductor for a load under the CEC: ampacity with corrections, continuous-load factor (Rule 8-104), termination temperature (Rule 4-006), breaker size (Rule 14-104) and, when a length and voltage are given, voltage drop (Rule 8-102).',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['amps'],
      properties: {
        amps: { type: 'number', exclusiveMinimum: 0, maximum: 5000, description: 'Load current, A.' },
        continuous: { type: 'boolean', default: false },
        rated100: { type: 'boolean', default: false, description: 'Overcurrent device marked for 100% continuous operation.' },
        material, insulationC: tempC(90),
        terminationC: { type: 'integer', enum: [60, 75, 90] },
        ambientC: { type: 'number', minimum: -50, maximum: 100, default: 30 },
        currentCarrying: { type: 'integer', minimum: 1, maximum: 200, default: 3 },
        volts: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
        phase: { type: 'integer', enum: [1, 3], default: 1 },
        ...lengthProps,
        maxVoltDropPct: { type: 'number', exclusiveMinimum: 0, maximum: 20, default: 3 },
      },
    },
    run(_ctx, i) {
      const len = oneWayM(i);
      const vd = len && i.volts ? (s) => {
        try { return voltageDrop({ volts: i.volts, phase: i.phase, amps: i.amps, lengthM: len, size: s, material: i.material }); } catch { return null; }
      } : null;
      const r = sizeConductor({ ...i, ccc: i.currentCarrying, maxVdPct: i.maxVoltDropPct, vd });
      if (!r.size) return { error: r.error, ...cite(['Rule 8-104', 'Rule 4-006', 'Rule 14-104']) };
      return {
        size: r.label, material: r.material, breakerAmps: r.ocpd, maxBreakerForConductorAmps: r.maxOcpd, usableAmps: round(r.usableAmpacity, 1),
        governedBy: r.governedBy, voltageDrop: r.vd ? { volts: round(r.vd.volts), percent: round(r.vd.percent) } : null,
        lengthM: len ? round(len, 1) : null, steps: r.reasons,
        ...cite(['Rule 8-104', r.table, 'Table 5A', 'Table 5C', 'Rule 4-006', 'Rule 14-104', 'Table 13', ...(vd ? ['Rule 8-102'] : [])]),
      };
    },
  },
  {
    name: 'cec_voltage_drop',
    description: 'Voltage drop for a run (Rule 8-102: 3% branch or feeder, 5% total), the smallest size that meets the limit, and the longest run for the given size.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['volts', 'amps'],
      properties: {
        volts: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
        phase: { type: 'integer', enum: [1, 3], default: 1 },
        amps: { type: 'number', minimum: 0, maximum: 5000, description: 'Connected load in A. Use 0 with breakerAmps to take 80% of the breaker (Rule 8-102).' },
        breakerAmps: { type: 'number', minimum: 0, maximum: 6000 },
        ...lengthProps,
        size: { ...size, description: 'Conductor size to check. Omit to get only the minimum size.' },
        material,
        maxPct: { type: 'number', exclusiveMinimum: 0, maximum: 20, default: 3 },
        province: { type: 'string', pattern: '^[A-Z]{2}$' },
      },
    },
    run(ctx, i) {
      const len = oneWayM(i);
      if (!len) return { error: 'Give the one-way length (lengthM or lengthFt).' };
      const d = designCurrent({ loadAmps: i.amps, ocpdAmps: i.breakerAmps });
      if (!(d.amps > 0)) return { error: 'Give the load current or the breaker rating.' };
      const limits = ruleParams('8-102', province(ctx, i));
      const out = {
        lengthM: round(len, 1), lengthFt: round(len / FT, 1), designAmps: round(d.amps, 1), basis: d.basis,
        limits: { branchPct: limits.branch, feederPct: limits.feeder, totalPct: limits.total },
        minimumSize: null, check: null,
      };
      const min = minSizeForVoltageDrop({ volts: i.volts, phase: i.phase, amps: d.amps, lengthM: len, material: i.material, maxPct: i.maxPct });
      out.minimumSize = min ? sizeLabel(min) : 'beyond 500 kcmil: use parallel conductors';
      if (i.size) {
        try {
          const v = voltageDrop({ volts: i.volts, phase: i.phase, amps: d.amps, lengthM: len, size: i.size, material: i.material });
          const maxLen = maxLengthForVoltageDrop({ volts: i.volts, phase: i.phase, amps: d.amps, size: i.size, material: i.material, maxPct: i.maxPct });
          out.check = { size: sizeLabel(i.size), dropVolts: round(v.volts), dropPct: round(v.percent), endVolts: round(v.endVolts, 1), pass: v.percent <= i.maxPct + 1e-9, maxLengthM: round(maxLen, 1), maxLengthFt: round(maxLen / FT, 1) };
        } catch (e) { out.check = { error: e.message }; }
      }
      return { ...out, ...cite(['Rule 8-102'], { resistanceSource: 'DC resistance at 75 °C (VERIFY against CEC Appendix D)' }) };
    },
  },
  {
    name: 'cec_conduit_fill',
    description: 'Conduit fill under Rule 12-910 and Table 8 (53% one conductor, 31% two, 40% three or more). Give tradeSize to check a conduit, or omit it to get the smallest trade size that fits.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['wires'],
      properties: {
        conduitType: { type: 'string', enum: Object.keys(CONDUIT_TYPES), default: 'EMT' },
        tradeSize: { type: 'string', enum: TRADE_SIZES, description: 'Metric trade size designator (16 = 1/2 in, 21 = 3/4 in, 27 = 1 in ...).' },
        wires: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['size', 'count'],
            properties: { size, insulation: { type: 'string', enum: Object.keys(CONDUCTOR_TYPES), default: 'T90 Nylon' }, count: { type: 'integer', minimum: 1, maximum: 500 } },
          },
        },
      },
    },
    run(_ctx, i) {
      const tables = [...new Set(i.wires.map((w) => CONDUCTOR_TYPES[w.insulation]?.table).filter(Boolean))];
      const shape = (r, ts) => ({
        conduit: `${CONDUIT_TYPES[i.conduitType].label} ${ts} (${TRADE_SIZE_IN[ts]} in)`, fillPct: round(r.fillPct, 1), allowedPct: r.allowedPct,
        wireAreaMm2: round(r.wireArea, 1), conduitAreaMm2: round(r.conduitArea, 1), conductors: r.count, pass: r.pass,
        ...(r.missing?.length ? { unknownWires: r.missing } : {}),
      });
      try {
        if (i.tradeSize) return { ...shape(conduitFill(i), i.tradeSize), ...cite(['Rule 12-910', 'Table 8', 'Table 9 series', ...tables], { verify: CONDUIT_TYPES[i.conduitType].verify }) };
        const m = minConduit(i);
        if (!m) return { error: 'No trade size up to 103 (4 in) fits; split the run.', ...cite(['Rule 12-910', 'Table 8']) };
        return { smallest: true, ...shape(m, m.tradeSize), ...cite(['Rule 12-910', 'Table 8', 'Table 9 series', ...tables], { verify: CONDUIT_TYPES[i.conduitType].verify }) };
      } catch (e) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'cec_box_fill',
    description: 'Outlet box fill under Rule 12-3034 with Tables 22 and 23: counts conductors, devices (2 each), fixture studs and connector pairs at the largest conductor size. Give boxId or boxVolumeML to check a box; omit both to list the standard boxes that fit.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['conductors'],
      properties: {
        conductors: {
          type: 'array', minItems: 1, maxItems: 10,
          items: { type: 'object', additionalProperties: false, required: ['size', 'count'], properties: { size: { type: 'string', enum: Object.keys(TABLE_22) }, count: { type: 'integer', minimum: 0, maximum: 100 } } },
        },
        devices: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
        studs: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
        connectors: { type: 'integer', minimum: 0, maximum: 40, default: 0 },
        boxId: { type: 'string', enum: BOXES.map((b) => b.id) },
        boxVolumeML: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
        extraML: { type: 'number', minimum: 0, maximum: 10000, default: 0, description: 'Extension ring or raised cover volume, mL.' },
      },
    },
    run(_ctx, i) {
      const box = i.boxId ? BOXES.find((b) => b.id === i.boxId) : null;
      const vol = box ? box.volumeML : i.boxVolumeML || 0;
      const r = boxFill({ ...i, boxML: vol });
      const out = {
        counted: r.items.map((x) => `${x.label}: ${x.count} × ${x.each} mL`), conductorEquivalents: r.count, largestSize: r.largest ? `${r.largest} AWG` : null,
        requiredML: round(r.requiredML, 1),
      };
      if (vol) Object.assign(out, { box: box ? box.name : `${vol} mL box`, availableML: r.availableML, pass: r.pass });
      else out.boxesThatFit = BOXES.filter((b) => r.requiredML <= b.volumeML + (i.extraML || 0) + 1).map((b) => `${b.name} (${b.volumeML} mL)`);
      return { ...out, ...cite(['Rule 12-3034', 'Table 22', 'Table 23'], { verify: 'Box volumes from a manufacturer catalogue (VERIFY against Table 23)' }) };
    },
  },
  {
    name: 'cec_dwelling_load',
    description: 'Calculated load for a single dwelling service under Rule 8-200 (with Rule 8-110 living area and Rule 62-118 heating demand), using the company\'s province for any amendments. Areas in m² or ft²; loads in watts.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        areaUnit: { type: 'string', enum: ['m2', 'ft2'], default: 'm2' },
        groundArea: { type: 'number', minimum: 0, maximum: 100000, description: 'Ground floor living area (inside dimensions).' },
        aboveArea: { type: 'number', minimum: 0, maximum: 100000, default: 0 },
        basementArea: { type: 'number', minimum: 0, maximum: 100000, default: 0, description: 'Basement with headroom over 1.8 m (counted at 75%).' },
        heatW: { type: 'number', minimum: 0, maximum: 200000, default: 0 },
        centralHeat: { type: 'boolean', default: false },
        acW: { type: 'number', minimum: 0, maximum: 200000, default: 0 },
        interlocked: { type: 'boolean', default: false, description: 'Heat and A/C cannot run at the same time (Rule 8-106(3)).' },
        rangeW: { type: 'number', minimum: 0, maximum: 50000, default: 0 },
        tanklessW: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100000 }, maxItems: 10, default: [] },
        evseW: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100000 }, maxItems: 10, default: [] },
        evems: { type: 'boolean', default: false },
        evemsW: { type: 'number', minimum: 0, maximum: 100000 },
        otherW: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100000 }, maxItems: 30, default: [], description: 'Other loads (dryer, water heater, dishwasher ...), W each.' },
        volts: { type: 'number', default: 240 },
        province: { type: 'string', pattern: '^[A-Z]{2}$' },
      },
    },
    run(ctx, i) {
      const k = i.areaUnit === 'ft2' ? FT2 : 1;
      const prov = province(ctx, i);
      const ground = (i.groundArea || 0) * k, above = (i.aboveArea || 0) * k, basement = (i.basementArea || 0) * k;
      const area = livingArea({ groundM2: ground, aboveM2: above, basementM2: basement }, { province: prov });
      const r = singleDwelling({ ...i, areaM2: area, areaNoBasementM2: ground + above }, { province: prov });
      return {
        province: prov, livingAreaM2: round(area, 1), livingAreaFt2: round(area / FT2, 0),
        lines: r.lines.map((l) => ({ item: l.label, rule: `Rule ${l.rule}`, watts: Math.round(l.w) })),
        calculatedW: Math.round(r.totalW), calculatedAmps: round(r.amps, 1), minimum: r.minimumRule, governedBy: r.governedBy,
        suggestedServiceAmps: r.service,
        amendments: amendmentsFor(prov).filter((a) => /^8-|^62-/.test(a.rule)).map((a) => `Rule ${a.rule} (${prov}): ${a.summary}`),
        ...cite(['Rule 8-200', 'Rule 8-110', 'Rule 62-118', 'Rule 8-106']),
      };
    },
  },
  {
    name: 'cec_motor',
    description: 'Motor branch circuit under CEC Section 28: full-load current (Table 44 three-phase, Table 45 single-phase), conductor at 125% (Rule 28-106), branch protection (Rule 28-200, Table 29) and overload (Rule 28-306).',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['hp', 'volts'],
      properties: {
        hp: { type: 'string', enum: [...new Set([...Object.keys(TABLE_44.hp), ...Object.keys(TABLE_45.hp)])], description: 'Horsepower as written in the tables, e.g. "1/2", "1-1/2", "10".' },
        volts: { type: 'integer', enum: [...new Set([...TABLE_44.volts, ...TABLE_45.volts])] },
        phase: { type: 'integer', enum: [1, 3], default: 3 },
        nameplateA: { type: 'number', exclusiveMinimum: 0, maximum: 2000 },
        serviceFactor115: { type: 'boolean', default: true, description: 'Service factor 1.15 or more (or marked temperature rise 40 °C).' },
      },
    },
    run(_ctx, i) {
      const r = motor(i);
      if (!r) return { error: `No ${i.phase}-phase full-load current for ${i.hp} hp at ${i.volts} V in the tables.` };
      return {
        fullLoadAmps: r.flc, table: r.table, conductorMinAmps: round(r.conductorAmps, 1), conductor: r.conductor ? `${sizeLabel(r.conductor)} Cu (75 °C column)` : null,
        breakerMaxAmps: round(r.breakerMax, 1), breakerAmps: r.breaker, timeDelayFuseAmps: r.tdFuse, nonTimeDelayFuseAmps: r.ntdFuse,
        wontStartCeilings: { timeDelayFuse: round(r.wontStart.timeDelayFuse, 1), nonTimeDelayFuse: round(r.wontStart.nonTimeDelayFuse, 1), breaker: round(r.wontStart.inverseTimeBreaker, 1) },
        overloadMaxAmps: round(r.overloadMax, 2), overloadPct: r.overloadPct,
        ...cite([r.table, 'Rule 28-106', 'Rule 28-200', 'Table 29', 'Rule 28-306']),
      };
    },
  },
  {
    name: 'cec_province_info',
    description: 'Which code edition is in force in a province, the inspection authority, permit notes, and the provincial amendments Fishtape tracks (summaries in Fishtape\'s own words). Filter amendments by rule (e.g. "26-") when helpful.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { province: { type: 'string', pattern: '^[A-Z]{2}$' }, rule: { type: 'string', maxLength: 20, pattern: '^[0-9]{1,2}-[0-9]{0,4}$' } },
    },
    run(ctx, i) {
      const prov = province(ctx, i);
      const a = ADOPTION[prov];
      return {
        province: prov,
        adoption: a ? { edition: a.edition, effective: a.effective, inForce: a.inForce, authority: a.authority, permitNote: a.permitNote, ...(a.verify ? { verify: a.verify } : {}) } : null,
        amendments: amendmentsFor(prov, i.rule || null).map((x) => ({ rule: `Rule ${x.rule}`, summary: x.summary, source: x.source })),
        voltageDropLimits: VD_LIMITS,
        ...cite([]),
      };
    },
  },
];

/** Sizes and tables the model may refer to, for the system prompt. */
export const CEC_FACTS = { sizes: SIZES, tradeSizes: TRADE_SIZES.map((t) => `${t} (${TRADE_SIZE_IN[t]} in)`), boxes: BOXES.map((b) => b.id) };

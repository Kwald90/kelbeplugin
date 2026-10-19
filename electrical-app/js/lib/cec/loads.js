// Calculated loads for services and feeders, CEC Section 8. Areas in m², loads in W.
// Parameters live in amendments.js RULE_PARAMS so a province can override one
// without a second copy of the maths.
//
// Sources: Rule 8-200 2024 text as reproduced by Manitoba Hydro, "Calculated load for
// services and feeders" (hydro.mb.ca); Rule 8-110 and 62-118 from Burr, "Guide to the CE
// Code 26th ed., Section 8" (electricalindustry.ca) and City of Vancouver load forms;
// Rule 8-202 from the City of Vancouver apartment/multiplex load calculation form (2024
// code) and ESA Bulletin 8-3-15. Gaps are marked VERIFY.
import { ruleParams } from './amendments.js';

/** Standard service and feeder ratings offered as results (equipment ratings, not a CEC table). */
export const SERVICE_SIZES = [60, 100, 125, 150, 200, 225, 300, 400, 600, 800];

/**
 * Rule 8-110: living area from inside dimensions = 100% of the ground floor and of floors
 * above used for living, plus 75% of floors below ground with headroom over 1.8 m.
 */
export function livingArea({ groundM2 = 0, aboveM2 = 0, basementM2 = 0 }, { province } = {}) {
  const p = ruleParams('8-110', province);
  return (Number(groundM2) || 0) + (Number(aboveM2) || 0) + (Number(basementM2) || 0) * p.basementFactor;
}

/**
 * Rule 62-118 demand for electric space heating in a dwelling: the first 10 kW at 100% and
 * the rest at 75% where each room has its own thermostat. Central heat (furnace, duct
 * heaters, thermal storage) is taken at 100%.
 */
export function heatingDemandW(watts, { central = false, province } = {}) {
  const p = ruleParams('62-118', province);
  const w = Number(watts) || 0;
  if (central) return w;
  return Math.min(w, p.fullW) + Math.max(0, w - p.fullW) * p.restFactor;
}

/** Range demand, Rule 8-200(1)(a)(iv): 6000 W for one range plus 40% of its rating above 12 kW. */
export function rangeDemandW(ratingW, { province } = {}) {
  const p = ruleParams('8-200', province);
  const w = Number(ratingW) || 0;
  if (w <= 0) return 0;
  return p.rangeBaseW + Math.max(0, w - p.rangeThresholdW) * p.rangeOverFactor;
}

/**
 * Rule 8-200(1)(a)(vii): loads rated over 1500 W not covered elsewhere (dryer, tank water
 * heater, dishwasher...). With a range: 25% of each. Without: 100% of their total up to
 * 6000 W, plus 25% of the rest.
 */
export function otherLoadsW(watts, hasRange, { province } = {}) {
  const p = ruleParams('8-200', province);
  const big = (watts || []).map(Number).filter((w) => w > p.otherThresholdW);
  const total = big.reduce((s, w) => s + w, 0);
  const w = hasRange ? total * p.otherFactor : Math.min(total, p.noRangeFullW) + Math.max(0, total - p.noRangeFullW) * p.otherFactor;
  return { w, count: big.length, total };
}

function nextService(amps, minimum) {
  return SERVICE_SIZES.find((s) => s >= Math.max(minimum, amps - 1e-9)) ?? null;
}

/** Range, tankless and other-load lines shared by 8-200 and 8-202(1). */
function applianceLines(o, province) {
  const p = ruleParams('8-200', province);
  const lines = [];
  const range = rangeDemandW(o.rangeW, { province });
  if (range) lines.push({ label: `Range ${fmtKW(o.rangeW)}: 6 kW + 40% over 12 kW`, rule: '8-200(1)(a)(iv)', w: range });
  const tankless = sum(o.tanklessW);
  if (tankless) lines.push({ label: 'Tankless water heater, pool, hot tub, steamer heaters at 100%', rule: '8-200(1)(a)(v)', w: tankless });
  const other = otherLoadsW(o.otherW, range > 0, { province });
  if (other.count) {
    lines.push(range
      ? { label: `Other loads over ${p.otherThresholdW} W (${other.count}) at 25%`, rule: '8-200(1)(a)(vii)', w: other.w }
      : { label: `Other loads over ${p.otherThresholdW} W (${other.count}), no range: 100% of the first ${p.noRangeFullW} W, 25% above`, rule: '8-200(1)(a)(vii)', w: other.w });
  }
  return lines;
}

/** Heating and A/C lines (Rule 8-200(1)(a)(iii) with Rule 8-106(3) when they can't run together). */
function hvacLines(o, province) {
  const heat = heatingDemandW(o.heatW, { central: o.centralHeat, province });
  const ac = Number(o.acW) || 0;
  if (!heat && !ac) return [];
  if (o.interlocked) {
    return [{ label: `${heat >= ac ? 'Space heating' : 'Air conditioning'}: the larger of heat and A/C, which can't run together`, rule: '8-200(1)(a)(iii), 8-106(3)', w: Math.max(heat, ac) }];
  }
  return [
    heat ? { label: `Space heating ${fmtKW(o.heatW)}${o.centralHeat ? ', central at 100%' : ': 10 kW at 100%, rest at 75%'}`, rule: '8-200(1)(a)(iii), 62-118', w: heat } : null,
    ac ? { label: 'Air conditioning / heat pump at 100%', rule: '8-200(1)(a)(iii)', w: ac } : null,
  ].filter(Boolean);
}

function evLines(o, rule) {
  const evse = sum(o.evseW);
  if (!evse) return [];
  if (o.evems && Number(o.evemsW) > 0) return [{ label: 'EV charging, capped by the energy management system', rule: `${rule}, 8-106(11)`, w: Math.min(evse, Number(o.evemsW)) }];
  return [{ label: 'EV charging at 100%', rule, w: evse }];
}

/**
 * singleDwelling({ areaM2 (living area, Rule 8-110), areaNoBasementM2, heatW, centralHeat, acW,
 *   interlocked, rangeW, tanklessW: [w], evseW: [w], evems, evemsW, otherW: [w], volts })
 *
 * Rule 8-200(1), the larger of (a) and (b):
 *  (a)(i)   5000 W for the first 90 m² of living area
 *     (ii)  + 1000 W for each further 90 m² or part of it
 *     (iii) + space heating with Section 62 demand + air conditioning at 100%
 *     (iv)  + range: 6000 W plus 40% of its rating above 12 kW
 *     (v)   + tankless water heaters and pool, hot tub, steamer, hydromassage heaters at 100%
 *     (vi)  + EV supply equipment at 100% (unless an EVEMS limits it, Rule 8-106(11))
 *     (vii) + other loads over 1500 W: 25% each with a range; without one, 100% up to 6000 W then 25%
 *  (b) 24 000 W when the area excluding the basement is 80 m² or more, otherwise 14 400 W
 *      (100 A and 60 A at 240 V; the 2024 edition states watts).
 * The result is not a continuous load (Rule 8-200(3)).
 */
export function singleDwelling(o, { province } = {}) {
  const p = ruleParams('8-200', province);
  const volts = Number(o.volts) || 240;
  const area = Math.max(0, Number(o.areaM2) || 0);
  const lines = [];
  const extraBlocks = Math.max(0, Math.ceil((area - p.basicAreaM2 - 1e-9) / p.blockM2));
  lines.push({ label: `Basic load, first ${p.basicAreaM2} m²`, rule: '8-200(1)(a)(i)', w: p.basicW });
  if (extraBlocks) lines.push({ label: `${extraBlocks} × ${p.blockM2} m² (or part) over ${p.basicAreaM2} m², ${p.blockW} W each`, rule: '8-200(1)(a)(ii)', w: extraBlocks * p.blockW });
  lines.push(...hvacLines(o, province), ...applianceLines(o, province), ...evLines(o, '8-200(1)(a)(vi)'));

  const totalW = lines.reduce((s, l) => s + l.w, 0);
  const amps = totalW / volts;
  const areaNoBasement = o.areaNoBasementM2 == null ? area : Number(o.areaNoBasementM2) || 0;
  const minimumW = areaNoBasement >= p.minAreaM2 ? p.minLargeW : p.minSmallW;
  const minimumAmps = minimumW / volts;
  const service = nextService(amps, minimumAmps);
  return {
    rule: '8-200', lines, totalW, amps, volts, minimumW, minimumAmps, service,
    minimumRule: `8-200(1)(b): ${minimumW.toLocaleString('en-CA')} W = ${Math.round(minimumAmps)} A (${areaNoBasement >= p.minAreaM2 ? `${p.minAreaM2} m² or more` : `under ${p.minAreaM2} m²`} without the basement)`,
    governedBy: totalW > minimumW ? 'calculated load' : 'minimum',
  };
}

/**
 * dwellingUnitLoad(o): one unit in an apartment or similar building, Rule 8-202(1):
 * 3500 W for the first 45 m², 1500 W for the second 45 m², then 1000 W per further 90 m²
 * or part, plus range, tankless and other loads as in Rule 8-200. Heating, A/C and EV loads
 * are returned separately because Rule 8-202(3) adds them after the unit demand factors.
 */
export function dwellingUnitLoad(o, { province } = {}) {
  const p = ruleParams('8-202', province);
  const area = Math.max(0, Number(o.areaM2) || 0);
  const second = area > p.basicAreaM2 ? p.secondW : 0;
  const beyond = area - p.basicAreaM2 - p.secondAreaM2;
  const blocks = beyond > 1e-9 ? Math.ceil((beyond - 1e-9) / p.blockM2) : 0;
  const basicW = p.basicW + second + blocks * p.blockW;
  const appliances = applianceLines(o, province).reduce((s, l) => s + l.w, 0);
  return {
    basicW, unitW: basicW + appliances,
    heatW: Number(o.heatW) || 0, acW: Number(o.acW) || 0, evW: sum(o.evseW),
  };
}

/**
 * apartmentService({ units: [{ areaM2, heatW, acW, rangeW, otherW, evseW, ... }], commonW, volts, phase })
 * Rule 8-202(3):
 *  (a) unit loads without heating, A/C and EV: 100% of the heaviest unit, 65% of the next 2,
 *      40% of the next 2, 25% of the next 15, 10% of the rest (VERIFY the 15-unit band and the 10%);
 *  (b) + space heating with Section 62 demand (VERIFY how 62-118 applies across units);
 *  (c) + air conditioning at 100%;
 *  (d) + EV supply equipment at 100% (City of Vancouver form; 2024 added EV demand factors for
 *      multi-unit buildings, VERIFY);
 *  (e) + loads outside the dwelling units at 75%.
 */
export function apartmentService(o, { province } = {}) {
  const p = ruleParams('8-202', province);
  const units = (o.units || []).map((u) => dwellingUnitLoad(u, { province }));
  const sorted = units.map((u) => u.unitW).sort((a, b) => b - a);
  const lines = [];
  let i = 0;
  for (const [count, factor] of p.unitFactors) {
    const slice = sorted.slice(i, count === Infinity ? undefined : i + count);
    if (!slice.length) break;
    lines.push({ label: `${slice.length} unit${slice.length > 1 ? 's' : ''} at ${Math.round(factor * 100)}%`, rule: '8-202(3)(a)', w: slice.reduce((s, x) => s + x, 0) * factor });
    i += slice.length;
  }
  const heat = heatingDemandW(units.reduce((s, u) => s + u.heatW, 0), { province });
  if (heat) lines.push({ label: 'Space heating, Section 62 demand', rule: '8-202(3)(b), 62-118', w: heat });
  const ac = units.reduce((s, u) => s + u.acW, 0);
  if (ac) lines.push({ label: 'Air conditioning at 100%', rule: '8-202(3)(c)', w: ac });
  const ev = units.reduce((s, u) => s + u.evW, 0) * p.evFactor;
  if (ev) lines.push({ label: `EV charging at ${Math.round(p.evFactor * 100)}%`, rule: '8-202(3)(d)', w: ev });
  const common = (Number(o.commonW) || 0) * p.commonFactor;
  if (common) lines.push({ label: `Loads outside the units at ${Math.round(p.commonFactor * 100)}%`, rule: '8-202(3)(e)', w: common });
  const totalW = lines.reduce((s, l) => s + l.w, 0);
  const volts = Number(o.volts) || 240;
  const amps = Number(o.phase) === 3 ? totalW / (Math.sqrt(3) * volts) : totalW / volts;
  return { rule: '8-202', lines, totalW, amps, volts, service: nextService(amps, 0) };
}

/**
 * Ontario only: OESC Table 39 (kept by Ontario after the national CEC deleted it in 2021)
 * sizes 90 °C single-dwelling service conductors when the load stays within their 75 °C
 * ampacity. Returns { cu, al, maxCu, maxAl } for a service rating, or null where the
 * province has no Table 39.
 */
export function table39(serviceAmps, { province } = {}) {
  const rows = ruleParams('4-004', province).table39;
  if (!rows) return null;
  const row = rows.find(([a]) => a >= serviceAmps);
  return row ? { amps: row[0], cu: row[1], maxCu: row[2], al: row[3], maxAl: row[4] } : null;
}

const sum = (a) => (a || []).map(Number).filter((w) => w > 0).reduce((s, w) => s + w, 0);
const fmtKW = (w) => `${Math.round((Number(w) || 0) / 100) / 10} kW`;

// CEC 2024 inspection checklists: [item, rule reference]. Item text is our own
// plain-language wording, never CSA text. Rule numbers were checked against
// public sources (ESA bulletins 2025, Technical Safety BC, Manitoba Hydro / City of
// Winnipeg, TSASK, IAEI and Burr's 26th-edition guides); see docs/code/checklists.md.
// Note the renumbering traps: NMSC rules moved to 12-552..12-576 in 2024, grounding
// electrodes are 10-102 (10-700 is now bonding of piping), and the CEC's own lighting
// outlet rules (30-500 series) moved to the National Building Code 9.34.2 in 2021.
import { AMENDMENTS } from './amendments.js';
import { ADOPTION } from './provinces.js';

export const CEC_TEMPLATES = [
  {
    id: 'dwelling-rough-in', title: 'Dwelling rough-in (CEC 2024)', prefixes: ['26-', '12-', '32-', '30-'],
    items: [
      ['AFCI (combination type) on branch circuits feeding 125 V receptacles of 20 A or less; exempt: bathroom-only, kitchen counter/island/peninsula, fridge and labelled sump-pump receptacles', '26-658'],
      ['Class A GFCI on receptacles within 1.5 m of sinks, bathtubs and showers', '26-704(1)'],
      ['Class A GFCI on outdoor receptacles within 2.5 m of finished grade (carports count as outdoors)', '26-704(2)'],
      ['Tamper-resistant 5-15R and 5-20R receptacles, new and replacement', '26-706'],
      ['Finished rooms: no point along the floor line more than 1.8 m from a receptacle', '26-722(a)'],
      ['Kitchen counters: no point along the wall line more than 900 mm from a receptacle', '26-722(d)(iii)'],
      ['Islands and peninsulas 600 × 300 mm or larger have a receptacle (5-15R split or 5-20R)', '26-722(d)(iv), (v)'],
      ['No face-up receptacles in kitchen work surfaces', '26-720(c)'],
      ['Fridge receptacle on its own circuit (fridges and freezers may share it)', '26-654(a)'],
      ['Laundry room and utility room circuits; washer receptacle plus one more in the laundry; one in each unfinished basement area', '26-654(b), (c); 26-720(e)'],
      ['Bathroom receptacle at least 1 m from the tub or shower where practicable, never closer than 500 mm', '26-720(g)'],
      ['Switches within 1 m of a tub or shower are GFCI protected; none closer than 500 mm', '30-320'],
      ['Two outdoor duplex receptacles on opposite sides of the house (one if the perimeter is 20 m or less)', '26-724(1)'],
      ['Garage or carport: a receptacle per car space, and one within 1 m of each cord-connected door opener', '26-724(3), (4)'],
      ['Lighting outlets and switching at entrances, stairs (3-way at 4+ risers), basements, garages', 'NBC 9.34.2'],
      ['Smoke and CO alarms hard-wired, on a lighting or receptacle circuit with no switch, interconnected', '32-200'],
      ['NMSC secured with straps or staples near every box and at regular intervals', '12-560'],
      ['Concealed NMSC 32 mm back from stud faces or behind steel plates; grommets in metal studs', '12-566'],
      ['Guard strips or running boards for cable in attics and on exposed joists', '12-564'],
      ['Exposed cable less than 1.5 m above the floor is protected', '12-568'],
      ['Cable 25 mm clear of heating ducts and pipes', '12-556'],
      ['Box fill within limits (Tables 22, 23)', '12-3034'],
      ['Boxes securely supported', '12-3010'],
      ['Box connectors where cables enter boxes; splices accessible', '12-3022; 12-112(4)'],
      ['Openings in fire separations sealed around cables and raceways', '2-128'],
      ['Bonding conductors connected to boxes and devices', 'Section 10 (10-600 to 10-614)'],
    ],
  },
  {
    id: 'service', title: 'Service and panel (CEC 2024)', prefixes: ['6-', '10-', '4-004', '8-', '14-', '2-'],
    items: [
      ['Calculated load supports the service size', '8-200 / 8-202'],
      ['Service conductors sized for the rating (Tables 2, 4; Ontario Table 39)', '4-004'],
      ['Service equipment close to where the conductors enter, readily accessible, not in a closet, bathroom or stairway', '6-206(1)'],
      ['2 m headroom at the service equipment', '6-206(1)(c)'],
      ['Overhead attachment point solidly anchored, same side as the service head, not on the fascia', '6-112'],
      ['Conductors leave the service head 150-300 mm above the attachment point', '6-116(1)(b)'],
      ['Meter on the supply side of the service box, readily accessible, weatherproof outdoors', '6-402(2); 6-408'],
      ['1 m working space in front of panels; 2.2 m headroom where live parts are exposed', '2-308'],
      ['Dwelling panel not in a closet, bathroom or stairway; no breaker handle above 1.7 m', '26-600'],
      ['Grounding electrodes installed (two rods at least 3 m apart, plate, or other permitted type)', '10-102'],
      ['Grounding conductor sized and installed', '10-114; 10-116'],
      ['Neutral grounded at one point only, at the service, through the system bonding jumper', '10-210'],
      ['System bonding jumper and bonding conductors sized', '10-616; Table 16'],
      ['Metal water, wastewater and gas piping bonded (No. 6 Cu exposed, No. 10 Cu concealed)', '10-700; 10-708'],
      ['Aluminum terminations cleaned, joint compound used unless the connector says otherwise', '12-118'],
      ['Terminations torqued to the manufacturer\'s values and recorded', '12-116'],
      ['Panel directory complete; equipment marked, including maximum load (new in 2024)', '2-100'],
    ],
  },
  {
    id: 'final', title: 'Final inspection (CEC 2024)', prefixes: ['26-7', '2-0', '32-'],
    items: [
      ['Every device has its plate; panel covers and dead fronts on', '2-100'],
      ['Weather-exposed receptacles have in-use (wet location) covers', '26-708'],
      ['AFCI and GFCI devices tested', '26-658; 26-704'],
      ['Smoke and CO alarms tested, interconnected', '32-200'],
      ['Range and dryer receptacles and appliance connections done', '26-744'],
      ['Panel directory updated for every circuit change', '2-100'],
      ['Bonding continuity checked', 'Section 10'],
      ['Shock and arc-flash marking on panels outside dwellings', '2-306'],
      ['Final inspection booked with the inspection authority; connection authorization where required', 'Provincial'],
    ],
  },
  {
    id: 'ev', title: 'EV charger install (CEC 2024)', prefixes: ['86-', '8-106', '8-202'],
    items: [
      ['EVSE on its own branch circuit, or a shared circuit controlled by an EVEMS', '86-300'],
      ['EVSE treated as a continuous load', '86-302; 8-104'],
      ['Lockable disconnect if over 60 A or over 150 V to ground', '86-304'],
      ['5-20R EV receptacle labelled; GFCI if outdoors within 2.5 m of grade', '86-306'],
      ['Service load includes the EVSE at 100%, or the EVEMS limit', '8-200(1)(a)(vi); 8-106(11)'],
      ['Bidirectional EVSE marked; Section 84 applies', '86-308'],
      ['Terminations torqued; circuit labelled in the panel', '12-116; 2-100'],
    ],
  },
  {
    id: 'commercial', title: 'Commercial fit-out (CEC 2024)', prefixes: ['14-', '46-', '2-3'],
    items: [
      ['Load calculation and panel schedules match installed circuits', 'Section 8; 2-100'],
      ['Working space 1 m; 1.5 m and egress rules at 1200 A and up', '2-308; 2-310'],
      ['Shock and arc-flash marking; arc energy reduction at 1200 A and up', '2-306'],
      ['Emergency lighting on its own circuit; unit equipment about 2 m up; remote heads within 5% drop', '46-106; 46-302; 46-306'],
      ['Exit signs on a dedicated or emergency circuit, always lit, no switch', '46-400'],
      ['Openings in fire separations sealed', '2-128'],
      ['Flexible cords not used in place of fixed wiring', '4-012'],
      ['Overcurrent devices and conductors match the panel schedule', '14-104; Table 13'],
    ],
  },
];

/**
 * Templates with the province's amendments appended as extra items, so a
 * Saskatchewan rough-in shows the 26-658 AFCI interpretation, Ontario's service
 * list shows Table 39 and so on.
 */
export function cecTemplates(province) {
  const amend = AMENDMENTS[province] || [];
  const name = ADOPTION[province] ? province : null;
  return CEC_TEMPLATES.map((t) => {
    const extra = name ? amend.filter((a) => t.prefixes.some((p) => a.rule.startsWith(p))) : [];
    return {
      ...t,
      items: [...t.items, ...extra.map((a) => [`${name} amendment: ${a.summary}`, `${a.rule} (${name})`])],
    };
  });
}

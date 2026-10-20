// Toolbox talk library: 20 short talks for electrical crews, about 5-10 minutes each.
// Written for Fishtape; plain language, no regulation text. References point to where the
// rule lives (docs/safety/README.md lists sources). A leader reads the points, asks the
// questions, and the crew signs.

export const TOPICS = [
  {
    id: 'loto', title: 'Lockout / tagout', ref: 'CSA Z460; provincial OHS regulations',
    points: [
      'Every worker who could be hurt puts on their own lock. One lock, one person, one key.',
      'Find every source: breakers, disconnects, back-feeds from generators, solar, UPS and stored energy in capacitors.',
      'Shut down, isolate, lock, tag, then release stored energy.',
      'Test before touch: prove your tester on a known live source, test the circuit, prove the tester again.',
      'Only the person who put the lock on takes it off. A cut lock is a manager decision with a written procedure.',
    ],
    questions: ['Where could back-feed come from on today\'s job?', 'What do you do if you find someone else\'s lock on a panel you need?'],
  },
  {
    id: 'arc-flash', title: 'Arc flash boundaries', ref: 'CSA Z462',
    points: [
      'An arc flash is an explosion of light, heat and pressure. Burns happen in a fraction of a second.',
      'Read the equipment label: incident energy, arc flash boundary and the PPE it calls for.',
      'The arc flash boundary is where an unprotected person could get a second-degree burn. Nobody crosses it without the right PPE.',
      'The limited and restricted approach boundaries are about shock: only qualified workers inside them.',
      'Normal operation (closing a door, racking a breaker) can still cause an arc if the gear is damaged. If in doubt, de-energize.',
    ],
    questions: ['Where is the label on the gear we work on today?', 'What PPE does the highest category we have need?'],
  },
  {
    id: 'gfci', title: 'GFCI protection', ref: 'CEC Section 76 (temporary wiring)',
    points: [
      'A GFCI trips when current leaks to ground, often through a person. It acts in milliseconds.',
      'On construction sites, receptacles for tools need GFCI protection.',
      'Push the test button at the start of every day. If it doesn\'t trip, tag it out.',
      'A GFCI that keeps tripping is telling you something: find the fault, don\'t bypass it.',
      'Wet locations and metal ladders make a ground fault much more dangerous.',
    ],
    questions: ['Which of our cords and panels did you test this morning?', 'What do you do with a GFCI that won\'t reset?'],
  },
  {
    id: 'ladders', title: 'Ladder safety', ref: 'CSA Z11; provincial construction regulations',
    points: [
      'Use non-conductive (fibreglass) ladders for electrical work.',
      'Inspect before each use: rails, rungs, feet, spreaders, labels. Tag out a damaged ladder.',
      'Set extension ladders at about 1 out for every 4 up, extending about 1 m past the landing, tied off.',
      'Keep three points of contact. Carry tools on a belt or hoist them, not in your hands.',
      'Don\'t stand on the top two steps of a stepladder or use it folded against a wall.',
    ],
    questions: ['When would a lift be better than a ladder today?', 'What makes a ladder unsafe to use?'],
  },
  {
    id: 'cold', title: 'Cold stress', ref: 'ACGIH cold stress TLVs; provincial OHS',
    points: [
      'Cold and wind take heat fast. Wet clothes make it worse.',
      'Dress in layers, keep a dry spare set, cover head, hands and feet.',
      'Watch for frostbite (white, waxy, numb skin) and hypothermia (shivering, confusion, clumsy hands).',
      'Take warm-up breaks in a heated shelter; drink warm, sweet fluids.',
      'Cold hands lose grip and feel: plan extra time for terminations and fine work.',
    ],
    questions: ['Where is the warm-up shelter on this site?', 'What would you do if a co-worker starts slurring words?'],
  },
  {
    id: 'heat', title: 'Heat stress', ref: 'ACGIH heat stress TLVs; provincial OHS',
    points: [
      'Heat illness can come on fast in attics, mechanical rooms and in arc-rated PPE.',
      'Drink water often, about a cup every 15-20 minutes, before you feel thirsty.',
      'Signs: heavy sweating, cramps, headache, dizziness, nausea. Stop, cool down, tell someone.',
      'Heat stroke (confused, hot dry skin, collapse) is an emergency: call 911 and cool them right away.',
      'New workers and people back from time off need a few days to get used to heat.',
    ],
    questions: ['How will we schedule the hottest tasks today?', 'Who is the buddy you check on?'],
  },
  {
    id: 'ppe', title: 'Personal protective equipment', ref: 'Provincial OHS regulations; CSA Z462, Z94 series',
    points: [
      'PPE is the last line of defence. First remove or control the hazard.',
      'Minimum on site: hard hat, safety glasses, safety boots, hi-vis where there is traffic.',
      'Arc-rated clothing only works if it matches the hazard and is worn as the outer layer, closed.',
      'Rubber insulating gloves need an air test before each use and a retest date that is current.',
      'Damaged PPE comes out of service today. Tell your foreman what you need.',
    ],
    questions: ['What PPE does today\'s task need beyond the minimum?', 'When was your glove retest?'],
  },
  {
    id: 'housekeeping', title: 'Housekeeping', ref: 'Provincial construction regulations',
    points: [
      'Most slips and trips come from cords, offcuts and packaging on the floor.',
      'Clean as you go: wire scraps and knockouts in a bin, not on the floor.',
      'Keep exits, stairs, panels and extinguishers clear.',
      'Hang or route cords overhead where you can.',
      'Leave the area safe for the next trade at the end of the day.',
    ],
    questions: ['What is the worst trip hazard in our area right now?', 'Where do our scraps go on this site?'],
  },
  {
    id: 'cords', title: 'Extension cords', ref: 'CEC Section 76; CSA C22.2',
    points: [
      'Use heavy-duty, outdoor-rated cords with a ground pin. No taped or spliced cords.',
      'Size the cord for the load and the length: a long thin cord overheats and drops voltage.',
      'Don\'t run cords through doorways, windows or under traffic without protection.',
      'Unplug by the plug, not the cord. Don\'t daisy-chain cords.',
      'Inspect before use; tag out damaged cords and take them off site.',
    ],
    questions: ['Which cord on site needs replacing?', 'How do we protect cords crossing the walkway?'],
  },
  {
    id: 'temp-power', title: 'Temporary power', ref: 'CEC Section 76',
    points: [
      'Temporary wiring is still wiring: it must be installed and maintained to the code.',
      'Panels stay closed with covers and blanks in place; circuits labelled.',
      'GFCI-protected receptacles for tools; test them daily.',
      'Protect temporary cables from vehicles, water and sharp edges.',
      'Only qualified workers change temporary power. Everyone else reports damage.',
    ],
    questions: ['Who is responsible for the temporary panel on this site?', 'What do you do if you see a damaged temp cable?'],
  },
  {
    id: 'overhead', title: 'Working near overhead lines', ref: 'O. Reg. 213/91 s.188 (ON); provincial equivalents',
    points: [
      'Contact with overhead lines kills workers every year, often through a boom, ladder or pipe.',
      'Know the minimum distance for the voltage; in Ontario 3 m for 750 V to 150 kV.',
      'Use a signaller when equipment could come close; plan the route before you move.',
      'Call the utility to de-energize, move or cover lines when you must work closer.',
      'If a vehicle touches a line: stay inside, keep others away. If you must leave, jump clear and shuffle away.',
    ],
    questions: ['Where are the overhead lines on this site?', 'What is our plan if the lift has to work near them?'],
  },
  {
    id: 'hand-tools', title: 'Hand tool safety', ref: 'Provincial OHS regulations',
    points: [
      'Use the right tool for the job: a screwdriver is not a pry bar.',
      'Insulated tools must be rated (1000 V) and undamaged; they don\'t replace de-energizing.',
      'Cut away from your body; keep knives sheathed and blades sharp.',
      'Check handles, heads and jaws; tag out broken tools.',
      'Tether tools when working at heights.',
    ],
    questions: ['Which tool have you seen misused lately?', 'Where do damaged tools go?'],
  },
  {
    id: 'silica', title: 'Silica dust', ref: 'Provincial OHS exposure limits (ACGIH TLV)',
    points: [
      'Drilling, cutting and chasing concrete, brick or block makes fine silica dust that scars the lungs.',
      'Use wet methods or tools with a shroud and HEPA vacuum.',
      'No dry sweeping or compressed air for cleanup.',
      'Wear the respirator the task calls for, fit-tested and clean-shaven where it seals.',
      'Keep other trades out of the dust area.',
    ],
    questions: ['Which tasks today create silica dust?', 'Is your respirator fit test current?'],
  },
  {
    id: 'confined', title: 'Confined space awareness', ref: 'Provincial confined space regulations',
    points: [
      'Vaults, manholes, crawl spaces and tanks can hold bad air you can\'t see or smell.',
      'No entry without a permit, an air test, an attendant and a rescue plan.',
      'Air is tested before entry and monitored while you are inside.',
      'Most confined space deaths are would-be rescuers. Never go in after someone: call for rescue.',
      'If you don\'t know whether a space is "confined", ask before you go in.',
    ],
    questions: ['Is there a confined space on this site?', 'Who is trained to enter and who is the attendant?'],
  },
  {
    id: 'first-aid', title: 'First aid and the emergency plan', ref: 'Provincial first aid regulations',
    points: [
      'Know where the first-aid kit, eyewash and AED are, and who the first aiders are.',
      'Know the address of the site and the nearest hospital before you need it.',
      'In an emergency: make the area safe, call 911, send someone to meet the ambulance.',
      'Electrical contact: don\'t touch the person until power is off.',
      'Report every injury, even first aid, the same day.',
    ],
    questions: ['Where is our muster point?', 'Who are the first aiders on site today?'],
  },
  {
    id: 'whmis', title: 'WHMIS labels', ref: 'WHMIS 2015 (Hazardous Products Act and Regulations)',
    points: [
      'Supplier labels show the product name, pictograms, signal word, hazard and precautionary statements and supplier.',
      'Read the safety data sheet (SDS) before using a new product: hazards, PPE, first aid, spills.',
      'Put a workplace label on any container you decant into.',
      'Common electrical products with hazards: cable pulling lubricant, PVC cement and primer, cleaners, sealants.',
      'Know where the SDS binder or app is for this site.',
    ],
    questions: ['What does the flame pictogram mean?', 'Where are the SDSs on this site?'],
  },
  {
    id: 'fall-protection', title: 'Fall protection', ref: 'Provincial construction regulations; O. Reg. 297/13 (ON training)',
    points: [
      'Guardrails first. Harnesses are for when guardrails aren\'t practical.',
      'Tie off to a rated anchor, above you where you can, with the right lanyard length.',
      'Inspect your harness and lanyard before every use.',
      'Have a rescue plan: a worker hanging in a harness needs help within minutes.',
      'In Ontario, workers who use fall protection need Working at Heights training, valid 3 years.',
    ],
    questions: ['What is our anchor point for today\'s work?', 'How would we rescue someone hanging in a harness?'],
  },
  {
    id: 'vehicles', title: 'Vehicle safety', ref: 'Provincial traffic and OHS rules',
    points: [
      'Do a walk-around before you drive: tires, lights, load secured.',
      'Secure ladders, conduit and reels so they can\'t shift or fall off.',
      'No phone while driving. Pull over to call or text.',
      'Back in when you arrive so you can drive out forward; use a spotter.',
      'Report damage and near misses with vehicles like any other incident.',
    ],
    questions: ['Is everything on the rack tied down?', 'Where is the safest place to park on this site?'],
  },
  {
    id: 'mental-health', title: 'Mental health on site', ref: 'Canadian Mental Health Association; 988 Suicide Crisis Helpline',
    points: [
      'Construction has high rates of stress, substance use and suicide. It is OK to not be OK.',
      'Signs a co-worker is struggling: withdrawn, angry, careless, missing work, talking about being a burden.',
      'Ask directly and listen. You don\'t need to fix it; help them reach help.',
      'Call or text 988 (Canada) any time for the suicide crisis helpline. Use your EAP if the company has one.',
      'Fatigue and stress cause mistakes: speak up if you are not fit for a task today.',
    ],
    questions: ['Who can you talk to on this crew?', 'Do you know our EAP number?'],
  },
  {
    id: 'near-miss', title: 'Near-miss reporting', ref: 'COR element: incident investigation',
    points: [
      'A near miss is an incident where nobody got hurt this time.',
      'Reporting near misses fixes hazards before they injure someone. There is no blame for reporting.',
      'Report it in Fishtape from your phone: what happened, where, a photo, what you did.',
      'The foreman reviews it and assigns a fix with an owner and a due date.',
      'Many near misses for each injury is a sign of a crew that speaks up.',
    ],
    questions: ['What near miss have you seen this month?', 'What stops people reporting, and how do we fix that?'],
  },
];

export const topicById = (id) => TOPICS.find((t) => t.id === id) || null;

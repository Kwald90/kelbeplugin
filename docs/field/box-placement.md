# Box placement and the drawing code check

Draw a room on a plan and Fishtape proposes receptacles, switches, lights and
alarms for it, then checks the layout against the Canadian Electrical Code
(CSA C22.1:24, "CEC 2024"). It is an estimating and layout aid. It does not
replace the inspector or the code book, and provinces amend the code.

Code: `electrical-app/js/lib/placement-rules.js` (rule data),
`js/lib/placement.js` (geometry and auto-place), `js/lib/placement-check.js`
(findings), `js/canvas/rooms.js` (canvas tools). Tests:
`electrical-app/tests/placement.test.mjs`.

## Using it

1. **Set the scale** first (Measure → Set scale, or More → Set scale). Type
   the real length in your units: `12' 6"` or `3.8 m`.
2. **Room tool** (shapes bar, or `O`). Pick *Rectangle* (drag corner to
   corner) or *Polygon* (tap each corner, tap the first one to close).
   Corners snap to 50 mm (2" in imperial), to other rooms' corners, and
   square up to the last corner. Name the room and pick its type.
3. **Mark the walls.** With the room selected, *Add door, window…*, pick a
   kind and tap a wall (drag along it to set the width). Doors and windows
   stay picked so you can add several; tap *Done*. Tap anything you added to
   edit it: width, position, hinge side (left or right as you face the door
   from inside the room), swing in or out, whether it is an entry (gets a
   switch), window to the floor, gas range, island size and rotation.
   Drag an item along its wall to move it. Drag a corner square to reshape the
   room; drag the room's wall or name to move it.
4. **Auto-place** (room bar, or More → *Auto-place boxes in every room*).
   Proposals appear as dashed ghosts. Tap one to pick it (the reason and rule
   show), drag to nudge, then *Accept picked*, *Accept all*, *Discard picked*
   or *Discard all*. Accepted ghosts become normal symbols on the active layer
   (or the top usable layer that is not Rooms), so takeoff and estimates count
   them. Auto-place respects what is already there: it only fills gaps.
5. **Code check** (shield button). Findings show as numbered markers and in a
   panel. Tap a finding to zoom to it. Some have a one-tap fix (*Make GFCI*,
   *Mark AFCI*, *Mark TR*, *Mark WP cover*). Turn on *Live* to re-check after
   every change.
6. **Protection marks.** Select symbols and tap the tag button to mark GFCI,
   AFCI, tamper-resistant, weatherproof cover, switched, or smoke-only, and to
   set the mounting height. Marks show as small tags (GF, AF, TR, WP, SW).
7. **Settings** (More → *Placement & check settings*): mounting heights,
   switch distance from the jamb, recessed spacing, door-swing rule, 3-way
   switches, which alarms to place, whether the house has a fuel-burning
   appliance or attached garage (CO alarms), live check. Saved for the drawing,
   or as the company default if you can edit settings.

Works with Apple Pencil and touch (Pointer Events). With a pencil, a finger
pans; without one, a finger draws. Lengths show in each user's units.

## What it places

| room type | proposals |
| --- | --- |
| bedroom, living/family, dining, other finished | receptacles so no point of usable wall is over 1.8 m from one (26-722 a), c)); switch at each entry; ceiling light (living: recessed grid); bedroom smoke alarm (NBC) |
| kitchen | counter receptacles at 900 mm reach, none behind the sink, GFCI within 1.5 m of it, no AFCI (exempt); island/peninsula receptacle; fridge receptacle; gas range receptacle at 130 mm max or 14-50R for an electric range; other walls at 1.8 m; recessed grid |
| bathroom | GFCI receptacle within 1 m of each basin, as far as it can be from the tub/shower (1 m preferred, 500 mm minimum) |
| hallway | receptacles so no point is over 4.5 m from one; ceiling lights about 3 m apart; smoke alarm |
| laundry | washer receptacle plus one more |
| garage | one receptacle per car space |
| unfinished basement | at least one receptacle; smoke alarm |
| outdoor / balcony | GFCI (within 2.5 m of grade) receptacle with a weatherproof cover on the house wall; wall light by the door |

Every receptacle is marked TR (26-706); AFCI (26-658) except kitchen counter,
island, peninsula and fridge receptacles.

## Rules and where the numbers come from

| id | rule | value | source | status |
| --- | --- | --- | --- | --- |
| wallSpacing | CEC 26-722 a) | 1.8 m along the floor line | [NB], [TSBC] | confirmed |
| balcony | CEC 26-722 b) | at least one receptacle | [NB], [TSBC] | confirmed |
| usableWall | CEC 26-722 c) | 900 mm or wider; doorways, door swing, floor-length windows, fireplaces and built-ins excluded | [NB] | confirmed |
| fridge | CEC 26-722 d) i) | one per refrigerator | [NB], [ESA-K] | confirmed |
| gasRange | CEC 26-722 d) ii) | behind a free-standing gas range, centre ≤ 130 mm | [NB], [ESA-R] | confirmed |
| counter | CEC 26-722 d) iii) | ≤ 900 mm along the wall line; sinks, built-ins and sections under 300 mm excluded | [NB], [ESA-K], [TSBC] | confirmed |
| island / peninsula | CEC 26-722 d) iv), v) | one receptacle when long side ≥ 600 mm and short side ≥ 300 mm | [NB], [ESA-K] | confirmed |
| kitchenWalls | CEC 26-722 d) vi) | other kitchen walls per 26-722 a) | [NB], [ESA-K] | confirmed |
| sinkFront | CEC 26-722 e) | no receptacle directly in front of or behind the sink | [NB] | VERIFY |
| islandSide | CEC 26-722 f) | side face ≤ 300 mm below the top, overhang ≤ 150 mm | [NB], [ESA-K] | VERIFY |
| hallway | CEC 26-722 g) | 4.5 m | [NB] | VERIFY (letter) |
| gfciWet | CEC 26-704 1) | Class A GFCI within 1.5 m of sinks, tubs, showers | [ESA-G] | VERIFY (subrule) |
| gfciOutdoor | CEC 26-704 2) | Class A GFCI outdoors within 2.5 m of grade | [ESA-G] | confirmed |
| tamper | CEC 26-706 | tamper-resistant 5-15R/5-20R | [ESA-G] | confirmed |
| weather | CEC 26-708 | cover for receptacles exposed to the weather | [ESA-G] | confirmed |
| laundry | CEC 26-720 e) i), ii) | washer receptacle plus one more | [ESA-L] | confirmed |
| utility | CEC 26-720 e) iii) | one per utility room | [ESA-L] | confirmed (not a room type yet) |
| basement | CEC 26-720 e) iv) | one per unfinished basement area | [ESA-L] | confirmed |
| basin | CEC 26-720 f) | receptacle within 1 m of the basin | earlier editions | VERIFY |
| tub | CEC 26-720 g) | 1 m where practicable, never under 500 mm | [ESA-L] | confirmed |
| maxHeight | CEC 26-720 j) | required receptacles ≤ 1.7 m | [ESA-L] | confirmed |
| outdoorSingle | CEC 26-724 a) | outdoor receptacle, single dwelling | [ESA-O] (2021) | VERIFY |
| garage | CEC 26-724 b) | one per car space | [IAEI] (2018, as 26-726 b)) | VERIFY |
| afci | CEC 26-658 | combination AFCI on 125 V ≤ 20 A receptacle circuits; kitchen counter, island, peninsula and fridge exempt | [ESA-G], [ESA-K], [TSBC] | confirmed |
| smoke | NBC 9.10.19.3 | each bedroom; between bedrooms and the rest of the storey; each storey | [NBC] | VERIFY (building code) |
| co | NBC 9.32.3.9 | in or within 5 m of each bedroom when there is a fuel-burning appliance or attached garage | [NBC] | VERIFY (building code) |
| lighting | NBC 9.34.2.2 | wall-switched lighting outlet; switched receptacle allowed in bedrooms and living rooms | [NBC-L] | VERIFY (building code) |
| latchSwitch, threeWay | practice | switch on the latch side; 3-way at each entry of a room with 2+ entries | company practice | not code |

Numbers and references only. CSA's text is not reproduced here or in code.

## VERIFY list

Check these against the purchased CSA C22.1:24 and your provincial adoption:

1. **26-704 1)**: the 1.5 m sink/tub/shower GFCI rule is confirmed in the 2024
   cycle, but sources cite it as "26-704" without the subrule number. We also
   apply it to kitchen sinks (ESA 26-29-6 treats existing kitchen split
   receptacles as caught by it).
2. **26-722 e) and f)**: seen in New Brunswick's restatement of 26-722. They
   may be New Brunswick additions rather than base CEC text.
3. **26-722 g)**: hallway 4.5 m is confirmed; the subrule letter comes from
   the NB restatement (it may be e) in the base code).
4. **26-720 f)**: bathroom receptacle within 1 m of the basin. The 2024
   sources we found cite 26-720 e), g) and j) but not f); number and
   distance are from earlier editions. We measure from the basin's edge.
5. **26-724 a) and b)**: outdoor receptacle (2021 numbering) and one per car
   space (2018 had it as 26-726 b)). Confirm 2024 numbers.
6. **NBC 9.10.19.3, 9.32.3.9, 9.34.2.2**: building code, from municipal and
   provincial guides, not the NBC text. Ontario requires a CO alarm adjacent
   to each sleeping room; BC moved the CEC 30-500 lighting rules into its
   building code. Settings switch the alarm rules on or off.
7. **26-744** (electric range 14-50R): proposed only, not checked; number not
   verified.
8. **Our readings**, not code text: "a receptacle for" the fridge, gas range or
   washer means within 300 mm of its footprint; outdoor rooms are within
   2.5 m of grade unless you set a height.

## How the check measures (simplifications)

- Floor-line distance is measured along the wall inside one run of usable
  wall. Runs break at doors, openings, floor-length windows, built-ins,
  counters and appliance spaces (fridge, range, washer, tub, shower). The wall
  a door covers when fully open is excluded (setting). A room with no doors is
  one loop and the distance wraps round.
- Receptacles in an adjoining room are not credited (the code allows it); the
  check errs on the side of one more box.
- A symbol counts as on a wall when its centre is within 450 mm of it.
- Counters are checked wall by wall. An L-shaped counter is two counters, and
  only boxes within a counter's own length count for it.
- Hallway reach uses straight lines inside the hallway, not the cord path the
  code describes, so an L-shaped hallway can read short.
- Distances to sinks, basins, tubs and showers are straight lines to the
  fixture's footprint.
- Accuracy is only as good as the drawing scale.

## Data

`drawings.rooms[]` (new, optional; older drawings get `[]`):

```
{ id, layer, name, type, points: [[x, y], ...] (world px, inside face of the walls),
  features: [{ id, kind, wall, atM, widthM, depthM?, hinge?: 'start'|'end', swing?: 'in'|'out',
               entry?, toFloor?, gas? }
           | { id, kind: 'island', x, y, lengthM, depthM, rotation, peninsula?, sink?, fixed? }],
  lighting?, carSpaces?, aboveGradeM? }
```

Room types: `bedroom, living, kitchen, dining, bathroom, hallway, laundry,
garage, basement, outdoor, other`. Feature kinds: `door, opening, window,
obstruction, counter, sink, cooktop, range, fridge, washer, tub, shower,
island`. Lengths are metres. `hinge: 'start'` puts the hinge at the end of the
door nearer the wall's first corner.

Also on the drawing: `codeOptions { fuelBurning, live }` and `placement`
(per-drawing overrides of the company `settings.placement`).

Symbols gain optional `flags { gfci, afci, tr, wp, switched, counter, dedicated, smoke, co }`,
`mountM` (centre height, metres), and for auto-placed ones `roomId`, `auto: true`
and `rules` (the rule labels that put it there). Symbol ids are unchanged, so
the takeoff still counts `receptacle`, `receptacle-gfci`, `switch`,
`switch-3way`, `light-ceiling`, `light-recessed`, `light-wall`, `smoke`,
`receptacle-240`.

## Sources

- [NB] New Brunswick Regulation 2026-5, amending NB Reg 84-165 to adopt
  C22.1-24 and restating Rule 26-722 a)–g):
  https://laws.gnb.ca/en/document/ar/2026-5
- [ESA-K] ESA Bulletin 26-23-7, Receptacle requirements in kitchens of
  dwelling units (May 2025): https://esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/26-23-7.pdf
- [ESA-L] ESA Bulletin 26-26-6, unfinished basements, utility and laundry
  rooms, tub and shower areas (May 2025): https://esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/26-26-6.pdf
- [ESA-G] ESA Bulletins 26-18-15 (AFCI and GFCI in a dwelling unit) and
  26-29-6 (replacements and alterations), May 2025:
  https://esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/26-18-15.pdf,
  https://esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/26-29-6.pdf
- [ESA-R] ESA Bulletin 26-14-9, receptacles for range installations (May 2025):
  https://esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/26-14-9.pdf
- [ESA-O] ESA Q&A, outdoor receptacles and circuits (OESC 2021):
  https://dev.esasafe.com/assets/files/esasafe/pdf/Electrical_Safety_Products/Bulletins/OESC_QA_outdoor-receptacles_2022.pdf
- [TSBC] Technical Safety BC directive D-EL 2016-01 r2 (Section 26):
  https://www.technicalsafetybc.ca/alert/bc-electrical-code-section-26-installation-electrical-equipment
- [IAEI] IAEI, "2018 CE Code (Part 4)", Section 26 renumbering:
  https://iaeimagazine.org/columns/canadian/ce-code/
- [NBC] Smoke and CO alarm guides citing NBC 9.10.19.3 and 9.32.3.9 (search
  summaries; not read in full): https://www.saskatoon.ca/sites/default/files/Smoke_and_CO_alarms.pdf,
  https://www.nanaimo.ca/docs/property-development/building-permits/suite-maindwellingalarmsinstallationguide.pdf
- [NBC-L] Technical Safety BC IB-EL 2023-02, luminaires in residential
  occupancy (CEC 30-500 moved to building code 9.34): https://www.technicalsafetybc.ca/regulatory-resources/regulatory-notices/information-bulletin-luminaires-buildings-residential-occupancy

Ontario (ESA) bulletins interpret the Ontario Electrical Safety Code, which
adopts the CEC with amendments. Numbering in the 2024 cycle matches the CEC
for the rules above, but Ontario amendments are not applied here.

# Pipe bending

The bending tool is at `#/bending` (Field group, permission `calcs`). It works out where to mark
conduit for each kind of bend, draws the bent pipe to scale, and saves bends against a job.

Code:

| file | what |
| --- | --- |
| `electrical-app/js/lib/bending.js` | the geometry: pure functions, SI in (metres, degrees), marks out |
| `electrical-app/js/lib/bending-profiles.js` | built-in bender values, CEC Table 7 radii, calibration maths |
| `electrical-app/js/lib/bending-svg.js` | the two diagrams as SVG strings (screen, print and tests share them) |
| `electrical-app/js/modules/bending.js` | the screen: `#/bending/<kind>`, `#/bending/saved`, `#/bending/profiles`, `#/bending/pull` |
| `electrical-app/tests/bending.test.mjs` | worked examples, checked by hand |

Anything marked **VERIFY** below is a value or rule reference we could not confirm from a primary
source. The full list is at the end.

## How the numbers work

**Marks** are measured along the straight pipe from the reference end (the left end in both
drawings). The tool shows marks to the nearest 1/16" (inches up to 10', then feet-inches) or the
nearest mm, depending on the user's units (`js/lib/units.js`). Each position is rounded on its own
and the distances between marks are worked out from the rounded positions, so the numbers on the
screen add up on the tape. Lengths are stored in metres.

**Inputs** accept what people type: `12' 3 5/8"`, `12'3"`, `30 1/2`, `3-5/8"`, `450mm`, `45 cm`,
`1.2 m`. A bare number means inches for imperial users and millimetres for metric users. Under each
box the tool shows how it read the value in both systems ("= 30 1/2" · 775 mm"), so a misread is
caught before anyone bends.

**Bend model.** Offsets, kicks and saddles use the textbook model, where each bend is treated as a
point at its mark. That is what every bender chart assumes. 90s, back-to-backs and segment bends
use the bender's radius and the pipe's outside diameter.

**Exact or chart numbers.** By default the tool uses the exact trigonometry. Tick *Chart numbers* to
use the rounded figures printed on hand benders instead (6, 2.6, 2, 1.4, 1.2; 2½ for 45° saddles).
Crews then get the same marks their bender's chart gives. Angles that are not on the chart always
use the exact figure.

## Formulas

θ is the bend angle and R the rise (offset depth).

### Offset

- Distance between the two marks = R × multiplier, with multiplier = 1 / sin θ (cosecant).
- Shrink = R × tan(θ/2). This is how much shorter the pipe ends up along the run.
- Run of the offset (along the wall) = R / tan θ.
- **Working toward an obstruction** at distance D from the end: mark 2 = D + shrink, and mark 1 =
  mark 2 − R × multiplier. The tool refuses the bend if mark 1 would fall off the pipe.
- **Working away from a fixed first bend** at F: mark 1 = F, and mark 2 = F + R × multiplier. No
  shrink is added because the shrink comes off the free end.
- **Fixed mark distance**: given the spacing L between marks, θ = asin(R / L).
- Cut length, when the overall run W is known = W + shrink.

| angle | multiplier (exact) | shrink per unit of rise (exact) | chart multiplier | chart shrink per inch |
| --- | --- | --- | --- | --- |
| 10° | 5.759 | 0.087 | 6 | 1/16" |
| 22.5° | 2.613 | 0.199 | 2.6 | 3/16" |
| 30° | 2.000 | 0.268 | 2 | 1/4" |
| 45° | 1.414 | 0.414 | 1.4 | 3/8" |
| 60° | 1.155 | 0.577 | 1.2 | 1/2" |

The chart figures are the same in the Klein Conduit Bender Guide [K], Greenlee IM 1071 [G98] and
the Greenlee Site-Rite guide [G23]. IDEAL's table matches [I].

Worked example (in the tests): a 6" offset at 30° puts the marks 12" apart with 1.608" of shrink
(the chart says 1/4" per inch, so 1.5"). With the obstruction 36" from the end, the marks go at
25 5/8" and 37 5/8".

Directions: bend 1 at the first mark with the arrow on the mark and the hook facing away from mark
2 [K]. Then slide the bender to mark 2, roll the pipe 180° and make the same bend.

### Kick

One bend that moves the end of the pipe R off the line of the run. The mark goes R × multiplier
from the end that kicks out. Run = R / tan θ and shrink = R × tan(θ/2). Given a fixed mark
distance, the tool solves θ = asin(R / L). Example: a 3" kick at 30° marks at 6".

### 3-point saddle

The centre bend is 2α and the two side bends are α each (45/22.5 or 60/30). Each half of the saddle
is an offset of height H at angle α:

- Side marks: H / sin α from the centre mark, each way.
- Shrink to the centre: H × tan(α/2). The centre mark goes at (end to centre of the obstruction) +
  this shrink. The total shrink of the pipe is twice that.
- Exact figures: 2.613 × H and 0.199 × H at 45/22.5; 2 × H and 0.268 × H at 60/30.
- Chart figures: 2½ × H and 3/16" per inch at 45/22.5. Klein, IDEAL and Greenlee all print these
  [K][I][G23]. For 60/30, Klein prints 2 × H and 1/4" per inch [K], but IDEAL says to use the 45°
  numbers for both [I]. **VERIFY** this conflict on your own bender.
- The centre bend goes on the bender's centre mark: Klein calls it the rim notch, IDEAL the rim
  notch, Greenlee the "3-bend saddle notch" [K][I][G23]. The outer bends go on the arrow.

Worked example: a 2" obstruction centred 24" from the end, at 45/22.5. The centre mark goes at
24.398" (24 3/8"), and the side marks at 19 3/16" and 29 5/8" (5.226" each way). The chart rule
would give 5" each way. The tool warns about the difference and offers the chart numbers.

### 4-point saddle

An offset up, a straight across the obstruction, and an offset back down. No manufacturer printed a
method for this; trade references describe it as two offsets in series [TG].

- Mark 2 = (end to the near edge) + H × tan(θ/2).
- Mark 1 = mark 2 − H × multiplier.
- Mark 3 = mark 2 + the obstruction width.
- Mark 4 = mark 3 + H × multiplier.
- Total shrink = 2 × H × tan(θ/2).

Example: an obstruction 4" high and 10" wide, at 30°, with its near edge 50" from the end. The
marks go at 43.07", 51.07", 61.07" and 69.07".

### 90° stub-up

- Mark = stub − take-up (deduct). Put the arrow on the mark with the hook toward the free end [K].
  Example: a 10" stub with a 5" take-up marks at 5".
- Cut length with two legs, both measured to the back of the bend = leg 1 + leg 2 − gain.
- Gain, with both legs measured to the back of the bend = r × (2 − π/2) + OD, where r is the
  centreline radius. This follows from developed length = (L₁ − r − OD/2) + (L₂ − r − OD/2) + πr/2.
- The arc of a 90 uses πr/2 ≈ 1.571 r of pipe.
- **No take-up on file** (PVC, or a one-shot shoe with no published deduct): the bend is laid out
  from the radius. Start of bend = stub − r − OD/2, end of bend = start + πr/2. For PVC these are
  the heat marks. The published hand-bender take-ups are not r + OD/2 (for 1/2" EMT, 4.54" against
  the printed 5"), so the hand benders always use the printed take-up.

### Back-to-back 90s

- Mark 1 = stub 1 − take-up (arrow).
- Mark 2, where the back of the second 90 lands = stub 1 + D − gain, with D measured across the
  backs. The more reliable way is to bend the first 90, then measure D from its back. The tool shows
  both.
- Bend 2: turn the bender so the hook faces the other free end, away from the first stub, and put
  the star on the mark [K]. All three brands use the star for this [K][I][G98][G23].
- Cut length with both stubs = stub 1 + D + stub 2 − 2 × gain.
- The tool warns when D < 2 × (r + OD/2), because the two bends would overlap.

### Box and bracket offsets

- **Into a box**: a small offset (default 1/2" / 13 mm at 10°) close to the end that goes into the
  connector. Mark 1 = the straight length needed for the connector (default 1-1/2" / 38 mm), and
  mark 2 = mark 1 + R × multiplier. The defaults are field practice, not a published rule:
  **VERIFY** on scrap.
- **Over a bracket or strut**: an offset into an obstruction, with the rise set to the bracket
  depth plus clearance.

### Rolling offset

- True offset T = √(rise² + roll²). Lay out an offset of T.
- Before bending, roll the pipe φ = atan(roll / rise) from straight up toward the roll side. The end
  view in the diagram shows this.
- Example: rise 6" and roll 8" give T = 10" and φ = 53.1°. At 45° the marks are 14.14" apart.
- No manufacturer source; this is plain geometry (tested).

### Parallel (stacked) offsets

Several conduits make the same offset side by side, in the plane of the bend.

- Pipe 1 is the one on the inside of the first bend (the side the offset moves toward).
- Each pipe further out moves both of its marks C × tan(θ/2) farther from the end, where C is the
  centre-to-centre spacing. Spacing between marks and shrink are the same on every pipe.
- Example: 3 pipes at 2" centres at 30° shift 0.536" (about 9/16") per pipe.
- The tests trace both pipes and check that they stay C apart through the offset.
- Conduits side by side across the bend (not in its plane) need no shift.
- [TG] gives the same adjustment. Which conduit to start from and which way to move the marks is
  derived from the geometry, not taken from a manufacturer.

### Segment (shot) bends

- Length of the bend = r × θ (radians).
- With n shots, each shot is θ/n degrees and the shot marks are r × θ / n apart, each at the middle
  of its space. The first shot is half a space past the start of the bend.
- For a 90 measured to the back: start of bend = stub − r − OD/2.
- Example: a 30" radius 90 on 2" rigid (OD 2.375) with a 48" stub, in 10 shots. The bend starts at
  16.81". Shots are 4.71" apart, the first at 19.17". The bend uses 47.12" of pipe.
- Warnings: radius under the code minimum (Table 7). More than 15° a shot (a rule of thumb for a
  smooth bend; **VERIFY**).
- Mark every shot from the end so rounding doesn't add up.

### Concentric 90s

- Radius of pipe i = inside radius + (i − 1) × C.
- With the pipe ends square across the rack, every bend starts the same distance from the end,
  because all the arcs share one centre.
- Each pipe's bend uses πrᵢ/2 of pipe, split into the same number of shots.
- When the risers end at a common height T (measured from pipe 1's centreline before the bend),
  every riser's straight above the arc is T − inside radius. Cut length = start + πrᵢ/2 + (T − r₁).

### Bends between pull points

The tool adds up the degrees in a run and warns past 360°, the equivalent of four quarter bends.
The CEC rule is **Rule 12-942** (raceways, number of bends) [CSAi]. The NEC equivalents are 358.26
(EMT), 344.26 (RMC) and 352.26 (PVC). Saved bends can be added to the count, and each bend's result
also reports the degrees in that piece. The "hard pull" note above 270° is advice, not code.

## Code references (CEC, CSA C22.1)

Numbers and rule references only, never CSA text.

| what | reference | status |
| --- | --- | --- |
| Max 360° of bends between pull points | Rule 12-942 | listed in the 2021 index [CSAi]; title from an unofficial 2018 copy. **VERIFY** for the 2024 edition |
| Radius of bends, raceways and EMT | Rule 12-924 → Table 7 [CSAi][EIN] | **VERIFY** for 2024 |
| Table 7, minimum radius to the centre of the conduit (mm) | 16: 102, 21: 114, 27: 146, 35: 184, 41: 210, 53: 241, 63: 267, 78: 330, 91: 381, 103: 406 | from the 2003 CSA committee proposal [CSA03], equal to NEC Ch. 9 Table 2 one-shot column. **VERIFY** current values and whether an "other bends" column exists |
| Field bends in rigid PVC | Rule 12-1108 (DB2/ES2 and EB1: 12-1156) [CSAi] | **VERIFY** |
| PVC field-bend radius used here | NEC Ch. 9 Table 2 "other bends" (inches: 4, 5, 6, 8, 10, 12, 15, 18, 21, 24), about 6 × trade size; IPEX says 6 × inside diameter [IPX] | **VERIFY** against 12-1108 |

## Bender profiles

The built-in values are typical published figures. The screen says so next to the bender picker:
*check them against the marks on your own bender, or calibrate it.*

**Hand benders** (Klein, Greenlee Site-Rite, IDEAL):

| shoe | take-up (deduct) | centreline radius |
| --- | --- | --- |
| EMT 16 (1/2") | 5" [K][G23] | 4-3/16" [G23][GC] |
| EMT 21 (3/4"), RMC/IMC 16 | 6" [K][G23] | 5-1/8" [G23][GC] |
| EMT 27 (1"), RMC/IMC 21 | 8" [K][G23] | 6-1/2" [G23][GC] |
| EMT 35 (1-1/4"), RMC/IMC 27 | 11" [K][G23] | 9-5/8" [G23][GC] |

Rigid and IMC share the next EMT shoe up (Klein and Greenlee state this; for IDEAL it is inferred).

**Larger benders** (Greenlee):

- 1818 mechanical: deducts from IM 1101 [G1818], which calls them approximate. Radii from the 2019
  catalogue [GC].
- 555C electric: deducts from IM 1448 [G555], which sets the minimum stub at the deduct + 2". Radii
  from [GC].
- 881CT and 884/885 one-shot hydraulic shoes: radius only [GC]. No deduct is published, so a 90 is
  laid out from the radius.

**Gain** is not published by any of the makers. The tool works it out from the radius and OD (see
above) and labels it as worked out.

**Mark names** feed the step text: Klein calls them arrow, star point and rim notch; IDEAL arrow,
star-point and rim notch; Greenlee arrow, star mark and 3-bend saddle notch [K][I][G23].

**Calibrate my bender** (*My benders* → *Calibrate a bender*, or *Use my own numbers* →
*Calibrate*):

1. Mark a straight piece at a known distance from the end (default 12" / 300 mm). Optionally make a
   second mark farther along (default 30" / 750 mm).
2. Bend a 90 with the first mark on the arrow and the hook toward the end. Check it with a level.
3. Measure the stub (end to the back of the 90). If you made the second mark, also measure from the
   back of the 90 along the other leg to it.
4. Take-up = stub − mark. Gain = stub + leg − second mark.

The result is saved as a `benderProfiles` record and can be made the default for that conduit and
size. Example: marked at 12", the stub measures 17 1/8", and the other leg measures 15 3/8" to a
30" mark. That gives a take-up of 5 1/8" and a gain of 2 1/2".

## PVC heat bending (IPEX Scepter) [IPX]

- Heat to about 127 °C (260 °F) with a flameless heater (electric or infra-red). Never an open
  flame.
- Heat evenly over about 10 × the pipe diameter. Underheating kinks the pipe.
- Cooling with water or cold air makes the pipe spring back, so overbend a few degrees.
- Keep to the minimum radius. The 90 and back-to-back tools mark the start and end of the heat.
- Plugging the ends of large sizes to keep the pipe round is common practice but not in the IPEX
  text: **VERIFY**. Heating times per size: not found.

## Outside diameters (inches, trade sizes 16 to 103)

| type | 16 | 21 | 27 | 35 | 41 | 53 | 63 | 78 | 91 | 103 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EMT (C80.3) | 0.706 | 0.922 | 1.163 | 1.510 | 1.740 | 2.197 | 2.875 | 3.500 | 4.000 | 4.500 |
| RMC (C80.1) and PVC Sch 40 | 0.840 | 1.050 | 1.315 | 1.660 | 1.900 | 2.375 | 2.875 | 3.500 | 4.000 | 4.500 |
| IMC (C80.6) | 0.815 | 1.029 | 1.290 | 1.638 | 1.883 | 2.360 | 2.857 | 3.476 | 3.971 | 4.466 |

Confirmed in [W], [T] and [IPX]. Rigid aluminum (C80.5) is taken as the same as RMC: **VERIFY**.

## What gets saved

`bends` (data contract in `docs/BUILD-PLAN.md`):

- `name`, `jobId?`, `kind`, `conduit { type, tradeSize }`, `benderProfileId?` and `notes`.
- `inputs`: the calculator input in SI, including the bender numbers used (`takeUpM`, `gainM`,
  `radiusM`), `odM`, `chart`, and `form` (what was on the screen, to reopen it).
- `result`: `marks[{ label, atM }]`, `shrinkM`, `developedLengthM` and `warnings[]`. Built-in
  bender ids look like `std:greenlee:EMT:21`.
- `developedLengthM` is the cut length when an overall run or the other leg is given. Otherwise it
  is the pipe used up to the last mark (or through the end of the bend for 90s and segment bends).

Saved bends can be listed and filtered by job (`#/bending/saved?jobId=…`), opened, duplicated,
deleted and printed. Printing (or "Save as PDF" in the print dialog) gives a one-page sheet with the
inputs, both drawings, the marks, warnings and the steps.

`benderProfiles`:

- `name`, `brand`, `model`, `conduitType`, `tradeSize`, `takeUpM`, `gainM`, `backToBackMark`,
  `centreMark`, `isDefault` and `notes`.
- `minRadiusM` holds the shoe's centreline radius, which is the tightest bend it makes.
- Only one profile per conduit type and size is the default.

## VERIFY list

1. **CEC Rule 12-942** (360° between pull points): the number is confirmed in the 2021 index, the
   title only from an unofficial 2018 copy; the 2024 edition was not checked.
2. **CEC Rule 12-924 and Table 7**: the radii come from the 2003 committee proposal. Confirm the
   values, and whether an "other bends" column exists, in C22.1:24.
3. **CEC Rule 12-1108** (PVC field bends) and the PVC radius used: NEC "other bends" / IPEX 6 ×
   inside diameter (IPEX prints "maximum", presumably a typo).
4. **Hand bender radii for Klein and IDEAL**: not published. The tool uses Greenlee's.
5. **Gain**: no maker publishes it. It is computed as r(2 − π/2) + OD.
6. **IDEAL take-ups** other than 3/4" EMT, and IDEAL rigid shoe sharing, are inferred from Klein
   and Greenlee.
7. **60/30 saddle chart numbers**: Klein says 2 and 1/4"; IDEAL says use 2½ and 3/16" for both.
8. **Hook direction** is stated in text only by Klein (stub, back-to-back, offset). For a kick we
   assume the stub practice.
9. **4-point saddle, parallel and rolling offset methods**: no manufacturer source. They are plain
   geometry, checked in the tests.
10. **Box offset defaults** (1/2" at 10°, 1-1/2" straight into the connector): field practice.
11. **Greenlee 1818 deducts** are "approximate". The 1818 EMT 41 radius is not published, so that
    profile has no gain.
12. **One-shot shoes (881CT, 884/885)**: no published deduct. The start of bend from the radius may
    not line up with the shoe's own mark, so calibrate first.
13. **Hydraulic shoes for IMC and rigid aluminum** are not listed. Hand benders for rigid aluminum
    are assumed to be the rigid shoes.
14. **PVC**: heating time per size not found; end plugs are common practice.
15. **Rules of thumb**: under 25 mm from the end is too close for the bender to grip; 15° a shot
    starts to look segmented; past 270° is a hard pull.

## Sources

- [K] Klein Conduit Bender Guide: https://data.kleintools.com/sites/all/product_assets/documents/instructions/klein/ConduitBenderGuide.pdf
- [I] IDEAL Bender Guide ND 1534-4: https://pdf.lowes.com/howtoguides/783250740475_how.pdf
- [G23] Greenlee Site-Rite hand bender use guide (2023): https://cdn.greenlee.com/resources/media?key=f7dfd9ab-9edf-42df-824f-b9d9023a4e2f&languageCode=en&type=document
- [G98] Greenlee IM 1071 (1998): https://cdn.cableorganizer.com/old-images/greenlee/benders/Hand-Bender-Instructions.pdf
- [GC] Greenlee 2019 catalogue, bending pages: https://docs.galco.com/techdoc/glee/2019_greenlee_p149-185_cp.pdf
- [G1818] Greenlee 1818 manual IM 1101: https://objects.eanixter.com/PD550344.PDF
- [G555] Greenlee 555C manual IM 1448 (2025): https://cdn.greenlee.com/resources/media?key=c621b4f4-74d7-4f13-9e55-148f75359848&languageCode=en&type=document
- [CSAi] CSA C22.1:21 index: https://www.csagroup.org/store-resources/documents/codes-and-standards/CSA_C22.1_21_Index.pdf
- [CSA03] CSA Part I Subject 2914 (2003): https://www.electrical-contractor.net/Forum/International/Subject2914.PDF
- [EIN] Electrical Industry News, Guide to the CEC Part I, instalment 43: https://electricalindustry.ca/latest-articles/4865-guide-to-the-canadian-electrical-code-part-i-instalment-43/
- [IPX] IPEX Canadian electrical catalogue: https://ipexna.com/wp-content/uploads/2026/03/catalogue-en-ipex-electrical-products.pdf
- [W] Wheatland EMT and conduit brochure: https://www.wheatland.com/wp-content/uploads/2018/03/EMT-and-Conduit-Brochure.pdf
- [T] Outside diameters: https://www.toolsboltsnbits.com/TBNB_Outside_Diameter.pdf
- [TG] Conduit bending guide: https://www.toolgrit.com/guides/conduit-bending-guide

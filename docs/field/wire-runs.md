# Wire runs

Route: `#/wireruns` (Work group, permission `drawings`). Code:

| file | what |
| --- | --- |
| `electrical-app/js/modules/wireruns.js` | list, run editor, plan-trace sheet, AR flow, photos, exports, add to estimate |
| `electrical-app/js/lib/wireruns.js` | totals, allowances, rolls, price-book units, estimate lines, CSV, the PDF report (pure, tested) |
| `electrical-app/js/lib/ar-measure.js` | AR tape: native ARKit plugin, WebXR, or "not available" |
| `electrical-app/js/lib/pdf.js` | small PDF writer with no dependencies (Helvetica text, lines, rectangles, JPEG photos) |
| `electrical-app/css/wireruns.css` | styles, tokens only |
| `electrical-app/tests/wireruns.test.mjs` | tests: `node --test electrical-app/tests/*.test.mjs` |

## What it does

A wire run is a named route for one cable, or for the conductors in one conduit, for example
"Kitchen feed" on job J-1004. You build it from segments, add allowances, list the conductors,
and the screen works out how much wire to pull and which rolls to buy. You can then download it
as a PDF (`Kitchen feed - J-1004.pdf`), print it, export a CSV, or add the wire to a draft estimate.

There are three ways to add a segment:

1. **AR tape.** Point the phone at the wall or conduit and tap to drop a point at each end and at
   every bend. You get one segment for the whole path, or one per leg if you tick the box.
2. **Trace on a plan.** Pick a drawing, tap points along the route on it, then press Done. The length
   comes from the drawing scale (`drawings.scale`, px per foot). If the drawing has no scale, or the
   imported plan doesn't match it, use **Set scale**: tap both ends of a known dimension and type
   its length. That scale applies to this trace only and is written in the segment note. The drawing
   itself is not changed. **Straight** snaps each leg to horizontal or vertical.
3. **Type a length.** Imperial users can type `25` (feet), `25' 6"`, `306"` or `7.6 m`. Metric users
   can type `7.6` (metres), `7600 mm` or `25'`. Box makeup takes bare inches or millimetres.

Phone-motion-only measuring (moving the phone along the wall and integrating the accelerometer)
is deliberately not offered. Accelerometer drift makes it wrong within seconds.

## How the totals work

All lengths are stored in metres and shown in the user's units (`js/lib/units.js`).

```
run length     = sum of segments
drops          = sum of (count x length each)        e.g. 4 receptacles x 1.2 m
box makeup     = boxes x makeup per box               default 300 mm per box
panel makeup   = one allowance at the panel           default 0.9 m (3 ft)
waste          = (run + drops + boxes + panel) x waste %   default 10 %
per conductor  = run + drops + boxes + panel + waste
conductor line = count x per conductor
conduit        = (run + drops) x (1 + waste %), shown as 3.05 m (10 ft) sticks
```

Box and panel makeup only count once the run has some length, so a new run totals zero.

**Box makeup default.** CEC Rule 12-3000(6) requires at least 150 mm of free conductor at each
outlet for joints and connections. A run that passes through a box has two cable ends in it, so the
default is 2 x 150 mm = 300 mm per box. Change it per run. *VERIFY*: the rule number and the 150 mm
value were checked against an earlier edition only. Confirm them in CSA C22.1:24 and any provincial
amendment.

**Rolls.** NMD90 is sold in 75 m, 150 m and 300 m coils. The suggestion covers the length with
the least left over, then the fewest coils (for example 160 m becomes 150 m + 75 m, and 700 m
becomes 2 x 300 m + 150 m). Imperial users see the feet next to each coil: 75 m (246 ft),
150 m (492 ft), 300 m (984 ft). Sizes 8 AWG and up show "cut to length", because they are
usually cut from a reel.

## Add to estimate

**Add to estimate** opens a sheet. Pick a draft estimate for the run's job, or create a new one.
A new estimate uses `store.nextNumber('estimate')` and the same fields as `estimates.js`
(`labourRateCents` and `taxPct` from settings, `markupPct` 0, valid for 30 days). Each conductor
becomes one line in the estimates line shape
(`{ itemId, description, qty, unitCents, labourHours, kind: 'material' }`):

- If the conductor has a price-book item, the quantity is the conductor total in the item's unit,
  rounded up.
- Otherwise the conductor becomes a custom material line at $0, in metres or feet, for the office
  to price.

The quantity depends on the item's `unit` field:

| unit on the item | quantity |
| --- | --- |
| `m`, `metre` | metres |
| `ft`, `feet`, `lf` | feet (seed data uses `ft` for NM-B) |
| `C`, `100 ft` / `M`, `MFT`, `1000 ft` | hundreds / thousands of feet |
| `100 m`, `km` | hundreds / thousands of metres |
| `roll`, `coil`, `spool`, `reel` | coils, using the length in the item name (`NMD90 14/2, 150 m`) |
| `75 m roll` (a length in the unit) | coils of that length |
| `stick` | sticks, using the length in the name (`10 ft stick`) or 3.05 m |
| `ea` or anything else | not a length: added as a custom line, with a warning |

For conduit runs the sheet also offers a conduit line, matched to the price book by type and
trade size (for example EMT 21 matches `3/4" EMT, 10 ft stick`).

## Exports

- **PDF**: built on the device by `js/lib/pdf.js` with no library and no network. Letter size,
  standard Helvetica (WinAnsi, so accents and `× · — ’` print, other scripts show `?`). It has the
  company letterhead, run name, job, client, site, date, key totals in both unit systems, the
  segments, allowances and conductor tables, suggested rolls, notes, cautions and photos (two per
  row). Page footer: company, run and page x of y.
- **Share PDF** shows up where the browser can share files (iOS Safari, Android Chrome).
- **Print** opens the browser print dialog with a print-only copy of the report.
- **CSV**: every number in metres plus the display length. Cells that start with `=`, `+` or `@`
  get a leading `'` so spreadsheets don't run them as formulas.

## Photos

Up to 12 per run. Each is resized on the device to at most 1600 px on the long side and saved as
a JPEG of about 400 KB or less (quality steps down, then size). Photos are stored in the run as
`{ id, dataUrl, caption, takenAt, width, height }`. An AR snapshot from the native plugin can be
added the same way.

## AR accuracy

AR measuring tracks the camera against features it sees in the room. It is good for estimating
wire and not good enough for cutting to the millimetre.

- Typical error: about 1 to 2 % of the length in good conditions (roughly 2 cm over 1 m, 10 cm
  over 5 m), worse on long single legs. LiDAR iPhones and iPads (Pro models) do better on plain
  walls. *VERIFY* these numbers on the phones the crew uses: measure a known length, such as a
  1220 mm (4 ft) sheet of drywall, and compare.
- Errors grow with distance and add up over many legs. The 10 % waste default covers this for
  estimating.
- The report notes which segments came from the AR tape and says to check critical lengths with
  a tape.

Tips (also shown before the first AR session):

- Use good, even light. Tracking drops in dim rooms and on shiny surfaces.
- Plain white drywall is the hardest surface. Put a few strips of painter's tape on it, or aim at
  edges, boxes and studs.
- Move slowly and keep the phone 30 cm to 1 m (1 to 3 ft) from the surface.
- Measure in short legs (under about 3 m / 10 ft) with a point at every bend.
- Check a known length first.

## Where the AR tape works

`getArSupport()` picks the first back end that works:

1. **Native (iOS app).** `window.Capacitor.Plugins.FishtapeMeasure` exists and `isAvailable()`
   doesn't return `{ available: false }`.
2. **WebXR.** `navigator.xr.isSessionSupported('immersive-ar')` is true. In practice that means
   Chrome on an Android phone with ARCore (Google Play Services for AR). The page must be served
   over https. The session asks for `hit-test` (required) and `dom-overlay` (optional, for the
   buttons). A reticle sits on the surface under the screen centre. Tap the screen or **Add point**
   to drop a point, **Undo** removes the last one, and **Done** finishes. If the browser ends the
   session (for example with the back button) after two or more points, the path is kept and the
   app asks before adding it. Rendering is a small WebGL 1 renderer in `ar-measure.js`, with
   camera-facing ribbons for the lines, square markers for the points and a ring for the reticle.
   No library is used.
3. **None.** iPhone and iPad Safari have no WebXR AR, and desktop browsers have no AR either. The
   app explains this and offers the plan trace or a typed length.

## Native plugin contract (`FishtapeMeasure`, iOS, Phase 1)

The JS side already uses this contract (see `docs/BUILD-PLAN.md`):

```ts
isAvailable(): Promise<{ available: boolean }>
measurePath(options: { units: 'metric' | 'imperial' }): Promise<{
  totalM: number,                       // metres, sum of the legs
  segments: { lengthM: number }[],      // one per leg, in order
  points: { x: number, y: number, z: number }[],   // metres, ARKit world space, segments.length + 1 of them
  snapshot?: string,                    // 'data:image/jpeg;base64,...' (optional, keep it under ~400 KB)
}>
// rejects with 'cancelled' (string, or an error whose message/code is 'cancelled') when the user backs out
```

Notes for whoever builds it on the Mac:

- Show a full-screen `ARSCNView` or `ARView` with the ARKit coaching overlay. Raycast from the screen
  centre to estimated or existing planes (`.estimatedPlane`, any alignment). On LiDAR devices, enable
  scene reconstruction or scene depth for better hits on plain walls.
- Draw the points and lines in the scene, and show the running total and the live leg in `units`.
  Provide Undo, Done and Cancel.
- The JS side tolerates a missing `totalM` or `segments` and rebuilds them from `points`. It needs
  either two or more points or a positive `totalM`.
- Return lengths in metres whatever `units` is. `units` only sets the labels drawn in the AR view.

## VERIFY

- CEC Rule 12-3000(6), 150 mm free conductor at each outlet: confirm the number and the rule
  reference in C22.1:24 and provincial amendments (`CEC_FREE_CONDUCTOR_M` in `js/lib/wireruns.js`).
- NMD90 coil sizes of 75, 150 and 300 m: 75 m and 150 m are stock for 14 to 10 AWG in supplier
  listings, but 300 m exists only for some sizes. Check with the supplier (`ROLL_SIZES_M`).
- 8 AWG and up treated as cut to length (`isCutToLength`): check against how the shop buys it.
- Conduit stick length of 3.05 m (10 ft) when the price-book item doesn't say (`STICK_M`).
- Panel makeup default of 0.9 m (3 ft): a shop rule of thumb, not a code value.
- AR typical error of about 2 % (`AR_TYPICAL_ERROR_PCT`): measure on the crew's phones.

## Known limits

- The WebXR tape was tested in headless Chrome against a scripted fake XR session (overlay, WebGL
  set-up, points, undo, done, cancel). It has not been run on a real ARCore phone yet. The native
  path was tested with a mocked plugin.
- In the Capacitor iOS app, `<a download>` with a blob URL may not save files. The app will need the
  Filesystem or Share plugin for **Download PDF**. **Share PDF** (Web Share) may work as is.
- Photos are stored inline as data URLs. They are fine for IndexedDB, but when sync arrives they
  should move to object storage.
- The plan trace draws the drawing's underlay, strokes, symbols (as circles) and text itself, so the
  canvas module stays untouched. It is a simplified view, not the full editor rendering.

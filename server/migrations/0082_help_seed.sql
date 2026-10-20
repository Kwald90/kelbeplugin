-- 0082 Help center starter articles (published). HQ edits them from here on (HQ > Help center).
-- Written for the app as built on 2026-10-19; links are in-app routes.

INSERT INTO help_categories (id, name, description, position) VALUES
  ('getting-started', $md$Getting started$md$, $md$First steps in Fishtape$md$, 0),
  ('plans-drawings', $md$Plans and drawings$md$, $md$Plan sets, scale, takeoff and CEC checks$md$, 10),
  ('field-tools', $md$Field tools$md$, $md$Wire runs, AR measuring and pipe bending$md$, 20),
  ('money', $md$Estimates, invoices and tax$md$, $md$Quotes, invoices and GST/HST/PST$md$, 30),
  ('team', $md$Your team$md$, $md$Crew, roles and shared-iPad PIN mode$md$, 40),
  ('integrations', $md$Connections$md$, $md$Stripe, email and SMS$md$, 50);

INSERT INTO help_articles (slug, title, summary, body, category_id, status, position, published_at) VALUES
  ('getting-started', $md$Getting started with Fishtape$md$, $md$Start your trial, turn on two-step sign-in, pick your units and fill in your company details so estimates, invoices and field tools are set up right.$md$, $md$This walks you through your first half hour in Fishtape. Do it once, from a computer or an iPad, and the rest of your crew gets a clean start.

## 1. Start your trial

1. Open the sign-up page on the Fishtape website.
2. Enter your company name, province or territory, your name, your work email and a password.
3. Pick a plan. Pro is picked for you. You can change plans later in [Billing](#/billing).
4. Stripe's checkout page takes a small deposit to confirm your card. It comes off your first invoice.

The trial is 14 days and includes every feature of the plan you picked. Cancel before it ends and the plan is never charged.

Want to look around first? On the sign-in screen, press **Try the demo on this device**. The demo uses sample data that stays on that device and never syncs.

## 2. Confirm your email and turn on two-step sign-in

1. Open the email from Fishtape and tap the link.
2. Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password or similar).
3. Scan the code on screen, or type the key by hand, then enter the 6-digit code.
4. Save your recovery codes, then press **I saved my recovery codes**. They are shown once.

Two-step sign-in is required for owners and admins. If you lose your phone, a recovery code gets you back in. Each code works once.

## 3. Pick your units

The first time you open the app on a device, it asks **How do you measure?** Pick **Metric** or **Imperial**. Drawings, wire runs, bends and calculators all show lengths your way. Each person picks their own. Stored values are always metric, so a metric user and an imperial user can work on the same job.

You can change your units later in [Settings](#/settings) under **Your units**, or on your [Account](#/account) page.

## 4. Fill in your company

Open [Settings](#/settings) and work down the cards:

- **Company**: name, phone, email, address, **Province / territory**, contractor licence number, GST/HST number and PST/RST number. The province sets code amendments, the permit authority and sales tax. Press **Save company**.
- **Code book and units**: CEC 2024 is the default. NEC 2023 is there if you need it.
- **Sales tax**: see the GST, HST and PST article.
- **Defaults**: your labour rate and material markup for new estimates and invoices.
- **Document numbering**: the next job, estimate and invoice number, if you are moving over from another system.

## 5. Find your way around

The rail on the left groups screens into Home, Sales, Work, Money, People, Field and Admin. Your role decides what you see. An apprentice sees jobs, drawings, time, SOPs and calculators. An owner sees everything.

If a screen is part of a higher plan, it shows a lock and the plan that includes it. Drawings, panel schedules and inventory are in Pro. The AI assistant is in Business. If you move to a lower plan, nothing is deleted. You can still read everything.

## Working without signal

Field tools work offline: time clock, drawings, calculators, bending, wire runs, SOPs and today's jobs. Every change is saved on the device first and sent to the server when the connection is back. When you are offline, the sync status shows how many changes are waiting.

## Next steps

- Import a PDF plan set and set its scale.
- Add your crew and set up a shared iPad.
- Connect Stripe, email and texts in [Integrations](#/integrations).
$md$, 'getting-started', 'published', 0, now()),
  ('importing-a-pdf-plan-set', $md$Importing a PDF plan set$md$, $md$Turn a multi-page PDF of the plans into one drawing per sheet, linked to a job, ready to scale, mark up and count into an estimate.$md$, $md$Fishtape imports the PDF the designer or GC sends you. Each page you pick becomes its own drawing, called a sheet. The sheets stay grouped as one plan set, so you can move between E1.0, E1.1 and E2.0 the way you would flip through the paper set.

Drawings are part of the **Pro** plan and higher.

## Import the set

1. Open [Plans & drawings](#/drawings).
2. Press **Import plan set (PDF)** and pick the file.
3. If the PDF has one page, it opens straight away as a drawing.
4. If it has several pages, the page picker opens. Every page starts selected.
5. Pick the **Job** at the top so the sheets file under the right job.
6. Choose the pages you want:
   - Tap a page to leave it out or put it back.
   - **Only this** under a page picks just that one.
   - **Select all** and **Clear** do what they say.
   - Type a range such as `2-9, 12` and press **Use range**. You can also type the sheet numbers printed in the PDF, like `E1.0-E1.4`, or `all`.
7. Press **Import**.

A progress bar shows each sheet as it comes in. If you press **Cancel**, the sheets already imported stay. When an import stops early or a page can't be read, the summary lists what was skipped and the page range to import later.

## Find your sheets

In the gallery, a plan set shows as one card marked **Plan set** with the sheet count. The card also shows how many sheets have a scale, for example **3/12 scaled**.

- Tap the card to open the first sheet.
- Press **Show 12 sheets** (the number matches your set) to see every sheet.
- The options button on the card lets you **Open the first sheet**, **Rename set** or **Delete…** (every sheet, or one you pick).

Inside a sheet, the sheet bar at the top has back and next buttons and the sheet name. Tap the name to see every sheet and which ones still say **No scale yet**. You can also use **More > Sheets in this set**.

## Add a PDF or photo to a drawing you already have

Open the drawing and press **More > Import plan**. You can pick an image or a PDF. A PDF with several pages becomes a plan set: the drawing you are in gets the first page, and each other page becomes a new drawing with the same job, paper and layers.

## Good to know

- The PDF reader is built into the app, so imports work without a connection.
- Each page is saved as an image up to 4096 pixels on its long side. A very dense page is saved at lower quality so it fits. If a page is still too big, you see "This page is too detailed to import, even at low quality."
- On an older iPad, a big set can be slow. Import it in a few ranges, such as `1-10` then `11-20`.
- Each sheet starts with no scale. Set it before you measure, trace wire runs or auto-place boxes. See the article on setting the scale.

## From sheets to a quote

When you have placed symbols, press **More > Takeoff** on any sheet. **Estimate this sheet** prices that sheet only. **Estimate whole set** counts the symbols on every sheet together and opens a new draft estimate.
$md$, 'plans-drawings', 'published', 10, now()),
  ('setting-the-scale', $md$Setting the scale on a drawing$md$, $md$Measure one known length on the plan so Fishtape can read real distances for wire lengths, room sizes, box placement and the code check.$md$, $md$A PDF page has no idea how big the building is. You tell Fishtape by dragging along one length you know and typing its real size. After that, the **Measure** tool, wire lengths, room sizes, auto-placed boxes and the code check all use real distances.

Drawings are part of the **Pro** plan and higher.

## Pick a good length

Use the longest dimension you trust on that sheet:

- a dimension string with a number on it, such as an overall wall length
- the spacing between two grid lines
- a standard item drawn to scale, such as a door opening, only if nothing better is there

A long line gives a better scale than a short one. A small error on a 3 ft line is a big error across a 60 ft building.

Don't rely on the scale printed in the title block. A PDF may have been resized when it was printed or saved, so 1/4" = 1'-0" on paper may not be true on screen. Measuring a known length avoids that.

## Set the scale

1. Open the sheet in [Plans & drawings](#/drawings).
2. Press **More > Set scale**. Or pick the **Measure** tool (key `M`) and press the **Set scale** chip.
3. Zoom in and drag from one end of your known length to the other.
4. Type the real length in the box that asks "How long is that line in real life?"
5. Press **Set scale**. A message confirms the new scale.

What you can type:

| You use | Type | Read as |
| --- | --- | --- |
| Imperial | `12' 6"` | 12 ft 6 in |
| Imperial | `25` | 25 feet |
| Metric | `3.8 m` or `3800 mm` | 3.8 metres |
| Metric | `3.8` | 3.8 metres |
| Metric | `3800` | 3800 mm (a bare number over 30 is read as millimetres) |

If Fishtape can't read what you typed, it says "Could not read that length" and nothing changes.

## Use the same scale on other sheets

If the sheet is part of a plan set, Fishtape asks **Same scale on the other sheets?** right after you set it. The buttons show how many sheets each choice touches, for example:

- **Use on all 11** gives the scale to every other sheet.
- **Only the 4 with no scale** skips sheets that already have their own.
- **All 11, replacing theirs** overwrites every other sheet.
- **Not now** leaves the other sheets alone.

Fishtape adjusts for sheets that were imported at a different page size. Site plans, enlarged plans and detail sheets are usually drawn at a different scale. Give those their own.

## Check it

Pick the **Measure** tool and drag across a second known dimension. If it reads close to the printed number, you are good. If it is off, set the scale again on a longer line.

The sheet list shows **Scale set** or **No scale yet** for each sheet, and the plan set card shows how many are scaled.

## Typing the number directly

Tap the drawing's name to open **Drawing details**. The field **Scale (canvas units per foot)** holds the raw number. This is handy for copying a scale you already know works, but measuring is easier for most people.

## Scale and wire runs

When you trace a wire run on a plan, you can set a scale for that trace only. It is noted on the segment and does not change the drawing.
$md$, 'plans-drawings', 'published', 20, now()),
  ('box-auto-placement-and-cec-checks', $md$Auto-placing boxes and checking them against the CEC$md$, $md$Draw a room, let Fishtape propose receptacles, switches, lights and alarms, then run the code check and fix findings with one tap.$md$, $md$Draw a room on a plan and Fishtape proposes receptacles, switches, lights and alarms. The code check then compares the layout with the Canadian Electrical Code (CSA C22.1:24) and flags what looks short.

This is a layout and estimating aid. It does not replace the code book, your inspector or the authority having jurisdiction. Provinces amend the code, and Ontario amendments are not applied. Rules marked **VERIFY** in the app have not been confirmed against the 2024 text, so confirm them with your inspection authority before relying on them.

Rooms, auto-place and the code check are part of the **Pro** plan and higher.

## 1. Set the scale

Every distance the check measures comes from the drawing scale. Set it first with **More > Set scale**.

## 2. Draw the room

1. Pick the **Room** tool (key `O`).
2. Choose **Rectangle** and drag corner to corner, or **Polygon** and tap each corner, then tap the first corner (or **Close room**) to finish.
3. Name the room and pick its type: bedroom, living, kitchen, dining, bathroom, hallway, laundry, garage, basement, outdoor or other.

Trace the inside face of the walls.

## 3. Mark doors, windows and fixtures

Select the room and press **Add door, window…**. Pick a kind, then tap a wall. Drag along the wall to set the width. Press **Done** when you have added them all.

Tap anything you added to edit it: hinge side, swing, whether a door is an entry (it gets a switch), a floor-length window, or an island's size. Mark counters, sinks, appliances, tubs and showers too. They break up usable wall and set GFCI distances.

## 4. Auto-place

Press **Auto-place** on the room bar, or **More > Auto-place boxes in every room**. Proposals appear as dashed ghosts. Tap one to see why it is there and which rule placed it. Drag it to nudge it.

Then press **Accept picked**, **Accept all**, **Discard picked** or **Discard all**. Accepted boxes become normal symbols, so the takeoff counts them. Auto-place only fills gaps. It leaves your own symbols where they are.

## 5. Run the code check

Press **Code check (CEC)**. Findings show as numbered markers on the plan and in a list:

- **Must fix**: likely a code problem.
- **Check**: worth a look.
- **Note**: for your information.

Tap a finding to zoom to it. Some have a one-tap fix: **Make GFCI**, **Mark AFCI**, **Mark TR** or **Mark WP cover**. Tick **Live** to re-check after every change, or press **Re-check**.

## What it checks, briefly

| Area | Reference | Status |
| --- | --- | --- |
| Wall receptacle spacing | CEC 26-722 a), c) | confirmed |
| Kitchen counters, island, fridge, gas range | CEC 26-722 d) | confirmed |
| Hallway receptacles | CEC 26-722 g) | VERIFY (rule letter) |
| GFCI near sinks, tubs and showers | CEC 26-704 1) | VERIFY (subrule) |
| Tamper-resistant receptacles | CEC 26-706 | confirmed |
| AFCI on receptacle circuits | CEC 26-658 | confirmed |
| Bathroom receptacle near the basin | CEC 26-720 f) | VERIFY |
| Garage and outdoor receptacles | CEC 26-724 | VERIFY |
| Smoke and CO alarms, switched lighting | National Building Code 9.10, 9.32, 9.34 | VERIFY (building code) |

The check keeps things simple. A receptacle in the next room doesn't count for this one, and hallway reach uses straight lines. When in doubt, it asks for one more box.

## Settings

**More > Placement & check settings** sets mounting heights, switch distance from the jamb, which alarms to place and whether the house has a fuel-burning appliance or attached garage (for CO alarms). Save them for this drawing or as the company default. Company defaults are also in [Settings](#/settings) under **Box placement**.

## Into the estimate

**More > Takeoff** counts the accepted boxes. GFCI, WP and AFCI marks add the matching GFCI receptacle, in-use cover or AFCI breaker.
$md$, 'plans-drawings', 'published', 30, now()),
  ('wire-runs-and-ar-measuring', $md$Wire runs and AR measuring$md$, $md$Measure a cable or conduit run with the AR tape, a plan trace or a typed length, add allowances, and get the wire to pull, rolls to buy and a PDF.$md$, $md$A wire run is a named route for one cable, or the conductors in one conduit, such as "Kitchen feed". You add the lengths and allowances, and Fishtape works out the wire to pull and the rolls to buy.

Wire runs are in every plan. Tracing a run on a drawing needs the **Pro** plan, because drawings are part of Pro.

## Start a run

1. Open [Wire runs](#/wireruns) and press **New run**.
2. Fill in **Details**: run name, wiring method (cable or conduit), job, location, and for conduit the type and trade size.

## Add segments

Under **Segments** you have three buttons.

**AR tape.** Point your phone at the wall or conduit. Tap to drop a point at each end and at every bend. **Undo** removes the last point and **Done** adds the run. If you dropped several points, tick **Add each leg as its own segment** to keep the legs separate.

**Trace on a plan.** Pick a drawing, tap points along the route and press **Done**. **Straight** snaps each leg to horizontal or vertical. Lengths come from the drawing scale. If the drawing has no scale, press **Set scale**, tap both ends of a known length and type it. That scale applies to this trace only.

**Type a length.** Imperial: `25` (feet), `25' 6"`, `306"` or `7.6 m`. Metric: `7.6` (metres), `7600 mm` or `25'`.

## Where the AR tape works

- **The Fishtape iOS app** on iPhone and iPad (Apple ARKit).
- **Chrome on an Android phone** that supports ARCore (Google Play Services for AR).

Safari on iPhone and iPad has no AR for websites, and desktop browsers have none. The run screen shows **AR ready (ARKit)**, **AR ready (WebXR)** or **No AR on this device**.

## How accurate is AR?

AR is close enough for estimating wire. Use a tape for anything you cut. Expect about 1 to 2% error in good conditions, more on long single legs. Check this on your own phones: measure a known length, such as a 4 ft (1220 mm) sheet of drywall, and compare.

For better readings:

- Use good, even light.
- Plain white drywall is hardest. Stick on a few strips of painter's tape, or aim at edges, boxes and studs.
- Move slowly and keep the phone 1 to 3 ft (30 cm to 1 m) from the surface.
- Measure in short legs, under about 10 ft (3 m), with a point at every bend.

## Allowances

- **Drops**: down the wall to each box, for example 4 receptacles at 1.2 m each.
- **Boxes** and **Makeup per box**: the default is 300 mm per box, two cable ends at 150 mm each, based on CEC Rule 12-3000(6). That rule number and value were checked against an earlier edition only. Confirm them with your inspection authority.
- **Panel makeup**: 0.9 m (3 ft) by default. This is a shop rule of thumb.
- **Waste percent**: 10% by default. It covers offsets, framing and measuring error.

## Conductors and rolls

Add each cable or conductor under **Cable and conductors** (or **Conductors** for conduit). Link it to a price-book item if you have one. **Totals** shows the run length, wire per conductor and suggested NMD90 coils (75, 150 and 300 m). Sizes 8 AWG and up show "Cut to length". Check coil sizes with your supplier.

## Photos, exports and the estimate

- **Add photos**: up to 12 per run.
- **Download PDF**, **Share PDF** (where your device allows it), **Print** and **CSV**.
- **Add to estimate** puts the wire on a draft estimate for the run's job, priced from the price book. Wire with no price-book item goes on as a custom line for the office to price.
$md$, 'field-tools', 'published', 40, now()),
  ('pipe-bending', $md$Pipe bending marks and diagrams$md$, $md$Get marks, shrink and a to-scale drawing for offsets, kicks, saddles, 90s and more, calibrate your own bender, and save bends to a job.$md$, $md$The bending tool tells you where to mark the pipe, draws it bent to scale and lists the steps. It is in every plan and works offline.

## Pick the bend

Open [Pipe bending](#/bending). The tabs across the top are:

- **Offset**, **Kick**, **3-point saddle**, **4-point saddle**
- **90° stub**, **Back-to-back**, **Box / bracket**
- **Rolling offset**, **Parallel offsets**, **Segment bend**, **Concentric 90s**
- **360° check**, which adds up the degrees between pull points

## Set up the pipe

1. Pick the **Conduit** type (EMT, rigid, IMC, PVC or aluminum) and **Trade size**.
2. Pick the **Bender**. The built-in values are typical published figures for Klein, Greenlee and IDEAL. Check them against the marks on your own bender, or calibrate it (below).
3. Fill in the measurements for the bend.

Type lengths the way you say them: `12' 3 5/8"`, `30 1/2`, `450mm` or `1.2 m`. A bare number means inches in imperial and millimetres in metric. Under each box, Fishtape shows how it read the number, so you catch a typo before you bend.

## Read the result

- **Marks** are measured from the end of the pipe, with the distance from the last mark beside each one. Imperial marks round to 1/16". Metric marks round to the millimetre. The gaps between marks are worked out from the rounded marks, so they add up on your tape.
- **Bent, to scale** shows the finished pipe.
- **How to bend it** lists the steps, using your bender's mark names (arrow, star, rim notch or saddle notch).
- Warnings show up when something won't work, such as a mark that falls off the pipe or two 90s that would overlap.

Example: a 6" offset at 30° puts the marks 12" apart with about 1 5/8" of shrink. With the obstruction 36" from the end, the marks go at 25 5/8" and 37 5/8".

## Chart numbers

By default Fishtape uses exact trigonometry. Tick **Chart numbers** to use the rounded figures printed on hand benders instead (6, 2.6, 2, 1.4 and 1.2 for offsets, 2 1/2 for a 45° saddle). Your marks then match the chart on your bender.

## Calibrate your bender

Printed take-ups are close, but every shoe is a little different.

1. Open **My benders**, then **Calibrate a bender**.
2. Mark a straight piece at a known distance from the end. For gain, make a second mark farther along.
3. Put the first mark on the arrow, hook toward the end, and bend a 90. Check it with a level.
4. Measure from the end to the back of the 90, and from the back of the 90 to the second mark.
5. Press **Save bender**. Tick **Use this bender by default for this pipe** if you want it picked every time.

## PVC

For PVC, the 90 and back-to-back tools mark where to start and stop the heat. Use a flameless heater, never an open flame. Heat evenly and overbend a few degrees, because the pipe springs back as it cools.

## Save and print

Press **Save**, name the bend and pick the job. **Saved bends** lists every bend, newest first, and you can filter by job. Each one has buttons to print, duplicate or delete it. **Print** gives a one-page sheet with the inputs, diagrams, marks and steps.

## Code limits

The tool warns past 360° of bends between pull points (CEC Rule 12-942) and when a bend radius is under the minimum in CEC Table 7. Both references, the Table 7 radii and the PVC bend radius are marked **VERIFY**: they were not confirmed against the 2024 edition. Check them with your inspection authority.
$md$, 'field-tools', 'published', 50, now()),
  ('estimates-to-invoices', $md$From estimate to invoice$md$, $md$Build an estimate from the price book or a drawing takeoff, mark it accepted, turn it into an invoice, record payments and send a pay link.$md$, $md$Estimates and invoices are in every plan. Paying online and emailing documents need the **Pro** plan and a connected account. The AI assistant is in **Business**.

## Start an estimate

You can start one from several places:

- [Estimates](#/estimates), then **New estimate**.
- A drawing: **More > Takeoff > Create estimate** counts the symbols and adds a line for each.
- A wire run: **Add to estimate** adds the wire.
- A job, lead or client, so the client and title fill in for you.

Each new estimate gets the next number (E-####), your default labour rate and sales tax from [Settings](#/settings), and is valid for 30 days.

## Fill it in

1. At the top, set the **Title**, **Client**, **Job** and **Valid until** date. Change the labour rate or **Materials markup %** for this estimate if you need to.
2. Check the **Tax province** (where the work is done) and **Tax treatment**.
3. Under **Lines**, add work with **Price book**, **Custom line** or **Labour**.
4. Add **Notes shown on the estimate**, such as exclusions or payment terms.

The **Totals** panel updates as you go. Takeoff lines with no matching price-book item come in at zero and say "(no price book item)". Price them before you send. The price book itself lives in [Inventory](#/inventory), which is part of Pro.

## Send it

Press **Print / PDF** to see the estimate as your customer will. From there you can print or save a PDF. If email is connected, an **Email** button sends it from your own address. Emailing a draft marks it sent.

If you send it some other way, press **Mark sent** so the list shows it as awaiting an answer.

## When the customer says yes

Press **Accepted**. Fishtape asks what's next:

- **Create job** makes a job from the estimate (or **Open job** if it already has one).
- **Create invoice** starts an invoice from it.
- **Later** leaves it for now.

If the customer says no, press **Declined**. **Back to draft** reopens an estimate for changes.

## The invoice

An invoice made from an estimate copies the client, job, lines and notes. A materials markup becomes its own line. Tax is worked out again for the invoice's issue date, so a rate change between quote and invoice is picked up. The due date starts at 14 days.

You can also start an invoice from a job. If the job has approved change orders that haven't been billed, Fishtape asks whether to add them.

On the invoice:

- **Mark sent** when it goes out.
- **Record payment**: enter the amount, date, method (e-transfer, cheque, card, cash or transfer) and a reference. The status changes to partial or paid on its own.
- **Void** cancels it and makes it read-only. **Restore** brings it back.

## Online payment

With Stripe connected, press **Pay online** on the invoice. You get a link your customer opens to pay by card. The link is printed on the invoice, always asks for the balance owing, and the payment is recorded on the invoice when it comes in. See the article on connecting Stripe, email and SMS.

## Let the assistant draft it

On the **Business** plan, with your Anthropic key connected in [Integrations](#/integrations), **Ask Fishtape** can draft estimate lines or an invoice from a job. The assistant drafts and a person approves: nothing is saved until you press **Create draft estimate** or **Create draft invoice**, and the result is always a draft. Sending stays your job.
$md$, 'money', 'published', 60, now()),
  ('gst-hst-pst-setup', $md$Setting up GST, HST and PST$md$, $md$Set your province, tax numbers and default tax treatment so new estimates and invoices charge the right GST, HST, PST or RST.$md$, $md$Fishtape knows the GST, HST and provincial sales tax rates for every province and territory, and the date each rate started. You pick your province and how tax applies to your work. Every new estimate and invoice then gets the right taxes.

> Sales tax on contracting work is not simple. Whether PST or RST applies can depend on the province, on whether the work becomes part of the building, and on the customer. Fishtape's treatments are presets to start from. Confirm your set-up with your accountant.

## 1. Company details

Open [Settings](#/settings) and find the **Company** card.

1. Set **Province / territory**. This is your default tax province.
2. Enter your **GST/HST registration no.** in the form `123456789 RT0001`. It prints on every estimate and invoice. The CRA requires it on invoices of 100 dollars or more for your customer to claim input tax credits.
3. Enter your **PST / RST no.** if you have one: BC PST number, Saskatchewan vendor's licence or Manitoba RST number.
4. Press **Save company**.

## 2. The Sales tax card

1. Under **Rates**, keep your province's rates (recommended), or pick **Custom rates**.
2. Pick the **Default treatment**: how tax applies to materials, labour and other lines.
3. Check the line that says **New documents:** to see what new estimates will charge.
4. Press **Save tax set-up**.

Saving changes new documents only. Estimates and invoices you already made keep their taxes.

## Rates in the app

Checked 2026-10-19.

| Province | Taxes | Combined |
| --- | --- | --- |
| AB, NT, NU, YT | GST 5% | 5% |
| BC | GST 5% + PST 7% | 12% |
| SK | GST 5% + PST 6% | 11% |
| MB | GST 5% + RST 7% | 12% |
| ON | HST 13% | 13% |
| NB, NL, PE | HST 15% | 15% |
| NS | HST 14% (15% before 2025-04-01) | 14% |

PST and RST are charged on the price before GST, so there is no tax on tax. Quebec's GST and QST are in the rate table, but full Quebec support is not ready yet.

## Treatments by province

| Province | Default | Other choices |
| --- | --- | --- |
| BC | **Real property contract (no PST charged)**: you pay PST on materials when you buy them and don't charge it | **Goods that stay goods, with install (PST on all)**, **Goods sold without install (PST on materials)**, **No tax** |
| SK, MB | **PST/RST on the whole contract**, labour included | **No tax** |
| All others | **Tax on everything** | **No tax** |

Use **No tax** for an exempt customer or supply, and keep the proof on file.

## Per estimate and invoice

Each document has its own **Tax province** and **Tax treatment**. Set the tax province to where the work is done, which may differ from your home province. Change the treatment for one job without touching your defaults.

An invoice is rated on its issue date. If you change the issue date, the rates update to match. An invoice made from an older estimate keeps the estimate's treatment but uses the rates in force on the invoice date.

## Custom rates

**Custom rates** lets you set up to three taxes yourself. Give each a name and a rate, and tick whether it applies to **Materials**, **Labour** and **Other** lines. Use this only when the presets don't fit your situation.

## A known gap

A BC job that mixes real-property work with goods that stay goods needs two treatments. Fishtape allows one treatment per document. Split it into two invoices, or use custom rates, and check the approach with your accountant.
$md$, 'money', 'published', 70, now()),
  ('inviting-your-crew-and-pin-mode', $md$Adding your crew and using PIN sign-in on a shared iPad$md$, $md$Add your crew with the right roles, then set up a shared site iPad where each person signs in by tapping their name and entering a PIN.$md$, $md$Your crew can each sign in with their own email and password, or share one iPad on site and sign in with a PIN. Both work on every plan. Your plan includes a set number of users, and [Billing](#/billing) shows how many you are using.

## Roles

Each person's role decides what they can see and change.

| Role | What they get |
| --- | --- |
| Owner, Admin | Everything, including settings, billing and integrations |
| Office | Everything except settings and the security audit |
| Foreman | Jobs, schedule, drawings, inventory, time (and approving time), SOPs, compliance, calculators, panels |
| Electrician | Jobs, drawings, time, SOPs, calculators, panels, compliance |
| Apprentice | Jobs, drawings, time, SOPs, calculators |

Only an owner can make someone an owner or admin. A company always keeps at least one active owner.

## Add people to Employees

1. Open [Employees](#/employees) and press **Add employee**.
2. Enter their full name, role, hourly cost rate, email, phone, licence number and licence expiry.
3. Press **Add employee**.

The employee record is what the schedule, time clock and SOP sign-offs use. The licence expiry badge turns to a warning within 30 days of the date and shows **expired** once it has passed.

## Sign-in accounts and invites

When someone is added to your company with an email address, Fishtape emails them an invite. They tap the link and set a password. The link works for 7 days. If it runs out, they can use **Forgot password?** on the sign-in screen to get a new one.

In this version, the app has no button for sending invites yourself. To add a sign-in for a new person, contact Fishtape support.

Owners and admins must turn on two-step sign-in with an authenticator app. Other roles can sign in with email and password.

## Set up a shared iPad

Use this for an iPad that stays in the van or on site. Set it up while you are signed in as a manager.

1. On the iPad, open your [Account](#/account) page.
2. Under **Shared iPad**, press **Use this iPad for crew sign-in**.
3. Give it a name, such as `Site iPad` or `Van 2`, and press **Register**.
4. Under **Crew PINs**, press **Set PIN** next to each person. A PIN is 4 to 8 digits and can't be all the same digit.
5. Press **Hand over to crew**.

The iPad now shows **Who is working?** Each person taps their name and enters their PIN. When they are done, they open their Account page and press **Done: hand back the iPad**. The company's data stays on the iPad between people.

People can also set their own PIN on their Account page under **Your crew PIN**.

## What crew can do on a shared iPad

- A crew session can do at most what a foreman can, even for an owner.
- Too many wrong PINs locks that person out for a few minutes. Too many on one iPad locks the iPad for a while.
- Signing in with a PIN needs a connection.
- A manager can still press **Manager? Sign in with email** on the crew screen.

## Lost or retired iPad

Sign in as a manager on that iPad, open the Account page and press **Stop crew sign-in here**. Crew can no longer sign in on it with a PIN, and it becomes a personal device again. If the iPad is lost, change your crew's PINs under **Crew PINs** and contact Fishtape support.

## About the PIN on the employee form

The **PIN (4 digits, optional)** field in Employees is for switching between people in demo mode on one device. Shared iPad sign-in uses the crew PINs on the Account page.
$md$, 'team', 'published', 80, now()),
  ('connecting-stripe-email-sms', $md$Connecting Stripe, email and SMS$md$, $md$Connect your own Stripe, Resend and Twilio accounts so customers pay invoices by card, and invoices, estimates and follow-ups go out from your address and number.$md$, $md$Fishtape connects to accounts you own. Card payments go to your Stripe account, email comes from your address through Resend, and texts come from your number through Twilio. Fishtape adds no fee on top.

## Before you start

- You need to be an owner or admin, with two-step sign-in turned on.
- You need a connection. Keys are saved on the server, not on your device.
- Check your plan:

| Service | Used for | Plan |
| --- | --- | --- |
| Stripe | **Pay online** links on invoices | Pro and higher |
| Resend | Emailing invoices, estimates and follow-up sequences | Pro and higher |
| Twilio | Text steps in follow-up sequences | Business and higher |

A card your plan doesn't include shows the plan that does, with a button such as **Upgrade to Business**. Without email or texts connected, those messages wait in the outbox for someone to send by hand.

## How each card works

Open [Integrations](#/integrations). Each service has a card with:

- **Setup guide**: step-by-step instructions for that service, including what it costs.
- The key fields. Paste a key and press **Save**. Fishtape tests it right away.
- **Test connection** to check it again later.
- **Disconnect** to delete the saved keys.
- **Ask us to set this up** if you'd rather we do it for a flat fee.

Keys are encrypted on the server and never shown again. To keep a saved key, leave its box blank.

## Stripe (about 15 minutes)

1. In Stripe, finish **Activate payments** so you can take live payments.
2. Make a **restricted key** named `Fishtape` with **Checkout Sessions** set to **Write** and everything else at **None**. Paste it into the Stripe card.
3. Copy the **Webhook URL** from the card. In Stripe, add it under **Developers > Webhooks** with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Copy the signing secret (it starts with `whsec`) into the card and press **Save**.

To use it, open an invoice with a balance and press **Pay online**. Send the link to your customer. It is also printed on the invoice. When they pay by card, the payment is recorded on the invoice. Refunds are done in Stripe. Record them on the invoice by hand for now.

Stripe charges its own fee per payment. As of 2026-10-19, a Canadian card costs 2.9% plus 30 cents. Check Stripe's pricing page for current rates.

## Email with Resend (about 20 minutes, plus DNS)

1. Sign up at Resend and add your domain.
2. Add the DNS records Resend shows you where your domain is managed, then press **Verify DNS records** in Resend.
3. Make an API key with **Sending access**. Paste it into the Resend card.
4. In **Resend sender address**, enter the name and address customers should see, for example `Your Company <office@yourcompany.ca>`, and optionally a **Reply-to address**.
5. Press **Save**, then send yourself an invoice to check it arrives and isn't in spam.

After that, the invoice and estimate preview has an **Email** button, and invoices get **Email invoice**. Emailing a draft marks it sent.

## Texts with Twilio (about 20 minutes)

1. Sign up at Twilio and upgrade from the trial, or every text starts with a trial notice.
2. Buy a Canadian local number with SMS.
3. Paste your **Account SID**, **Auth Token** and the number into the Twilio card and press **Save**.
4. In Twilio, set the number's **A message comes in** webhook to the URL on the card, so Fishtape sees STOP replies.

Texts end with "Reply STOP to opt out." Canada's anti-spam law (CASL) requires an unsubscribe option, and you need the customer's consent before you text them, for example because they asked you for a quote.
$md$, 'integrations', 'published', 90, now());

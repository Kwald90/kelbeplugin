# Code books in Fishtape

Fishtape's field tools follow the **Canadian Electrical Code, Part I, CSA C22.1:24 (CEC
2024, 26th edition)** by default. A company can switch to **NEC 2023** in Settings → Code
book and units (`settings.codeBook`: `'CEC-2024' | 'NEC-2023'`). The calculators, panel
schedules and code checklists change with it.

- [adoption.md](adoption.md): edition in force, effective date, inspection authority and amendments per province.
- [tax.md](tax.md): GST/HST/PST/RST by province and how they apply to contractors.
- [verify.md](verify.md): values still to check against the printed code.

**Copyright.** CSA's text is copyrighted. The code and docs hold numbers, rule and table
references and our own one-line summaries only, never quoted rule text. Every value has a
source comment; anything unconfirmed says `VERIFY` and is listed in verify.md.

**Estimating aids.** The calculators cite rules and tables so an electrician can check
them. The inspection authority's reading of the code in force decides.

## Where things live

`electrical-app/js/lib/cec/` (pure functions, SI units; `index.js` re-exports everything):

| File | Rules and tables |
| --- | --- |
| `conductors.js` | Tables 1-4 (ampacity, 60/75/90 °C, Cu/Al, raceway and free air), 5A, 5C; Rule 4-006 terminations; Rule 14-104(2) small conductors; Table 13 / standard ratings; Rule 8-104 continuous loads; `sizeConductor` |
| `voltage-drop.js` | Rule 8-102 limits and design current; VD, minimum size, maximum length (metres) |
| `conduit.js` | Rule 12-910, Table 8 fill limits; Table 9 areas for EMT, RMC, PVC, ENT, FMC (trade sizes 16-103); Table 6 areas for T90 Nylon, TWN75, RW90 XLPE |
| `boxes.js` | Rule 12-3034 counting; Table 22; Table 23 box volumes |
| `loads.js` | Rules 8-110, 8-200 (single dwelling, minimum service), 8-202 (apartments), 62-118 (heating demand); Ontario Table 39 |
| `motors.js` | Tables 44, 45; Rule 28-106; Table 29 and Rule 28-200; Rule 28-306 |
| `bonding.js` | Table 16 |
| `systems.js` | 120/240 V 1φ, 120/208 V 3φ, 347/600 V 3φ 4-wire, 600 V 3φ 3-wire (and 277/480 V for NEC); slot phases and phase balance for every system. Code-neutral; `nec.js` re-exports it. |
| `amendments.js` | `RULE_PARAMS` (numbers per rule) and `AMENDMENTS` (per province); `ruleParams(rule, province)` merges a province's overrides |
| `provinces.js` | `ADOPTION` (edition, date, authority per province), `CODE_BOOKS`, `codeBookOf` |
| `checklists.js` | CEC checklists (dwelling rough-in, service, final, EV, commercial) and `cecTemplates(province)`, which appends that province's amendments |

The NEC 2023 book is `electrical-app/js/lib/nec.js`; `electrical.js` re-exports it for older imports.

## Units

Calculations are in SI (metres, mm², mL, W). Each user picks metric or imperial
(`js/lib/units.js`; asked once on first launch, changeable in Settings). Calculator lengths
take `30`, `30 m`, `98' 6"` or `98.5` (feet, for imperial users); areas show in m² or ft².
CEC table quantities stay metric (mm², mL) with in² / in³ alongside for imperial users.
Conductor sizes stay AWG/kcmil, as in the CEC.

## Main sources for the tables

- Southwire Canada, spec 10006 "2021 CEC Table 2" and SIMpull RW90 sheet "2015 CEC Table 2": https://cabletechsupport.southwire.com/tile/3/spec/10006/?country=CA, https://ebhorsman.com/amfile/file/download/file/2450/product/39569
- Prysmian NUAL RWU90 spec 5600A, "CEC Table 4": https://na.prysmian.com/sites/na.prysmian.com/files/media/documents/NUAL%20Brand%20RWU90%20High%20Speed%20%28HS%29%20-%20SPEC%205600A.pdf
- IAEI Magazine (Canadian columns): ampacity harmonization (2012), Table 5A/5C examples (2012, 2016), Rule 14-104 (2016), Rule 4-006 ampere rating, Section 8 circuit loading (2016), Table 6/9 changes (2016, 2021), motors Q&A, grouping of motors (2013): https://iaeimagazine.org
- Bill Burr, "Guide to the CE Code 26th edition" series (Sections 8, 10, 12, 14), Electrical Industry News: https://electricalindustry.ca
- ESA bulletins: 8-6-5 (voltage drop, May 2025), 8-3-15 / 8-3-16 (load calculations), 2021-OA-002 (Rule 4-004, Table 39), Code File (conduit fill example): https://esasafe.com
- Manitoba Hydro, "Calculated load for services and feeders" (Rule 8-200, 2024): https://hydro.mb.ca/docs/permits/calculated-load-for-services-and-feeders.pdf
- City of Vancouver, apartment/multiplex electrical load calculation form (Rule 8-202, 2024): https://vancouver.ca/files/cov/electrical-load-calculation-form-for-apartment-multiplex.pdf
- ABB / Iberville Canada gangable device box catalogue (Tables 22 and 23): https://el-sales.ca.abb.com/retail/content/files/A5-A6-DeviceBoxes_Gangable_3x2.pdf
- Alberta STANDATA 21-ECI-012 (Rule 12-3034 counting): https://electricalindustry.ca/latest-articles/standata-interpretation-section-12
- Mersen CSA Class H fuse data sheet (fuse ampere ratings).
- BCcampus / SkilledTradesBC open text, Sections 4, 8, 10, 12: https://opentextbc.ca/plumbing4e/
- Nexans Electrician's Handbook (reprint of older CEC tables; used only for Tables 5C, 8, 16, 44, 45 where newer sources spot-check the same values).
- NEC 2023 Chapter 9 Tables 4, 5 and 8 for physical conduit and conductor dimensions and DC resistance where no CEC figure was found (flagged VERIFY).
- BC Hydro, electrical service voltages: https://app.bchydro.com/accounts-billing/electrical-connections/electrical-service-voltages.html

## Checklist rule numbers

The CEC checklists use only rule numbers found in public sources (2024 edition unless the
item says otherwise): ESA bulletins 26-18-15, 26-23-7, 26-26-6, 26-29-6, 26-14-9, 12-19-17,
2-9-9, 6-9-4, 8-3-16, 10-14-11, 10-15-9, 10-17-8, 86-01-7 (2025); Technical Safety BC
directive D-EL 2016-01 rev 2, IB-EL 2023-02 and 2023-04, 2021 and 2024 change summaries;
City of Winnipeg IB 2026-002-E; TSASK homeowner guide; APEGNB 2024 CE Code presentation;
Burr's Section 10, 12, 46 and 86 guides; IAEI 2018 and 2021 change articles.

Renumbering traps the templates avoid:

- Section 10 was rewritten in 2018: grounding electrodes are **10-102**; 10-700 is now
  bonding of metal piping.
- NMSC rules moved in 2024 from 12-510..12-526 to **12-552..12-576** (12-500..12-524 now
  cover other non-metallic-jacketed cable).
- The CEC's lighting-outlet rules (30-500 series) were deleted in 2021; those requirements
  are in the National Building Code 9.34.2.
- Receptacle rules moved in 2015 and 2018: 26-654, 26-658, 26-704, 26-706, 26-708, 26-720,
  26-722, 26-724 are current.

# Electrical code adoption by province and territory

Checked 2026-10-19. Fishtape's default code book is the **Canadian Electrical Code, Part I,
26th edition (CSA C22.1:24, "CEC 2024")**. Every province and territory except Quebec and
(probably) Nunavut now enforces it, with amendments in some places. The data below drives
`electrical-app/js/lib/cec/provinces.js` (`ADOPTION`) and the amendment overrides in
`electrical-app/js/lib/cec/amendments.js` (`AMENDMENTS`).

Quebec is noted for later: it needs Chapter V, QST and French.

## Edition in force, instrument and inspection authority

| Prov. | In force | Effective | Adopting instrument | Inspections and permits | Sources |
| --- | --- | --- | --- | --- | --- |
| ON | Ontario Electrical Safety Code 29th ed. (CEC 2024 + Ontario amendments) | 2025-05-01 | O. Reg. 164/99 as amended by O. Reg. 449/24 (filed 2024-11-06) | Electrical Safety Authority (ESA). Notifications or plan reviews filed before 2025-05-01 may stay on the 28th edition if inspected within 12 months. | S1, S3, S4 |
| BC | BC Electrical Code = CEC 2024, no BC deviations | 2025-03-04 | Electrical Safety Regulation (B.C. Reg. 100/2004) s.20, amended by B.C. Reg. 118/2024 | Technical Safety BC; some local governments run their own electrical permits (Burnaby switched for applications from 2025-03-05; City of Vancouver's date VERIFY) | S5, S6, S7 |
| AB | CEC 2024 with Alberta variances | 2025-04-01 | Electrical Code Regulation under the Safety Codes Act (regulation number VERIFY) | Accredited municipality or agency under Alberta Municipal Affairs (Safety Codes) | S8, S9 |
| SK | CEC 2024 with the 2024 Saskatchewan Interpretations | adopted 2025-03-01, enforced 2025-06-01 | The Electrical Inspection Act, 1993 s.5 | Technical Safety Authority of Saskatchewan (TSASK); inspections moved from SaskPower on 2021-02-01 | S11, S12, S14 |
| MB | Manitoba Electrical Code = CEC 2024 + Manitoba schedule | 2026-04-01 | Man. Reg. 30/2026 (repeals 76/2018), in force with S.M. 2021 c.37 Sch. C | Manitoba Hydro outside Winnipeg; City of Winnipeg inside the city (whether Winnipeg's by-law was amended: VERIFY) | S15, S16, S17 |
| NB | CEC 2024 with NB Rule 26-722 | 2026-03-15 | N.B. Reg. 84-165 as amended by N.B. Reg. 2026-5 (filed 2026-03-11) | Technical Inspection Services, Department of Public Safety | S19, S20 |
| NS | CEC 2024, no amendments | 2024-07-02 | Electrical Code Regulations under the Electrical Installation and Inspection Act s.6 | The supplying utility's inspection department (mainly Nova Scotia Power), overseen by the Provincial Chief Electrical Inspector | S21, S22 |
| PE | CEC 2024 with PEI Schedule 1 | 2024-10-05 | Electrical Inspection and Code Regulations (EC757/18), amended by EC2024-874 | Chief Electrical Inspector, Inspection Services (department name VERIFY) | S23, S24 |
| NL | CEC 2024 | enforced 2024-07-01 for permits issued from then | Public Safety Act, Electrical Regulations | Electrical Safety Services, Department of Government Services | S25, S26 |
| YT | CEC 2024 | 2025-04-01 | Electrical Protection Act (Bulletin 25-01) | Building Safety and Standards, Government of Yukon (Yukon variance bulletins for 2024: VERIFY) | S27 |
| NT | CEC 2024 | enforced 2024-10-01 | Electrical Protection Act and Regulations | GNWT Department of Infrastructure | S28 |
| NU | **VERIFY.** The last regulation found adopts CEC 2015 (in force 2015-10-01); a third-party table lists CEC 2018. No 2024 adoption found. | — | Electrical Protection Regulations s.4 | Office of the Chief Electrical Inspector, Service Nunavut | S29, S30, S38 |
| QC | Code de construction, Chapitre V – Électricité, based on CEC 2021 + Quebec changes (CEC 2024 not adopted) | 2026-03-26 | Construction Code regulation (Gazette 2026-03-11) | Régie du bâtiment du Québec (RBQ). The previous Chapter V may still be used for work started before 2027-10-17. | S31, S32 |

## Provincial amendments in the app

Each one is in `AMENDMENTS` with its rule number, our own one-line summary and its source.
Amendments that change a number the calculators use carry `params`, merged by
`ruleParams(rule, province)`:

- **Ontario, Rule 4-004(26) and Table 39.** Ontario kept Table 39 (deleted nationally in 2021)
  for 90 °C single-dwelling service conductors. The rows are in `params.table39`, and the
  service-load calculator shows them for Ontario companies.
- **Manitoba, Rule 8-102(1).** The voltage drop limit applies to branch circuits only
  (`params: { feeder: null, total: null }`). The voltage-drop calculator says so.

The other amendments appear as extra items on the CEC checklists for that province
(`cecTemplates(province)` in `js/lib/cec/checklists.js`).

| Prov. | Rules | Source |
| --- | --- | --- |
| ON | 2-004, 2-005, 2-010 (plan review thresholds; EV/bidirectional threshold 12 kW from 2026-07-06), 4-004(26) + Table 39, 6-112 / 6-116 / new 6-118, 8-106 / 8-202 / new 8-500 (energy management for any load), new 14-418, 26-744 (14-50R range receptacle required), 28-500(4) | S2 (ESA "2024 Ontario Amendments", 2024-11-13), S1 |
| BC | none: Technical Safety BC says there are no deviations this cycle | S5 |
| AB | 6-308 variance 24-ECV-006-308 (USEB cable with a bare neutral allowed again) | S10 |
| SK | 26-656, 26-658, 26-704, 26-706, 26-724 (reading), 26-806 | S12, S13 |
| MB | 2-000 and 2-004 to 2-032 (administration), 6-400, 8-102(1), 8-202(3)(d), 10-102(2)(a), 10-116(1), 10-210, 12-2208, 64-110, 76-006; Technical Interpretations on 26-704(2) and 26-724 | S15, S17 |
| NB | 26-722 replaced by NB's dwelling receptacle rule | S19 |
| NS | none | S21 |
| PE | 2-036, 6-112, 64-210(5), 72-114 (services over 200 A in a rated room: rule not identified, VERIFY) | S23 |

Not modelled: Manitoba 38-051(5.1) (machine-room-less elevator disconnect); Quebec's EV
infrastructure requirement for buildings of 5 or more units.

## Notable national changes in CEC 2024

From public summaries (S21, S33, S34, S35); our own wording:

- Section 0: extra-low and low voltage dc thresholds raised (42.4 V dc → 60 V dc; high voltage at 1500 V dc).
- Rule 2-100: maximum-load marking; the panel schedule must be updated whenever circuits change.
- Rule 2-306: stronger shock and arc-flash marking; devices of 1200 A and up need a documented means to cut arcing-fault clearing time.
- Section 8 / Rule 8-202: new EVSE and energy-management demand factors for multi-unit buildings; Table 38 deleted.
- Rule 8-200(1)(b): the minimum is now stated in watts (24 000 W or 14 400 W) instead of 100 A / 60 A.
- Rule 6-308: revised for single-point grounding. Rule 10-702: gas piping may be bonded through the appliance circuit's bonding conductor.
- Rules 12-500 to 12-524: new rules for non-metallic-jacketed cable; NMSC rules moved to 12-552 to 12-576.
- Rule 26-724: more outdoor receptacles for dwellings. Rule 26-704: outdoor 15/20 A receptacles need GFCI.
- Section 64: major ESS and PV revisions incl. rapid shutdown; new 64-1100 for residential ESS.
- Rule 66-400: GFCI for outdoor or damp temporary installations. Rules 68-058 / 68-072: hot tub bonding and disconnects.
- Not confirmed: national changes to Section 86 (vehicle-to-home) or to Rule 26-658 AFCI.

## Sources (all accessed 2026-10-19)

- S1 ESA, OESC page: https://esasafe.com/role/oesc/
- S2 ESA, 2024 Ontario Amendments (2024-11-13): https://esasafe.com/assets/files/esasafe/pdf/amendments/2024/2024-Ontario-Amendments-Final.pdf
- S3 ESA, Toolbox Talks (April 2025): https://esasafe.com/assets/files/esasafe/pdf/Contractor/Toolbox-Talks-April%202025_Final.pdf
- S4 O. Reg. 449/24: https://www.ontario.ca/laws/regulation/R24449
- S5 Technical Safety BC, IB adoption of BC Electrical Code 2024 (2024-06-11): https://technicalsafetybc.ca/regulatory-resources/regulatory-notices/information-bulletin-adoption-of-bc-electrical-code-2024-edition
- S6 B.C. Reg. 118/2024: https://free.bcpublications.ca/civix/document/id/lc/bcgaz2/v67n10_118-2024
- S7 City of Burnaby notice (January 2025): https://burnaby.ca/sites/default/files/acquiadam/2025-01/2024-Canadian-Electrical-Code.pdf
- S8 Electrical Industry News (2024-04-08): https://electricalindustry.ca/?p=74800
- S9 Alberta, electrical codes and standards: https://www.alberta.ca/electrical-codes-and-standards.aspx
- S10 Electrical Industry News (2025-10-06): https://electricalindustry.ca/?p=83463
- S11 TSASK electrical: https://www.tsask.ca/electrical
- S12 TSASK, 2024 CEC Saskatchewan Interpretations v2.0 (2025-10-15): https://api.tsask.ca/wp-content/uploads/2025/10/2024_CEC_Sk_Interps-v2.0.pdf
- S13 TSASK, 2024 CEC roll-out contractor questions (2025-03-01): https://api.tsask.ca/wp-content/uploads/2025/03/2024-CEC-Roll-Out-Session-Contractor-Questions-1.pdf
- S14 SaskPower news release (2021-02-01): https://www.saskpower.com/about-us/media-information/news-releases/2021/saskpower-to-transfer-gas-and-electrical-inspections-to-technical-safety-authority-of-saskatchewan
- S15 Man. Reg. 30/2026: https://web2.gov.mb.ca/laws/regs/annual/2026/030.pdf
- S16 Manitoba proclamation (2026-03-25): https://web2.gov.mb.ca/laws/statutes/proclamations/2021c37C(2026-04-01).pdf
- S17 City of Winnipeg / Manitoba Hydro 2024 Technical Interpretations: https://www.winnipeg.ca/media/6699
- S19 N.B. Reg. 2026-5: https://laws.gnb.ca/en/document/ar/2026-5
- S20 GNB technical inspections: https://www.gnb.ca/en/topic/laws-safety/licensing-inspections/technical-inspections.html
- S21 Nova Scotia Safety Bulletin 0000035 (2024-07-05): https://novascotia.ca/lae/healthandsafety/docs/safety-bulletin-0000035-en.pdf
- S22 Nova Scotia Power inspections: https://www.nspower.ca/your-home/building-renovating/electrical-inspections
- S23 PEI EC2024-874 (2024-09-24): https://www.princeedwardisland.ca/sites/default/files/publications/20240924truwww.pdf
- S24 PEI, electrical work: https://www.princeedwardisland.ca/en/information/housing-land-and-communities/electrical-work-in-pei
- S25 NL bulletin, CEC 2024 adoption (2024-02-21): https://www.gov.nl.ca/gs/files/EBulletin-CEC-Code-2024-Adoption.pdf
- S26 NL safety bulletins: https://www.gov.nl.ca/gs/safety/bulletins/
- S27 Yukon Bulletin 25-01: https://yukon.ca/en/bulletin-25-01-adopting-2024-edition-canadian-electrical-code
- S28 GNWT notice: https://www.inf.gov.nt.ca/en/content/adoption-canadian-electrical-code-part-one
- S29 Nunavut Electrical Protection Regulations (2015): https://www.nunavutlegislation.ca/en/file-download/download/public/3676
- S30 Electro-Federation Canada, codes table (third party, partly stale): https://www.electrofed.com/products/codes/
- S31 RBQ news (2026-03-12): https://www.rbq.gouv.qc.ca/salle-de-presse/les-nouvelles/nouvelles-detail/item/2026-03-12-communique-reglementation-en-electricite-mise-a-jour-du-code-de-construction-et-du-code-de-securite/
- S32 RBQ news (2026-08-26): https://www.rbq.gouv.qc.ca/salle-de-presse/les-nouvelles/nouvelles-detail/item/2026-08-26-prolongation-de-la-periode-transitoire-en-batiment-et-en-electricite-reglements-publies-pour-entree-en-vigueur/
- S33 Technical Safety BC, top 10 changes in CEC 2024 (2025-02-04): https://blog.technicalsafetybc.ca/top-10-changes-you-need-to-know-about-the-2024-canadian-electrical-code
- S34 Canadian Electrical Wholesaler (2023-11-06): https://www.canadianelectricalwholesaler.ca/2024-canadian-electrical-code
- S35 TSASK hot tubs paper (April 2025): https://api.tsask.ca/wp-content/uploads/2025/04/Hot-Tubs-New-2024-Canadian-Electrical-Code-Information-PaperAO.pdf
- S38 Service Nunavut, Office of the Chief Electrical Inspector: https://www.gov.nu.ca/en/service-nunavut/office-chief-electrical-inspector

# Sales tax for Canadian electrical contractors

Checked 2026-10-19. Code: `electrical-app/js/lib/tax.js` (rates, treatments) and
`electrical-app/js/lib/money.js` (`docTotals`). Tests: `electrical-app/tests/tax.test.mjs`.

> **Check with your accountant.** Whether PST or RST applies to a contracting job depends on
> the province, on whether the work becomes part of the building, and sometimes on the
> customer. Fishtape gives presets to start from, not tax advice. The app says this on
> every estimate and invoice that carries PST/RST and in Settings.

## Rates

| Prov. | Taxes | Federal | Provincial | Combined | Current rate since | Source |
| --- | --- | --- | --- | --- | --- | --- |
| AB, NT, NU, YT | GST | 5% | — | 5% | 2008-01-01 | CRA rates page |
| BC | GST + PST | 5% | 7% | 12% | 2013-04-01 | gov.bc.ca/pst (updated 2026-09-21) |
| SK | GST + PST | 5% | 6% | 11% | 2017-03-23 | saskatchewan.ca PST page; 2017 budget backgrounder |
| MB | GST + RST | 5% | 7% | 12% | 2019-07-01 (was 8%) | Manitoba Bulletin 005 (rev. July 2019) |
| QC | GST + QST | 5% | 9.975% | 14.975% | 2013-01-01 | Revenu Québec rate tables |
| ON | HST | | | 13% | 2010-07-01 | CRA rates page |
| NB, NL | HST | | | 15% | 2016-07-01 | CRA rates page |
| PE | HST | | | 15% | 2016-10-01 | CRA rates page |
| NS | HST | | | **14%** | **2025-04-01** (was 15%) | CRA rates page; NS news release 2024-10-23; NS transitional rules |

`RATE_HISTORY` keeps earlier rates so a document dated before a change uses the old rate
(Nova Scotia 15% before 2025-04-01, Manitoba RST 8% before 2019-07-01, HST 13% in NB/NL/NS
from 2008). An invoice is rated on its issue date; changing the issue date re-rates it.
The general NS transition test is when the tax became payable (CRA Notices 342 and 343).

PST, RST and QST are each charged on the price before GST: no tax on tax (Revenu Québec;
Saskatchewan PST-12; Manitoba Bulletin 005).

No rate changes in 2025-2026 other than Nova Scotia. BC's planned October 2026 PST
expansion to professional services was paused on 2026-09-18 and doesn't touch electrical
work. Manitoba's 2026 budget changed exemptions (food) only. Saskatchewan's 2026-27 budget
was not checked against the budget papers.

## How each tax applies to a contractor

GST, HST and QST apply to the whole contract, labour and materials, everywhere. Place of
supply for a service to real property is the province where the property is (New HST
Regulations SOR/2010-117 s.14; GST/HST Memorandum 3-3-6), so each estimate and invoice has
its own **tax province** (defaults to the company's).

| Prov. | Rule for electrical work | Default treatment in the app | Other treatments |
| --- | --- | --- | --- |
| BC | Services to real property, electrical included, are **not** subject to PST. The contractor pays PST on materials that become real property (lump sum or T&M) and doesn't charge it. PST is charged on goods sold without installation, and on goods that stay goods plus their installation (Bulletin PST 301, related services). Real property: in-wall wiring, fixed light fixtures, hardwired fans, smoke detectors, thermostats. Not real property: plug-in lamps, freestanding appliances, plug-in equipment. | `real-property`: GST on everything, no PST, with a note on the invoice | `tpp-service` (PST on parts and labour), `separate-goods` (PST on materials), `none` |
| SK | PST applies to the **total charge** for services to real property, residential and commercial alike, labour and materials, shown as its own line. Materials are bought PST-exempt with the vendor's licence. No option to pay PST on materials instead (PST-38). | `pst-all` | `none` (e.g. a licensed general contractor quoting their vendor's licence; exempt farm services) |
| MB | Electrical systems are tangible personal property under the Act, so **RST applies to the total selling price** of electrical contracts and service work, labour included, even inside buildings (Bulletin 031). Wire and gear are bought RST-exempt. | `pst-all` | `none` (exempt customers: federal government with RST number, Status Indians or bands on reserve, qualifying farm work) |
| QC | QST like GST, on the full price | `standard` | `none` |
| HST provinces, AB, territories | GST/HST on the full price | `standard` | `none` |

Each line on an estimate or invoice has a kind (material, labour, other); the treatment
says which kinds each tax applies to, so one document can carry GST on everything and PST on
materials only. Markup on materials is taxed like materials. Each tax is rounded once per
document, half a cent up (CRA rounding).

Known gap: a BC job that mixes real-property work with goods that stay goods needs two
treatments on one invoice. The app has one treatment per document; split it into two
invoices or use custom rates until per-line overrides exist.

## Data model

A new estimate or invoice gets a snapshot of its taxes, so later rate or settings changes
never rewrite an old document:

```
taxProvince: 'BC', taxTreatment: 'real-property',
taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material, labour, other }, note }, ...],
taxPct: 5   // combined rate of the taxes that apply to anything, kept for older readers
```

Records from before this change only have `taxPct`; `docTotals` treats that as one "Tax"
component on every line, so their totals are unchanged. `docTotals` returns
`taxes: [{ id, label, pct, baseCents, cents, note }]` and `taxCents` (their sum).

Settings: `company.province`, `company.gstHstNo`, `company.pstNo`,
`tax: { mode: 'province' | 'custom', treatment, custom: [{ label, pct, applies }] }`.

## Registration numbers

- GST/HST: 9-digit business number + RT + 4 digits, e.g. `123456789 RT0001`. It must appear
  on invoices of $100 or more for the customer to claim input tax credits (CRA RC4022).
  Printed on every invoice and estimate when set.
- BC PST: `PST-1234-5678` (gov.bc.ca). SK vendor's licence (7 digits), MB RST number
  (`123456-1`) and QST (`1234567890TQ0001`): formats from third-party sources, not validated.
- Small suppliers with $30,000 or less of taxable revenue over four quarters don't have to
  register and then don't charge GST/HST (RC4022).

## Sources

- CRA, GST/HST rates calculator (modified 2025-04-01): https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
- CRA, which rate to charge (modified 2026-04-08): https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html
- Nova Scotia news release (2024-10-23): https://news.novascotia.ca/en/2024/10/23/nova-scotias-hst-drop-2025
- Nova Scotia HST transitional rules: https://novascotia.ca/finance/en/home/taxation/tax101/docs/hst-transitional-rules.pdf
- BC PST: https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst
- BC, PST for real property contractors (updated 2025-11-27): https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/charge-collect/pst-real-property-contractors
- BC Bulletin PST 301, related services: https://www2.gov.bc.ca/assets/gov/taxes/sales-taxes/publications/pst-301-related-services.pdf
- BC sales tax updates (2026-10-19): https://www2.gov.bc.ca/gov/content/taxes/tax-updates/updates-taxes-tax-credits/sales-taxes-updates
- Saskatchewan PST: https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax
- Saskatchewan Bulletin PST-12, services to real property (rev. July 2024): https://publications.saskatchewan.ca/api/v1/products/7943/formats/11429/download
- Saskatchewan Bulletin PST-38 (rev. July 2024): https://publications.saskatchewan.ca/api/v1/products/7970/formats/11509/download
- Manitoba Bulletin 031, mechanical and electrical trades (rev. July 2019): https://www.gov.mb.ca/finance/taxation/pubs/bulletins/031.pdf
- Manitoba Bulletin 005, information for contractors (rev. July 2019): https://www.gov.mb.ca/finance/taxation/pubs/bulletins/005.pdf
- Revenu Québec, GST and QST rates: https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/tables-of-gst-and-qst-rates/
- CRA RC4022, general information for GST/HST registrants: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4022/general-information-gst-hst-registrants.html
- New HST Regulations SOR/2010-117: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2010-117/page-1.html
- GST/HST Memorandum 3-3-6: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6/plc-spply-prvnc-gnrl-rls-fr-srvcs.html

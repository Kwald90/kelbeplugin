# Sales tax for Canadian electrical contractors

Checked 2026-10-19; Release 1 rows added 2026-10-20 (Manitoba RST from Bulletin 031, see the
[gap analysis](../releases/gap-analysis-2026-10.md) section A and the
[Release 1 contract](../releases/r1-get-paid.md) sections 2.9 and 3). Code:
`electrical-app/js/lib/tax.js` (rates, treatments, hints, line presets),
`electrical-app/js/lib/money.js` (`docTotals`, holdback, deposits, credit notes, revenue),
`electrical-app/js/lib/exemption.js` (exemption evidence and the send check) and
`electrical-app/js/lib/doc-view.js` (editors and the printed document). Tests:
`electrical-app/tests/tax.test.mjs`, `electrical-app/tests/money.test.mjs`,
`server/test/exemption-send.test.js`. Values still to confirm are in [verify.md](verify.md).

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
| BC | Services to real property, electrical included, are **not** subject to PST. The contractor pays PST on materials that become real property (lump sum or T&M) and doesn't charge it. PST is charged on goods sold without installation, and on goods that stay goods plus their installation (Bulletin PST 301, related services). Real property: in-wall wiring, fixed light fixtures, hardwired fans, smoke detectors, thermostats. Not real property: plug-in lamps, freestanding appliances, plug-in equipment. | `real-property`: GST on everything, no PST, with a note on the invoice | `tpp-service` (PST on parts and labour), `separate-goods` (PST on materials), `gst-only` (a customer who gives a PST number for goods they will resell; the number is printed), `none` (zero-rated, exempt or out-of-scope supplies and Indian Act relief only). `real-property` is not an exemption and needs no customer number. |
| SK | PST applies to the **total charge** for services to real property, residential and commercial alike, labour and materials, shown as its own line. Materials are bought PST-exempt with the vendor's licence. No option to pay PST on materials instead (PST-38). A general contractor on an ordinary building job pays PST (PST-12). | `pst-all` | `gst-only` (the customer gives a PST vendor's licence or exemption for this work: a licensed contractor buying for resale, or an exempt customer such as farm services; GST is still charged and the number is printed). `none` is for First Nations relief only (Indian Act s.87, which also relieves GST) and for zero-rated, exempt or out-of-scope supplies. |
| MB | Electrical systems are tangible personal property under the Act, so **RST applies to the total selling price** of electrical contracts and service work, labour, travel time and permits included, even inside buildings (Bulletin 031). Wire and gear are bought RST-exempt with the contractor's RST number. A general contractor or landlord on an ordinary building job **pays RST** (Bulletins 031, 005). | `pst-all` | `gst-only`, with the basis and the customer's 7-digit RST number on the job and printed on the invoice (Bulletin 004): another electrical or mechanical contractor subcontracting the work to us, a reseller, or a general contractor passing on an exempt customer's exemption (federal government with its RST number, Status Indian or band on reserve, farm-use certificate). The federal government and farms still pay GST, so they are `gst-only`, **not** `none`. `none` is for First Nations relief only (Indian Act s.87: GST relief too), with reason `relief`, plus zero-rated, exempt or out-of-scope supplies. |
| QC | QST like GST, on the full price | `standard` | `none` |
| HST provinces, AB, territories | GST/HST on the full price | `standard` | `none` |

Each line on an estimate or invoice has a kind (material, labour, other); the treatment
says which kinds each tax applies to, so one document can carry GST on everything and PST on
materials only. Markup on materials is taxed like materials. Each tax is rounded once per
document, half a cent up (CRA rounding).

Known gap: a BC job that mixes real-property work with goods that stay goods needs two
treatments on one invoice. The app has one treatment per document; split it into two
invoices or use custom rates. A labour or other line can switch single taxes off
(`taxOff`, below), but not switch PST on.

The `gst-only` hint is per province (`TREATMENTS['gst-only'].hints`), because the old wording
("for example a contractor buying for resale") led offices to drop RST on GC jobs in Manitoba,
which the contractor then owes. Each hint says who qualifies and that the number goes on the
invoice.

## Exemptions (per contract)

An exemption applies to a contract, not to a customer (Bulletin 031): a GC that passes on the
federal government's exemption on one job pays RST on the next. So:

- **Client** (Clients → Tax exemption): the evidence on file: basis, number, province, First
  Nations details (name, registry number, band, reserve), farm certificate number, federal
  department, the date it was last checked. It never changes a document by itself.
- **Job** (`jobs.taxExempt`, Job → Contract and payment): says the exemption applies to this job,
  with who confirmed it. New estimates and invoices on the job default to `gst-only` (`none` with
  reason `relief` for First Nations on reserve) and carry the exemption
  (`newDocTax(settings, date, { job, client })`).
- **Document**: `taxExemptNumber`, `taxExemptBasis`, `taxExemptDetails`, `exemptionConfirmed`
  (who ticked "This work is exempt", or `from: 'job'`). The editor shows under the tax picker when
  PST/RST is off; it prefills from the job, or from the client's evidence after the tick. Printed
  as e.g. "RST exemption: subtrade, RST no. 1234567".

Evidence per basis (`EXEMPT_EVIDENCE`):

| basis | needs |
| --- | --- |
| `subtrade` (an electrical or mechanical contractor subcontracting the work to us) | their RST/PST number |
| `resale` | their RST/PST number |
| `pass-on` (a GC passing on its customer's exemption) | the end customer's number and the end customer's name |
| `federal` | the department and the federal RST number |
| `first-nations` | the registry number, and the band or the reserve |
| `farm` | the farm-use certificate number |

Sending: a **Manitoba invoice** with RST off and the evidence missing is not sent: the PWA blocks
Email, Pay online and Mark sent, and the server refuses the email-document and pay-link routes and
the change from draft (422 `exemption_required`). Manitoba estimates, and BC and SK documents, get
a warning. Not checked: interest invoices, credit notes (they follow their original), holdback
release invoices, security-deposit invoices, documents with no work lines, `none` for zero-rated,
exempt or out-of-scope supplies, and BC `real-property` (not an exemption). Number formats are a
warning only (Registration numbers, below). A QuickBooks pull with the evidence missing is created
and goes to review (`exemption_missing`).

## Out-of-pocket disbursements

`TAX_OFF_PRESETS` has one line preset: "Out-of-pocket disbursement at cost (hotel, meals; not
travel time or permits)": kind `other`, `passThrough: true`, `taxOff: ['PST', 'RST']`. It carries
GST, not RST, and prints "(at cost, no RST)". It is offered in Manitoba while the policy rule
`tax.MB.passThroughAllowed` holds (status `verify`, shown "unconfirmed"; Bulletin 031 section 3 on
separately billed disbursements). Choosing it warns: "Travel time and permits are taxable. Use a
normal line for them." While `holdback.excludePassThrough` holds (also `verify`), the line is
outside the holdback base.

## Holdback and the taxes on it

An invoice may carry `holdback { pct, cents, deferTaxIds, excludePassThrough }`. The holdback base
is the work lines (no `lineType`, markup included) less pass-through lines; `holdbackCents =
cents ?? pct of the base`. The taxes in `deferTaxIds` are charged on the progress invoice net of
holdback and on the release invoice: GST/HST while `tax.CA.gstHoldbackAtRelease` holds (Excise Tax
Act s.168(7)), and the provincial tax while its own rule holds (`tax.MB.rstHoldbackAtRelease`,
`tax.SK.pstHoldbackAtRelease`, `tax.BC.pstHoldbackAtRelease`, all `verify`: if the accountant says
RST is due at billing, the deferred RST is remitted late with interest, so the screens say
"unconfirmed" with a one-click override on Books → Rules). `holdbackSnapshot` takes the rules when
the holdback is set, so a later rule change never re-rates a sent invoice. A holdback is refused
(`holdbackProblem`) when a deferred tax applies to some lines of the base but not others, when it
is larger than the base, or on a deposit, interest or release invoice. The release invoice has one
line `{ kind: 'other', lineType: 'holdback' }` taxed by the deferred taxes only
(`holdbackReleaseLine`). GST also falls due at substantial completion on the unbilled contract
value (s.168(3)(c)); the closeout checklist warns.

## Deposits and credit notes

- Prepayment deposit (default): taxed like the job when invoiced; applied later as a negative
  deposit line taxed the same way, so tax is not charged twice. It can be applied only on an
  invoice with the same tax set (province, taxes, treatment, exemption: `sameTaxSet`).
- Security deposit: the line has `taxOff: ['*']` and the invoice `taxNoneReason: 'out_of_scope'`
  (s.168(9): no tax until applied); its application line also carries no tax, so tax is charged
  on the full final amount. VERIFY that Manitoba RST follows the same timing.
- Credit note (`creditNoteFrom`): `kind: 'credit'`, number `CR-1001` on, dated today, negative
  lines, and the original's tax snapshot and exemption (`creditTaxSnapshot`), never re-rated at
  today's rates. Printed with the s.232 contents: "Credit note", the original invoice's number and
  date, the GST and RST registration numbers, the reason, and the tax adjusted per tax.

## Purchases: resale or own use

Manitoba electrical trades buy what they install RST-exempt and charge RST on the whole contract;
everything they use themselves carries RST as a cost (Bulletin 031; gap analysis section A).
Each bill line has `taxUse` (`rst.js billLineTaxUse`, the only place the default lives):

| line | default | RST on it |
| --- | --- | --- |
| `material` | resale | none should be charged (we gave our RST number). If the supplier charged it, it is **recoverable**: flagged "Supplier charged RST on resale materials. Ask them for a credit." and kept out of cost (QuickBooks: `account.rstRecoverable`). "Write off to cost" moves it into the line's cost when the supplier won't credit it. A refund of tax paid in error may need a separate refund application; the time limit is VERIFY. |
| `subcontract` | resale only from an electrical or mechanical subtrade (`vendors.meSubtrade`); otherwise own use | resale: as material. Own use: a cost. |
| `equipment`, `other` | own use | a cost (tools, trucks, meters, safety gear, rentals, insurance, office, software subscriptions) |

Self-assessment (RST view, `#/reports/rst`): RST is owed on goods bought exempt and then used by
the company: own-use stock moves and material requests (shop, truck, tools, no charge), and own-use
bill lines in Manitoba with no RST charged (typically out-of-province or online sellers). Material
used on warranty and callback jobs is self-assessed as own use (VERIFY with the accountant when the
warranty was priced into an RST-charged contract). Shrinkage found by a stock count is not
self-assessed (VERIFY). GST, HST and QST are never a cost (input tax credits). QuickBooks Online
files the Manitoba RST return but does not include self-assessed RST, so the view and the month-end
export say "Add this to your RST return".

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
`taxes: [{ id, label, pct, baseCents, cents, note, deferredCents }]` and `taxCents` (their sum).

Release 1 fields (all optional; old records stay valid):

```
lines[]: costCodeId, taxOff: ['GST'|'HST'|'PST'|'RST'|'QST'|'*'] (labour and other lines only),
         passThrough (other lines only), lineType: 'deposit'|'holdback'|'interest'|null,
         depositInvoiceId (a deposit application)
document: taxExemptNumber, taxExemptBasis, taxExemptDetails { name, registryNo, band, reserve,
          farmCertNo, department, endCustomer, note }, exemptionConfirmed { by, at, from? }
invoice:  kind: 'standard'|'deposit'|'progress'|'holdback-release'|'credit'|'interest',
          depositModel: 'prepayment'|'security', forfeitedOn,
          holdback { pct, cents, deferTaxIds[], excludePassThrough, retainedByCustomerCents, ... },
          holdbackInvoiceIds[], creditsInvoiceId, creditReason,
          creditTaxSnapshot { taxProvince, taxTreatment, taxes, taxPct, taxNoneReason, taxExempt*,
                              invoiceNumber, invoiceDate }
job:      taxExempt { basis, number, endCustomer, details, confirmedBy, confirmedAt }
client:   taxExemptNumber, taxExemptBasis, taxExemptProvince, taxExemptDetails, taxExemptCheckedAt
          (evidence only)
```

`docTotals` also returns `workSubtotalCents` (lines with no `lineType`, markup included),
`holdbackBaseCents`, `holdbackCents`, `netSubtotalCents` (`subtotalCents - holdbackCents`;
`totalCents = netSubtotalCents + taxCents`), `passThroughCents`, `depositCents`,
`holdbackLineCents` and `interestCents`. `lineTaxed(line, tax)` says whether one tax applies to one
line. Revenue for reports is `revenueCents(inv)`: the work lines, gross of holdback, on standard,
progress and credit invoices; never deposit, release or interest lines (a forfeited prepayment
counts on its `forfeitedOn`).

Settings: `company.province`, `company.gstHstNo`, `company.pstNo`,
`tax: { mode: 'province' | 'custom', treatment, custom: [{ label, pct, applies }] }`.
The policy rules read here live in the rules table (Books → Rules): `tax.CA.gstHoldbackAtRelease`,
`tax.MB.rstHoldbackAtRelease`, `tax.SK.pstHoldbackAtRelease`, `tax.BC.pstHoldbackAtRelease`,
`tax.MB.passThroughAllowed`, `holdback.excludePassThrough` (defaults in `money.js
MONEY_POLICY_DEFAULTS`, the seeded values).

## Registration numbers

- GST/HST: 9-digit business number + RT + 4 digits, e.g. `123456789 RT0001`. It must appear
  on invoices of $100 or more for the customer to claim input tax credits (CRA RC4022).
  Printed on every invoice and estimate when set.
- BC PST: `PST-1234-5678` (gov.bc.ca). SK vendor's licence (7 digits), MB RST number
  (7 digits, often written `123456-7`; Bulletin 004 asks for the customer's number on the
  invoice) and QST (`1234567890TQ0001`): formats from third-party sources. Exemption numbers are
  checked against these formats as a **warning only** (`exemptNumberProblem`), never refused.
  First Nations registry numbers and farm certificates are not checked. VERIFY.
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
- Manitoba Bulletins 004 (exemption numbers on invoices), 030 (rev. July 2026) and 033, and RST
  Guide 700: cited by number in the gap analysis; pull current copies from
  https://www.gov.mb.ca/finance/taxation/ before relying on their wording (VERIFY).
- Excise Tax Act s.168(3)(c) (GST at substantial completion), s.168(7) (holdback: GST payable
  when the holdback is due), s.168(9) (security deposits), s.232 (credit notes):
  https://laws-lois.justice.gc.ca/eng/acts/E-15/
- Indian Act s.87 (property of a Status Indian or band on reserve): https://laws-lois.justice.gc.ca/eng/acts/I-5/section-87.html
- Revenu Québec, GST and QST rates: https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/tables-of-gst-and-qst-rates/
- CRA RC4022, general information for GST/HST registrants: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4022/general-information-gst-hst-registrants.html
- New HST Regulations SOR/2010-117: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2010-117/page-1.html
- GST/HST Memorandum 3-3-6: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6/plc-spply-prvnc-gnrl-rls-fr-srvcs.html

# Month-end: the cutoff export and inventory

Release 1 ([build contract](../releases/r1-get-paid.md) 8.3, 8.4). **Month-end** (`#/monthend`, Pro)
gives the accountant what the books themselves do not show at the end of a month: revenue earned but
not billed, costs incurred but not billed by suppliers, payroll owed, and the balances that sit
outside the invoices. Then close the month on **Books → Closing date** ([period lock](period-lock.md)).

Nothing is pushed to QuickBooks: the journal is a suggestion the accountant enters as of the cutoff
and **reverses on the 1st**.

## The cutoff

Pick the cutoff (the end of last month by default). The screen shows each block with its detail, prints,
and exports one CSV.

| block | what it is |
| --- | --- |
| Revenue not billed yet | fixed-price jobs from WIP as of the cutoff ([job costing](job-costing.md)): under billed and over billed; T&M jobs: approved time and material not billed yet, at sell. Approved change orders not billed are listed for information only (WIP's contract already includes them). |
| Received, not billed | purchase-order lines received (in the field or marked received) and not yet on a supplier bill, at the PO price |
| Payroll not paid yet | hours worked on or before the cutoff that are in no exported payroll run, at the wage on that day plus burden (CPP, EI, WCB, benefits). Vacation and holiday pay are added only when Books → Payroll says they accrue; paid on each cheque (the default) they are not. |
| Balances | holdback receivable (holdback on progress invoices less releases), customer deposits not yet applied, on-account credit, disputed amounts, the RST to self-assess this month, and bad-debt credit notes (GST and RST relief: ask the accountant) |
| Inventory by location | each location's stock on the cutoff at the moving average cost then |

### The journal (suggested)

Each entry is reversed on the 1st. Account names are these labels (or the QuickBooks names when they
are mapped):

| debit | credit | for |
| --- | --- | --- |
| Costs and estimated earnings in excess of billings | Contract revenue | under-billed fixed-price work |
| Contract revenue | Billings in excess of costs and estimated earnings | over-billed fixed-price work |
| Accounts receivable, unbilled | Contract revenue | T&M not billed yet |
| Job cost | Accrued liabilities | material received, supplier bill not in |
| Wages and burden | Accrued payroll | hours worked, not paid |
| Expense or job cost | RST payable | self-assessed RST: add it to your RST return |

## Inventory cost

- **Moving weighted average**: each receipt through a purchase order (the receiving route) sets
  `(on hand × average + quantity × PO price) ÷ (on hand + quantity)`. Material taken from stock onto a
  job is costed at the average when it moves (the server stamps it; a device cannot set it). Items
  never received through a purchase order use their price-book cost.
- **Valuation** (Inventory → Valuation): each location's quantity on a day (today's stock with later
  moves rolled back) × the average cost then. The month-end export uses the cutoff day.

## Count sheets

Inventory → **Counts** → **New count**: pick the location (a van, the shop). The sheet lists what
should be there; tick "List every item" to count things not expected there too.

1. Count on a phone: type what is there. It saves as you go and works offline.
2. **Done counting** stamps the moment it was counted.
3. A manager (inventory permission) **Posts** it: one adjustment move per difference, dated the count
   date, counted against what the location held **when it was counted** (stock now less moves made
   after that moment), so a van that kept working while people counted is not thrown off. Posting
   adds or takes the difference from that location's stock.
4. A count dated in a closed period posts on the first open day (it is flagged late on Books).

Adjustments are never own use (shrinkage is not self-assessed; VERIFY with the accountant). The owner
of a van (the employee whose truck carries that van's stock) may count it; posting stays with the
office and managers.

## VERIFY

- Whether vacation and holiday pay paid on each cheque belong in the accrued payroll for hours not
  yet paid (Fishtape leaves them out unless they accrue, contract 8.3).
- The treatment of bad-debt credit notes (GST s.231, Manitoba RST refund): listed, no tax computed.
- Inventory cost method for the books (moving weighted average, question 29).

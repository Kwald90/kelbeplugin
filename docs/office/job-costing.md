# Job costing: what a job really cost

Release 1 ([build contract](../releases/r1-get-paid.md) 3.5, 6, 11). **Job costing** (`#/reports`) is
for the office: people who see money (owners, admins, office; foremen only when the company lets them
see costs). It works offline on the iPad from the synced records, and the server's reports
(`/api/v1/reports/*`) compute the same numbers with the same code, so a CSV the accountant gets and
the screen always agree.

## What counts as cost

| source | how it is costed |
| --- | --- |
| time on the job | each hour at the person's **cost per paid hour on that day**: the wage in force that day (Employees → **New rate from…**; a raise in November leaves September alone), plus vacation and holiday pay, CPP, EI, WCB and benefits (below). Travel counts. |
| overtime | the minutes that crossed the daily or weekly limit (Time clock → Settings rule, in time order, across every job that week) add half the wage plus its statutory share, on the entry that crossed: a 6-hour morning on job A then 4 hours on job B puts the 2 overtime hours on job B |
| corrections | an office correction counts at the rate on its work day; a negative one reduces cost |
| trucks | a truck on a time entry (the clock-in takes the person's truck) is charged once per truck and day: an hour rate over the hours anyone had it out (two people in one truck count once), or a day rate once, split across that day's jobs by hours |
| equipment use | a use record at the equipment's rate that day; a ticket's record for a truck already on the clock that day is ignored |
| bills and receipts | entered (open or paid) bill lines for the job. **Resale** lines (material you install) carry no RST: RST a supplier charged on them is recoverable, not cost, and is flagged "Supplier charged RST on resale materials. Ask them for a credit." (**Write off to cost** when the supplier won't). **Own-use** lines (tools, supplies, a non-M&E subcontract) carry their share of the bill's PST/RST. GST, HST and QST are never cost. Lines received into stock are inventory (the move onto the job carries the cost). Truck lines (fuel, repairs, lease) are the truck's cost, never a job's. A supplier credit follows the original line's job. |
| stock | moves from a van or the shop onto the job, at the cost the server stamped (the moving average); material returned to a van or the shop comes off |
| own use on warranty work | material onto a warranty, callback or unbilled job also carries the RST you self-assess on it |
| material requests | fulfilled requests no stock move, bill or purchase order covers (never counted twice) |
| received, not billed | purchase-order lines received to the job and not billed yet, at the PO price ("accrued"); replaced by the bill when it arrives |
| committed | open and sent purchase-order lines not received or billed: shown beside cost, **never added** |

Records without a cost code group as "Uncoded".

## Burden

Each employee's cost per paid hour (`lib/burden.js`):

- **Wage**: the rate history on the day, else the current rate.
- **Vacation pay**: 4% (6% from the fifth anniversary of the hire date), **construction holiday pay**
  4%, both from the rules table (Books → Rules); an employee's own figure wins.
- **CPP, CPP2, EI and WCB** are worked out on the year's expected earnings (wage × paid hours a year,
  plus vacation and holiday pay, which CPP, EI and WCB also apply to) and stop at their yearly
  maximums, so a high earner is not over-costed late in the year. The values (rates, YMPE, YAMPE,
  basic exemption, EI maximum and employer factor, the WCB maximum) come from the rules table, loaded
  by Fishtape HQ each January. Your WCB rate is a company rule (Books → Rules → "Your WCB rate"), or
  set per employee. The health and education levy applies only when you set it.
- **While a year's values are not loaded** (or a value is still "verify"), the statutory part uses
  your flat percentage (Job costing → Rates → "Flat statutory % (fallback)") and every screen says so:
  "CPP/EI 2027 values not loaded; using your flat 12%". Last year's maximums are never reused.
  Without a flat percentage the warning says the cost is understated.
- **Cost per productive hour** = cost per paid hour ÷ (1 − non-productive %). Non-productive time is
  shop, school, callbacks and unbilled travel (10% unless you change it); travel already charged to
  jobs is not included.

When nothing is set up, labour shows at the bare wage and the screens say so ("no burden data").

## The screens

- **Job profit** (`#/reports`): for a period, each job's revenue (invoice work lines before tax, gross
  of holdback; never deposits, holdback releases or interest; credit notes come off), cost (accrued
  included), gross profit, margin, budget margin and committed. Export CSV.
- **One job** (`#/reports/jobs/<id>`): cost by type (labour split into wages, burden and overtime
  premium; trucks), budget against actual by cost code, the accrued and committed PO lines.
- **WIP** (`#/reports/wip`, Pro): see below.
- **RST** (`#/reports/rst`): the self-assessment worksheet, below.
- **Price variances** (`#/reports/variances`): bill lines priced more than 2% and $1.00 above the
  purchase order (or the wholesaler's job quote on it, "Quote no." on the PO line) or, without an
  order, the price book's cost. Bills never change the price book. **Checked** records who looked
  and why (also on the bill itself).
- **Rates** (`#/reports/rates`): burden per field employee, the labour cost per productive hour, the
  break-even and target rates next to your labour rate, trucks and equipment with their rate history
  (a new rate from a date leaves earlier days alone) and what each recovered this year against its
  fuel, repair and lease bills, and the costing settings.

## Budget and contract value

- **Contract value**: the job's contract value when typed, else the latest accepted estimate that is
  not superseded (a signed estimate's revision replaces it), plus change orders approved on or before
  the day (by approval date).
- **Budget**: the estimate's labour hours at the burdened cost per productive hour on the day it was
  accepted (the same basis as actual labour), material at the price-book cost, other and subcontract
  lines at their cost (else the price over 1 + markup). Stored on the job when the estimate is
  accepted; older jobs work it out. A change order's budget is its estimated cost when the office
  gives one, else its amount in the same proportion as the estimate.
- **Estimated cost**: the job's override, else the budget plus change-order budgets.

## Break-even billing rate

Field roles only (electricians, apprentices, foremen): their yearly cost (cost per paid hour × paid
hours) plus the year's overhead, over their productive hours. Office wages belong in overhead; leave
out truck and equipment costs recovered through equipment rates (equipment recovery is shown beside,
never added). Without overhead the figure is labelled **"Labour cost only, not break-even"**. Target
rate = break-even ÷ (1 − target margin).

## WIP (work in progress)

As of a day, for every open job (scheduled, in progress or on hold; service calls, warranty,
callback and unbilled jobs left out):

- **Fixed price**: percent complete = cost to date ÷ estimated cost, at most 100% (or the job's own
  percentage, for material stored on site). Earned = contract × percent complete. When the job is
  heading for a loss (contract below estimated cost) earned = cost to date + the projected loss: the
  whole loss is taken now (ASPE 3400), shown as a loss provision. Billed = revenue to that day.
  Over billed (a liability) and under billed (an asset) are the differences.
- **Time and material**: earned = billed + approved time and material not billed yet, at sell.
- A second table lists contracts completed this fiscal year (contract, cost, gross profit) for the
  bonding company. The fiscal year starts on 1 January unless the company sets another day.

## RST self-assessment and supplier credits

Manitoba (Bulletin 031): material an electrical contractor installs under a contract is bought for
resale, so suppliers should not charge RST on it; what the company uses itself carries RST. Each bill
line is **Resale** or **Own use**. The default: material resale; a subcontract resale only from an
electrical or mechanical subcontractor whose work you resell (tick "M&E subtrade" on the supplier),
otherwise own use; equipment and other own use. Change it per line.

Stock moves and material requests can be tagged **own use** with a reason (warranty, no charge, shop,
truck, tools, other); a warranty, callback or unbilled job's material is own use by default. Count
adjustments are never own use.

The RST view (default last month) lists:

1. **Self-assess**: own-use stock moves and requests at cost × the RST rate that day, and own-use bill
   lines with no PST/RST charged (typical of out-of-province sellers). A request covered by a move or a
   bill counts once; an own-use line already charged RST is not self-assessed.
2. **Credits to claim from suppliers**: resale lines a supplier charged RST on, not written off.

It files nothing. QuickBooks Online prepares the RST return and does not include self-assessed RST:
**add it to your RST return**; suggested entry Dr expense (or job cost) / Cr RST payable. Export the
CSV for the accountant.

## Field receiving

**Receive a delivery** (Material requests) and **Receive** (Inventory → Stock; Purchase orders →
**Mark received**) list open purchase-order lines with quantities only: the crew never see a price.
Type what arrived and where it goes: **into a location** (adds to that location's stock and moves the
item's moving average cost) or **onto the job** on the order. It needs a connection; the server records
the receipt (the PO's received quantity, a receive move at the PO price). In the demo it is recorded on
the device.

## VERIFY

- Self-assessed RST on warranty material when the warranty was priced into an RST-charged contract
  (Fishtape self-assesses it, question 28), and whether shrinkage found by a count is self-assessed
  (Fishtape: not).
- The overtime premium is half the wage plus its statutory share; vacation pay on overtime earnings
  is not added (most payroll providers include it).
- Equipment use in hours against a day rate (and the other way) converts at 8 hours a day.
- The fiscal year start for the completed-contracts table (1 January unless set).

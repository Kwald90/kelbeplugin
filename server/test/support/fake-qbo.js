// An in-memory QuickBooks Online (docs/integrations/quickbooks.md 11.1) for unit, route and e2e
// tests. Use it through setFetch (fake.fetch, which also accepts Intuit's real URLs) or as a real
// HTTP server (fake.listen(), then QBO_API_BASE / QBO_OAUTH_BASE). Nothing here reaches Intuit.
//
// It models: OAuth (authorize, one-time codes, refresh rotation, revoke at grant level, the hard
// expiry field, forced invalid_grant and invalid_client), Canadian companies with CompanyInfo,
// Preferences, reference lists and GST/PST MB tax maths, create / read / full and sparse update
// with SyncToken (5010 when stale), delete and void, requestid replay (window off by default),
// queries, CDC with the 1,000-object cap and deleted stubs, batch, Attachable upload, payments
// applied to several invoices and credit memos with unapplied amounts, fault injection (429, 5xx,
// 401, latency past the timeout, a dropped answer after the write landed, 5030, closed books,
// amount rule, open balance on deactivation, void of a deposited payment), a CloudEvents webhook
// emitter with signatures, and a call log with Core and CorePlus counts.
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const INTUIT_HOSTS = new Set(['appcenter.intuit.com', 'oauth.platform.intuit.com', 'developer.api.intuit.com',
  'quickbooks.api.intuit.com', 'sandbox-quickbooks.api.intuit.com']);

export const ENTITIES = ['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode', 'TaxRate', 'TaxAgency', 'PaymentMethod', 'Class',
  'Department', 'Term', 'Estimate', 'Invoice', 'Payment', 'CreditMemo', 'Deposit', 'Bill', 'BillPayment', 'Purchase', 'PurchaseOrder',
  'TimeActivity', 'Transfer', 'Attachable', 'JournalEntry'];
const BY_LOWER = Object.fromEntries(ENTITIES.map((e) => [e.toLowerCase(), e]));
const NAME_LIST = new Set(['Customer', 'Vendor', 'Employee']);
const SALES = new Set(['Invoice', 'Estimate', 'CreditMemo']);
const PURCHASES = new Set(['Bill', 'Purchase', 'PurchaseOrder']);
const TXN = new Set([...SALES, ...PURCHASES, 'Payment', 'Deposit', 'TimeActivity', 'Transfer', 'JournalEntry', 'BillPayment']);
const DOC_NUMBER_UNIQUE = new Set(['Invoice', 'Estimate', 'CreditMemo']);
const SPARSE_OK = new Set(['Customer', 'Invoice', 'Estimate', 'Deposit', 'Vendor', 'Item', 'Payment', 'Bill', 'Purchase', 'PurchaseOrder', 'TimeActivity', 'Transfer', 'Employee', 'CreditMemo']);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clone = (o) => (o === undefined ? undefined : structuredClone(o));
/** A copy as QuickBooks would answer it: without the fake's own _flags. */
const pub = (o) => {
  if (o === undefined || o === null) return o;
  const x = structuredClone(o);
  for (const k of Object.keys(x)) if (k.startsWith('_')) delete x[k];
  return x;
};
const hex = (n = 16) => randomBytes(n).toString('hex');
const refVal = (r) => (r && typeof r === 'object' ? String(r.value ?? '') : r == null ? '' : String(r));

/** A QBO fault answer. */
class Fault extends Error {
  constructor(status, code, message, detail = '', type = 'ValidationFault') {
    super(message);
    Object.assign(this, { status, code: String(code), detail, type });
  }
  body() {
    return { Fault: { Error: [{ Message: this.message, Detail: this.detail, code: this.code }], type: this.type }, time: new Date().toISOString() };
  }
}
const fault = (code, message, detail, status = 400, type = 'ValidationFault') => new Fault(status, code, message, detail, type);

/**
 * @param {{ clientId?: string, clientSecret?: string, batchMax?: number, requestIdWindowMs?: number, rotateRefresh?: boolean,
 *   grantLevelRevoke?: boolean, strictLineAmounts?: boolean, hardExpiresIn?: number, accessExpiresIn?: number }} [opts]
 */
export function createFakeQbo(opts = {}) {
  const app = { clientId: opts.clientId || `fakeclient${hex(6)}`, clientSecret: opts.clientSecret || hex(20) };
  let offset = 0;
  const now = () => Date.now() + offset;
  const iso = (t = now()) => new Date(t).toISOString();

  const state = {
    batchMax: opts.batchMax ?? 30,
    requestIdWindowMs: opts.requestIdWindowMs ?? 0,
    rotateRefresh: opts.rotateRefresh ?? true,
    grantLevelRevoke: opts.grantLevelRevoke ?? true,
    strictLineAmounts: opts.strictLineAmounts ?? true,
    hardExpiresIn: opts.hardExpiresIn ?? 5 * 365 * 86400,
    accessExpiresIn: opts.accessExpiresIn ?? 3600,
    nextConsent: null,
    codes: new Map(),
    grants: new Map(),      // realmId -> { id, alive }
    refresh: new Map(),     // token -> { realmId, grantId, valid }
    access: new Map(),      // token -> { realmId, grantId, expiresAt }
    realms: new Map(),
    faults: [],
    tokenFaults: [],
    calls: [],
    unexpected: [],
    revoked: [],
    tokenCalls: [],
    dropWebhooks: new Set(),
    listenHost: null,
    beforeToken: null,
  };

  // ---- companies ----------------------------------------------------------------------------

  function company(realmId) {
    const c = state.realms.get(String(realmId));
    if (!c) throw fault('3200', 'Unknown realm', 'No company for this realm', 401, 'AUTHENTICATION');
    return c;
  }

  /**
   * A QuickBooks company with a Canadian (Manitoba) starting chart: GST/PST MB at 5% + 7%, GST,
   * Exempt, Zero-rated, Out of Scope, a legacy 8% PST code, accounts, payment methods, a term and
   * two items.
   */
  function addCompany(realmId, o = {}) {
    const id = String(realmId);
    const c = {
      realmId: id, nextId: 1, objects: Object.fromEntries(ENTITIES.map((e) => [e, new Map()])), deleted: [],
      requestIds: new Map(), disabled: new Set(o.disabled || []), bookCloseDate: o.bookCloseDate || null, events: [], attachments: new Map(),
    };
    c.info = {
      Id: '1', SyncToken: '0', CompanyName: o.name || 'Sandbox Company_CA', LegalName: o.name || 'Sandbox Company_CA',
      Country: o.country ?? 'CA', CompanyAddr: { City: 'Winnipeg', CountrySubDivisionCode: o.province || 'MB', Country: o.country ?? 'CA', PostalCode: 'R3C 0A1' },
      NameValue: [{ Name: 'OfferingSku', Value: o.edition || 'QuickBooks Online Plus' }, { Name: 'PayrollFeature', Value: String(Boolean(o.payroll)) }],
      MetaData: { CreateTime: iso(), LastUpdatedTime: iso() },
    };
    c.prefs = {
      Id: '1', SyncToken: '0',
      TaxPrefs: { UsingSalesTax: o.salesTax ?? true },
      SalesFormsPrefs: { CustomTxnNumbers: o.customTxnNumbers ?? true, AllowEstimates: true, AllowDiscount: true, AllowDeposit: true },
      VendorAndPurchasesPrefs: { UseCustomTxnNumbers: false },
      AccountingInfoPrefs: { ClassTrackingPerTxn: false, ClassTrackingPerTxnLine: false, TrackDepartments: false, BookCloseDate: o.bookCloseDate || undefined },
      CurrencyPrefs: { HomeCurrency: { value: o.currency ?? 'CAD' }, MultiCurrencyEnabled: false },
      TimeTrackingPrefs: {},
      OtherPrefs: { NameValue: [{ Name: 'ProjectsEnabled', Value: 'false' }] },
      MetaData: { CreateTime: iso(), LastUpdatedTime: iso() },
    };
    state.realms.set(id, c);
    if (o.seed !== false) seedCanada(c);
    c.events.length = 0;
    return c;
  }

  function seedCanada(c) {
    const put = (e, obj) => insert(c, e, obj, { silent: true });
    const cra = put('TaxAgency', { DisplayName: 'Canada Revenue Agency', LastFileDate: null });
    const mb = put('TaxAgency', { DisplayName: 'Manitoba Finance', LastFileDate: null });
    const rate = (Name, RateValue, agency, extra = {}) => put('TaxRate', { Name, RateValue, AgencyRef: { value: agency.Id }, Active: true, ...extra });
    const gst = rate('GST', 5, cra);
    const pst = rate('PST (MB)', 7, mb);
    const pst8 = rate('PST (MB) 8%', 8, mb, { Active: false });
    const zero = rate('GST zero-rated', 0, cra);
    const exempt = rate('GST exempt', 0, cra);
    const list = (...rs) => ({ TaxRateDetail: rs.map((r) => ({ TaxRateRef: { value: r.Id, name: r.Name }, TaxTypeApplicable: 'TaxOnAmount', TaxOrder: 0 })) });
    c.seed = {
      taxCodes: {
        gstPst: put('TaxCode', { Name: 'GST/PST MB', Active: true, Taxable: true, SalesTaxRateList: list(gst, pst), PurchaseTaxRateList: list(gst, pst) }),
        gst: put('TaxCode', { Name: 'GST', Active: true, Taxable: true, SalesTaxRateList: list(gst), PurchaseTaxRateList: list(gst) }),
        exempt: put('TaxCode', { Name: 'Exempt', Active: true, Taxable: false, SalesTaxRateList: list(exempt), PurchaseTaxRateList: list() }),
        zero: put('TaxCode', { Name: 'Zero-rated', Active: true, Taxable: false, SalesTaxRateList: list(zero), PurchaseTaxRateList: list(zero) }),
        oos: put('TaxCode', { Name: 'Out of Scope', Active: true, Taxable: false, SalesTaxRateList: list(), PurchaseTaxRateList: list() }),
        old8: put('TaxCode', { Name: 'GST/PST MB 8% (old)', Active: true, Taxable: true, SalesTaxRateList: list(gst, pst8), PurchaseTaxRateList: list(gst, pst8) }),
      },
      taxRates: { gst, pst, pst8, zero, exempt },
      agencies: { cra, mb },
    };
    const acct = (Name, AccountType, AccountSubType, extra = {}) => put('Account', { Name, AccountType, AccountSubType, Active: true, CurrentBalance: 0, ...extra });
    c.seed.accounts = {
      income: acct('Sales', 'Income', 'SalesOfProductIncome'),
      cogs: acct('Cost of Goods Sold', 'Cost of Goods Sold', 'SuppliesMaterialsCogs'),
      materials: acct('Job Materials', 'Expense', 'SuppliesMaterials'),
      undeposited: acct('Undeposited Funds', 'Other Current Asset', 'UndepositedFunds'),
      bank: acct('Chequing', 'Bank', 'Checking'),
      stripe: acct('Stripe', 'Bank', 'Checking'),
      stripeFees: acct('Stripe Fees', 'Expense', 'BankCharges'),
    };
    c.seed.paymentMethods = Object.fromEntries(['Cash', 'Cheque', 'Credit Card', 'E-Transfer'].map((n) => [n, put('PaymentMethod', { Name: n, Active: true, Type: n === 'Credit Card' ? 'CREDIT_CARD' : 'NON_CREDIT_CARD' })]));
    c.seed.terms = { net30: put('Term', { Name: 'Net 30', Active: true, DueDays: 30 }) };
    c.seed.items = {
      materials: put('Item', { Name: 'Materials', Type: 'NonInventory', Active: true, IncomeAccountRef: { value: c.seed.accounts.income.Id }, ExpenseAccountRef: { value: c.seed.accounts.cogs.Id } }),
      labour: put('Item', { Name: 'Labour', Type: 'Service', Active: true, IncomeAccountRef: { value: c.seed.accounts.income.Id } }),
    };
  }

  // ---- objects ------------------------------------------------------------------------------

  const store = (c, entity) => c.objects[entity];
  const active = (o) => o.Active !== false;

  function emit(c, entity, op, id, deletedId = null) {
    c.events.push({ entity, op, id: String(id), deletedId: deletedId == null ? null : String(deletedId), time: iso() });
  }

  function touch(obj, { bumpToken = true } = {}) {
    if (bumpToken) obj.SyncToken = String(Number(obj.SyncToken || 0) + 1);
    obj.MetaData = { ...(obj.MetaData || {}), LastUpdatedTime: iso() };
  }

  function checkName(c, entity, obj, selfId = null) {
    if (NAME_LIST.has(entity)) {
      const name = String(obj.DisplayName ?? [obj.GivenName, obj.FamilyName].filter(Boolean).join(' ') ?? '').trim().toLowerCase();
      if (!name) throw fault('2020', 'Required param missing, need to supply the required value for the API', 'Required parameter DisplayName is missing in the request');
      for (const e of NAME_LIST) {
        for (const o of store(c, e).values()) {
          if (o.Id === selfId && e === entity) continue;
          if (String(o.DisplayName || '').trim().toLowerCase() === name) {
            throw fault('6240', 'Duplicate Name Exists Error', `The name supplied already exists. : Another customer, vendor or employee is already using this name. Id=${o.Id}`);
          }
        }
      }
    }
    if (entity === 'Item') {
      const name = String(obj.Name || '').trim().toLowerCase();
      for (const o of store(c, 'Item').values()) {
        if (o.Id !== selfId && String(o.Name || '').trim().toLowerCase() === name) throw fault('6240', 'Duplicate Name Exists Error', `The name supplied already exists. : Id=${o.Id}`);
      }
    }
  }

  function checkDocNumber(c, entity, obj, selfId = null) {
    if (!DOC_NUMBER_UNIQUE.has(entity) || !obj.DocNumber) return;
    for (const o of store(c, entity).values()) {
      if (o.Id !== selfId && o.DocNumber === obj.DocNumber && !o._voided) {
        throw fault('6140', 'Duplicate Document Number Error', `Duplicate Document Number Error : You must specify a different number. This number has already been used. DocNumber=${obj.DocNumber}`);
      }
    }
  }

  function checkBooks(c, entity, obj) {
    if (!TXN.has(entity) || !c.bookCloseDate || !obj.TxnDate) return;
    if (String(obj.TxnDate) <= String(c.bookCloseDate)) {
      throw fault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: The account period has closed and the books are locked for this date.');
    }
  }

  function checkAmounts(entity, obj) {
    if (!state.strictLineAmounts || !SALES.has(entity)) return;
    for (const l of obj.Line || []) {
      const d = l.SalesItemLineDetail;
      if (!d || d.Qty == null || d.UnitPrice == null || l.Amount == null) continue;
      if (Math.abs(r2(Number(d.Qty) * Number(d.UnitPrice)) - Number(l.Amount)) > 0.005) {
        throw fault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: Amount is not equal to UnitPrice x Qty. Supplied value:' + l.Amount);
      }
    }
  }

  function rateOf(c, id) {
    const r = store(c, 'TaxRate').get(String(id));
    return r ? Number(r.RateValue) : 0;
  }

  /** Tax per rate from line codes, summed then rounded per rate (Intuit's way, 4.8). */
  function computeTax(c, entity, obj, requested) {
    const purchase = PURCHASES.has(entity);
    const mode = obj.GlobalTaxCalculation || (c.prefs.TaxPrefs.UsingSalesTax ? 'TaxExcluded' : 'NotApplicable');
    obj.GlobalTaxCalculation = mode;
    const lines = (obj.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
    const amountOf = (l) => Number(l.Amount || 0);
    const subtotal = r2(lines.reduce((s, l) => s + (l.DetailType === 'DescriptionOnly' ? 0 : amountOf(l)), 0));
    if (mode === 'NotApplicable') { obj.TxnTaxDetail = { TotalTax: 0 }; return { subtotal, tax: 0 }; }
    const byRate = new Map();
    for (const l of lines) {
      const det = l.SalesItemLineDetail || l.ItemBasedExpenseLineDetail || l.AccountBasedExpenseLineDetail || l.DiscountLineDetail;
      const codeId = refVal(det?.TaxCodeRef);
      if (!codeId) continue;
      const code = store(c, 'TaxCode').get(codeId);
      if (!code) throw fault('2500', 'Invalid Reference Id', `Invalid Reference Id : TaxCode assigned is invalid`);
      const rates = (purchase ? code.PurchaseTaxRateList : code.SalesTaxRateList)?.TaxRateDetail || [];
      const totalPct = rates.reduce((s, r) => s + rateOf(c, refVal(r.TaxRateRef)), 0);
      for (const r of rates) {
        const id = refVal(r.TaxRateRef);
        const pct = rateOf(c, id);
        const base = mode === 'TaxInclusive' ? (amountOf(l) * 100) / (100 + totalPct) : amountOf(l);
        const cur = byRate.get(id) || { base: 0, pct };
        cur.base += base;
        byRate.set(id, cur);
      }
    }
    const taxLines = [];
    const overrides = new Map((requested?.TaxLine || []).map((tl) => [refVal(tl.TaxLineDetail?.TaxRateRef), Number(tl.Amount)]));
    for (const [id, { base, pct }] of byRate) {
      let amount = r2((base * pct) / 100);
      if (overrides.has(id)) {
        const rateObj = store(c, 'TaxRate').get(id);
        if (rateObj?.ReadOnly) throw fault('6000', 'A business validation error has occurred while processing your request', 'Tax override not allowed for a read-only tax rate (-37100)');
        amount = r2(overrides.get(id));
      }
      taxLines.push({ Amount: amount, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: id }, PercentBased: true, TaxPercent: pct, NetAmountTaxable: r2(base) } });
    }
    const tax = r2(taxLines.reduce((s, t) => s + t.Amount, 0));
    obj.TxnTaxDetail = { TotalTax: tax, TaxLine: taxLines };
    return { subtotal, tax: mode === 'TaxInclusive' ? 0 : tax };
  }

  function computeTotals(c, entity, obj, requestedTax) {
    if (SALES.has(entity) || PURCHASES.has(entity)) {
      const { subtotal, tax } = computeTax(c, entity, obj, requestedTax);
      obj.TotalAmt = obj._voided ? 0 : r2(subtotal + tax);
    }
    if (entity === 'Deposit') obj.TotalAmt = r2((obj.Line || []).reduce((s, l) => s + Number(l.Amount || 0), 0));
    if (entity === 'Payment') obj.TotalAmt = r2(Number(obj.TotalAmt ?? (obj.Line || []).reduce((s, l) => s + Number(l.Amount || 0), 0)));
    if (entity === 'Bill') obj.Balance = obj._voided ? 0 : r2(obj.TotalAmt - Number(obj._paid || 0));
  }

  const linked = (l, type) => (l.LinkedTxn || []).find((t) => t.TxnType === type);

  /** Invoice balances, credit memo remaining credit, payment unapplied amounts, customer balances. */
  function rebalance(c) {
    const applied = new Map();
    const credit = new Map();
    for (const p of store(c, 'Payment').values()) {
      let toInvoices = 0;
      let fromCredits = 0;
      for (const l of p.Line || []) {
        const inv = linked(l, 'Invoice');
        const cm = linked(l, 'CreditMemo');
        if (inv) { applied.set(inv.TxnId, r2((applied.get(inv.TxnId) || 0) + Number(l.Amount || 0))); toInvoices += Number(l.Amount || 0); }
        if (cm) { credit.set(cm.TxnId, r2((credit.get(cm.TxnId) || 0) + Number(l.Amount || 0))); fromCredits += Number(l.Amount || 0); }
      }
      p.UnappliedAmt = r2(Number(p.TotalAmt || 0) - toInvoices + fromCredits);
    }
    for (const inv of store(c, 'Invoice').values()) {
      const bal = inv._voided ? 0 : r2(Number(inv.TotalAmt || 0) - Number(inv.Deposit || 0) - (applied.get(inv.Id) || 0));
      if (inv.Balance !== undefined && inv.Balance !== bal) touch(inv);
      inv.Balance = bal;
    }
    for (const cm of store(c, 'CreditMemo').values()) cm.RemainingCredit = r2(Number(cm.TotalAmt || 0) - (credit.get(cm.Id) || 0));
    const custBal = new Map();
    for (const inv of store(c, 'Invoice').values()) {
      const k = refVal(inv.CustomerRef);
      custBal.set(k, r2((custBal.get(k) || 0) + Number(inv.Balance || 0)));
    }
    for (const cu of store(c, 'Customer').values()) cu.Balance = custBal.get(cu.Id) || 0;
  }

  function depositedPayment(c, id) {
    for (const d of store(c, 'Deposit').values()) for (const l of d.Line || []) if (linked(l, 'Payment')?.TxnId === id) return true;
    return false;
  }

  function insert(c, entity, body, { silent = false } = {}) {
    if (c.disabled.has(entity)) throw fault('5030', 'Feature Not Supported', `Feature Not Supported : ${entity} is not available in this QuickBooks edition`);
    const obj = clone(body);
    delete obj.Id; delete obj.SyncToken; delete obj.sparse;
    const requestedTax = obj.TxnTaxDetail;
    checkName(c, entity, obj);
    checkDocNumber(c, entity, obj);
    checkBooks(c, entity, obj);
    checkAmounts(entity, obj);
    if (NAME_LIST.has(entity) && !obj.DisplayName) obj.DisplayName = [obj.GivenName, obj.FamilyName].filter(Boolean).join(' ');
    if (obj.Active === undefined && !TXN.has(entity)) obj.Active = true;
    if (TXN.has(entity) && !obj.TxnDate) obj.TxnDate = iso().slice(0, 10);
    obj.Id = String(c.nextId++);
    obj.SyncToken = '0';
    obj.MetaData = { CreateTime: iso(), LastUpdatedTime: iso() };
    obj.domain = 'QBO';
    (obj.Line || []).forEach((l, i) => { if (!l.Id) l.Id = String(i + 1); });
    computeTotals(c, entity, obj, requestedTax && requestedTax.TaxLine ? requestedTax : null);
    store(c, entity).set(obj.Id, obj);
    rebalance(c);
    if (!silent) emit(c, entity, 'created', obj.Id);
    return obj;
  }

  function current(c, entity, id) {
    const o = store(c, entity).get(String(id));
    if (!o) throw fault('610', 'Object Not Found', `Object Not Found : Something you're trying to use has been made inactive or deleted. ${entity} Id=${id}`);
    return o;
  }

  function modify(c, entity, body, { silent = false } = {}) {
    if (c.disabled.has(entity)) throw fault('5030', 'Feature Not Supported', `Feature Not Supported : ${entity}`);
    const cur = current(c, entity, body.Id);
    if (String(body.SyncToken) !== String(cur.SyncToken)) {
      throw fault('5010', 'Stale Object Error', `Stale Object Error : You and someone else were working on this at the same time. ${entity} Id=${cur.Id}`);
    }
    const sparse = body.sparse === true;
    if (sparse && !SPARSE_OK.has(entity)) throw fault('2010', 'Request has invalid or unsupported property', 'sparse is not supported');
    const incoming = clone(body);
    delete incoming.sparse; delete incoming.Id; delete incoming.SyncToken; delete incoming.MetaData;
    const keep = { Id: cur.Id, SyncToken: cur.SyncToken, MetaData: cur.MetaData, domain: cur.domain, _voided: cur._voided, _paid: cur._paid };
    const next = sparse ? { ...clone(cur), ...incoming } : { ...incoming, ...keep };
    Object.assign(next, keep);
    if (entity === 'Customer' && next.Active === false && cur.Active !== false && Number(cur.Balance || 0) > 0) {
      throw fault('6000', 'A business validation error has occurred while processing your request', 'This customer has an open balance and can not be made inactive.');
    }
    checkName(c, entity, next, cur.Id);
    checkDocNumber(c, entity, next, cur.Id);
    checkBooks(c, entity, next);
    if (cur.TxnDate) checkBooks(c, entity, cur);
    checkAmounts(entity, next);
    (next.Line || []).forEach((l, i) => { if (!l.Id) l.Id = String(1000 + i); });
    computeTotals(c, entity, next, incoming.TxnTaxDetail?.TaxLine ? incoming.TxnTaxDetail : null);
    touch(next);
    store(c, entity).set(cur.Id, next);
    rebalance(c);
    if (!silent) emit(c, entity, 'updated', cur.Id);
    return next;
  }

  function remove(c, entity, body) {
    const cur = current(c, entity, body.Id);
    if (String(body.SyncToken) !== String(cur.SyncToken)) throw fault('5010', 'Stale Object Error', 'Stale Object Error');
    checkBooks(c, entity, cur);
    if (entity === 'Payment' && depositedPayment(c, cur.Id)) throw fault('6000', 'A business validation error has occurred while processing your request', 'This payment is part of a deposit. Remove it from the deposit first.');
    if (entity === 'Invoice') {
      for (const p of store(c, 'Payment').values()) {
        if ((p.Line || []).some((l) => linked(l, 'Invoice')?.TxnId === cur.Id && Number(l.Amount) !== 0)) {
          throw fault('6000', 'A business validation error has occurred while processing your request', 'This transaction has payments applied to it.');
        }
      }
    }
    store(c, entity).delete(cur.Id);
    c.deleted.push({ entity, Id: cur.Id, at: now() });
    rebalance(c);
    emit(c, entity, 'deleted', cur.Id);
    return { Id: cur.Id, status: 'Deleted', domain: 'QBO' };
  }

  function voidTxn(c, entity, body) {
    const cur = current(c, entity, body.Id);
    if (String(body.SyncToken) !== String(cur.SyncToken)) throw fault('5010', 'Stale Object Error', 'Stale Object Error');
    checkBooks(c, entity, cur);
    if (entity === 'Payment') {
      if (depositedPayment(c, cur.Id)) throw fault('6000', 'A business validation error has occurred while processing your request', 'This payment is part of a deposit and can not be voided.');
      cur.TotalAmt = 0;
      for (const l of cur.Line || []) l.Amount = 0;
    } else if (entity === 'Invoice') {
      // QuickBooks unapplies payments from a voided invoice; their amounts become unapplied credit.
      for (const p of store(c, 'Payment').values()) {
        const before = (p.Line || []).length;
        p.Line = (p.Line || []).filter((l) => linked(l, 'Invoice')?.TxnId !== cur.Id);
        if (p.Line.length !== before) { touch(p); emit(c, 'Payment', 'updated', p.Id); }
      }
      for (const l of cur.Line || []) l.Amount = 0;
      cur.TotalAmt = 0;
      cur.TxnTaxDetail = { TotalTax: 0 };
    } else if (!['SalesReceipt', 'BillPayment', 'CreditMemo'].includes(entity)) {
      throw fault('2010', 'Request has invalid or unsupported property', `Operation void is not supported for ${entity}`);
    }
    cur._voided = true;
    cur.PrivateNote = `Voided${cur.PrivateNote ? ` - ${cur.PrivateNote}` : ''}`;
    touch(cur);
    rebalance(c);
    emit(c, entity, 'voided', cur.Id);
    return cur;
  }

  // ---- queries ------------------------------------------------------------------------------

  function splitAnd(s) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && q) { cur += ch + (s[i + 1] ?? ''); i++; continue; }
      if (ch === "'") q = !q;
      if (!q && /^\s+and\s+/i.test(s.slice(i)) && /\s/.test(ch)) {
        const m = /^\s+and\s+/i.exec(s.slice(i));
        out.push(cur); cur = ''; i += m[0].length - 1; continue;
      }
      cur += ch;
    }
    if (q) throw fault('4000', 'QueryParserError', 'Encountered an unterminated string');
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }

  function literal(v) {
    v = v.trim();
    if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) throw fault('4000', 'QueryParserError', 'Bad string literal');
      return v.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    throw fault('4000', 'QueryParserError', `Unexpected value ${v.slice(0, 20)}`);
  }

  function fieldOf(o, path) {
    let v = o;
    for (const k of path.split('.')) { if (v == null) return undefined; v = v[k]; }
    if (v && typeof v === 'object' && 'value' in v) return v.value;
    return v;
  }

  function cmp(a, b) {
    if (a === undefined || a === null) return NaN;
    if (typeof b === 'number') return Number(a) - b;
    if (typeof b === 'boolean') return String(a) === String(b) ? 0 : 1;
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (/^\d{4}-\d\d-\d\d/.test(String(b)) && Number.isFinite(da) && Number.isFinite(db)) return da - db;
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }

  function matches(o, cond) {
    const m = /^([A-Za-z][\w.]*)\s*(<=|>=|!=|=|<|>|\blike\b|\bin\b)\s*([\s\S]+)$/i.exec(cond);
    if (!m) throw fault('4000', 'QueryParserError', `Cannot parse condition`);
    const [, field, rawOp, rhs] = m;
    const op = rawOp.toLowerCase();
    const v = fieldOf(o, field);
    if (op === 'in') {
      const inner = /^\(([\s\S]*)\)$/.exec(rhs.trim());
      if (!inner) throw fault('4000', 'QueryParserError', 'Bad IN list');
      const items = inner[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(literal);
      return items.some((x) => cmp(v, x) === 0);
    }
    const val = literal(rhs);
    if (op === 'like') {
      const pat = String(val);
      const re = new RegExp(`^${pat.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return v != null && re.test(String(v));
    }
    const d = cmp(v, val);
    if (Number.isNaN(d)) return false;
    return { '=': d === 0, '!=': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op];
  }

  function runQuery(c, text) {
    const m = /^\s*select\s+(\*|count\(\*\))\s+from\s+(\w+)(?:\s+where\s+([\s\S]+?))?(?:\s+orderby\s+([\w.]+)(?:\s+(asc|desc))?)?(?:\s+startposition\s+(\d+))?(?:\s+maxresults\s+(\d+))?\s*$/i.exec(String(text));
    if (!m) throw fault('4000', 'QueryParserError', 'Encountered an error parsing the query');
    const [, what, rawEntity, where, orderBy, dir, start, max] = m;
    const entity = BY_LOWER[rawEntity.toLowerCase()] || (rawEntity.toLowerCase() === 'companyinfo' ? 'CompanyInfo' : null);
    if (!entity) throw fault('4000', 'QueryParserError', `Unsupported entity ${rawEntity.slice(0, 30)}`);
    if (c.disabled.has(entity)) throw fault('5030', 'Feature Not Supported', `Feature Not Supported : ${entity}`);
    let list = entity === 'CompanyInfo' ? [c.info] : [...store(c, entity).values()];
    const conds = where ? splitAnd(where) : [];
    list = list.filter((o) => conds.every((cd) => matches(o, cd)));
    if (/^count/i.test(what)) return { QueryResponse: { totalCount: list.length }, time: iso() };
    if (orderBy) list.sort((a, b) => cmp(fieldOf(a, orderBy), fieldOf(b, orderBy) ?? '') * (dir?.toLowerCase() === 'desc' ? -1 : 1));
    const s = Math.max(1, Number(start || 1));
    const n = Math.min(1000, Number(max || 100));
    const page = list.slice(s - 1, s - 1 + n).map(pub);
    const qr = { startPosition: s, maxResults: page.length };
    if (page.length) qr[entity] = page;
    return { QueryResponse: qr, time: iso() };
  }

  function runCdc(c, entities, changedSince) {
    const since = Date.parse(changedSince);
    if (!Number.isFinite(since)) throw fault('2010', 'Request has invalid or unsupported property', 'changedSince is invalid');
    if (now() - since > 30 * 86400_000) throw fault('2010', 'Request has invalid or unsupported property', 'changedSince must be within the last 30 days');
    const all = [];
    for (const e of entities) {
      if (!BY_LOWER[e.toLowerCase()]) throw fault('2010', 'Request has invalid or unsupported property', `Unsupported entity ${e.slice(0, 30)}`);
      const entity = BY_LOWER[e.toLowerCase()];
      for (const o of store(c, entity).values()) {
        const t = Date.parse(o.MetaData?.LastUpdatedTime);
        if (t >= since) all.push({ entity, t, obj: pub(o) });
      }
      for (const d of c.deleted) {
        if (d.entity === entity && d.at >= since) all.push({ entity, t: d.at, obj: { Id: d.Id, status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: iso(d.at) } } });
      }
    }
    all.sort((a, b) => a.t - b.t);
    const capped = all.slice(0, 1000);
    const blocks = entities.map((e) => {
      const entity = BY_LOWER[e.toLowerCase()];
      const list = capped.filter((x) => x.entity === entity).map((x) => x.obj);
      return list.length ? { [entity]: list, startPosition: 1, maxResults: list.length, totalCount: list.length } : {};
    });
    return { CDCResponse: [{ QueryResponse: blocks }], time: iso() };
  }

  // ---- OAuth ----------------------------------------------------------------------------------

  function issue(realmId, grant) {
    const accessToken = ['fake', 'access', realmId, hex(24)].join('.');
    const refreshToken = `fakerefresh${hex(16)}`;
    state.access.set(accessToken, { realmId, grantId: grant.id, expiresAt: now() + state.accessExpiresIn * 1000 });
    state.refresh.set(refreshToken, { realmId, grantId: grant.id, valid: true });
    return { accessToken, refreshToken };
  }

  function grantFor(realmId) {
    let g = state.grants.get(realmId);
    if (!g || !g.alive) { g = { id: randomUUID(), alive: true }; state.grants.set(realmId, g); }
    return g;
  }

  function killGrant(realmId) {
    const g = state.grants.get(realmId);
    if (!g) return;
    g.alive = false;
    for (const t of state.refresh.values()) if (t.grantId === g.id) t.valid = false;
    for (const [k, t] of state.access) if (t.grantId === g.id) state.access.delete(k);
  }

  function basicOk(headers) {
    const h = String(headers.authorization || '');
    const want = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;
    return h === want;
  }

  const json = (status, body, headers = {}) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

  async function tokenEndpoint(req) {
    const form = new URLSearchParams(req.text);
    state.tokenCalls.push({ grantType: form.get('grant_type'), at: now() });
    if (state.beforeToken) await state.beforeToken({ grantType: form.get('grant_type'), refreshToken: form.get('refresh_token') });
    const f = takeTokenFault();
    if (f) {
      if (f.error === 'invalid_client') return json(401, { error: 'invalid_client' });
      if (f.error === 'invalid_grant') return json(400, { error: 'invalid_grant' });
      return json(f.status || 503, { error: f.error || 'server_error' });
    }
    if (!basicOk(req.headers)) return json(401, { error: 'invalid_client' });
    const hard = String(req.headers['x-include-refresh-token-hard-expires-in'] || '') === 'true';
    const answer = (t) => json(200, {
      token_type: 'bearer', access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: state.accessExpiresIn,
      x_refresh_token_expires_in: 8_726_400, ...(hard ? { x_refresh_token_hard_expires_in: state.hardExpiresIn } : {}),
    }, { intuit_tid: `tid-${hex(6)}` });
    if (form.get('grant_type') === 'authorization_code') {
      const code = state.codes.get(form.get('code') || '');
      if (!code || code.used || code.redirectUri !== form.get('redirect_uri')) { if (code) code.used = true; return json(400, { error: 'invalid_grant' }); }
      if (code.challenge && createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant' });
      code.used = true;
      return answer(issue(code.realmId, grantFor(code.realmId)));
    }
    if (form.get('grant_type') === 'refresh_token') {
      const old = state.refresh.get(form.get('refresh_token') || '');
      const g = old && state.grants.get(old.realmId);
      if (!old || !old.valid || !g || !g.alive || g.id !== old.grantId) return json(400, { error: 'invalid_grant' });
      const t = issue(old.realmId, g);
      if (state.rotateRefresh) old.valid = false;
      else { state.refresh.delete(t.refreshToken); t.refreshToken = form.get('refresh_token'); }
      return answer(t);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function revokeEndpoint(req) {
    const f = takeTokenFault('revoke');
    if (f) return json(f.status || 503, { error: f.error || 'server_error' });
    if (!basicOk(req.headers)) return json(401, { error: 'invalid_client' });
    let token = '';
    try { token = JSON.parse(req.text || '{}').token || ''; } catch { return json(400, { error: 'invalid_request' }); }
    const t = state.refresh.get(token) || state.access.get(token);
    if (t) {
      state.revoked.push({ realmId: t.realmId, grantId: t.grantId, at: now() });
      if (state.grantLevelRevoke) killGrant(t.realmId);
      else { state.refresh.delete(token); state.access.delete(token); }
    }
    return { status: 200, body: '', headers: {} };
  }

  function authorizeEndpoint(u) {
    const p = u.searchParams;
    if (p.get('client_id') !== app.clientId) return json(400, { error: 'invalid_client' });
    const consent = state.nextConsent || {};
    state.nextConsent = null;
    const back = new URL(p.get('redirect_uri'));
    back.searchParams.set('state', p.get('state') || '');
    if (consent.deny) back.searchParams.set('error', 'access_denied');
    else {
      const realmId = String(consent.realmId || [...state.realms.keys()][0] || '9130350000000001');
      const code = `fakecode${hex(12)}`;
      state.codes.set(code, { realmId, redirectUri: p.get('redirect_uri'), challenge: p.get('code_challenge') || null, used: false });
      back.searchParams.set('code', code);
      back.searchParams.set('realmId', realmId);
    }
    return { status: 302, body: '', headers: { location: back.toString() } };
  }

  function takeTokenFault(kind = 'token') {
    const i = state.tokenFaults.findIndex((f) => (f.kind || 'token') === kind && f.count > 0);
    if (i < 0) return null;
    const f = state.tokenFaults[i];
    f.count--;
    if (f.count <= 0) state.tokenFaults.splice(i, 1);
    return f;
  }

  // ---- the API --------------------------------------------------------------------------------

  function takeFault(req) {
    for (let i = 0; i < state.faults.length; i++) {
      const f = state.faults[i];
      if (f.count <= 0) continue;
      if (f.match && !f.match(req)) continue;
      f.count--;
      if (f.count <= 0) state.faults.splice(i, 1);
      return f;
    }
    return null;
  }

  /** Core: writes. CorePlus: reads, queries, CDC, company info, preferences (5.11). */
  function classify(method, path) {
    return method === 'GET' || path === 'query' ? 'coreplus' : 'core';
  }

  function parseMultipart(buf, contentType) {
    const m = /boundary=([^;]+)/i.exec(contentType || '');
    if (!m) throw fault('2010', 'Request has invalid or unsupported property', 'multipart boundary missing');
    const sep = Buffer.from(`--${m[1]}`);
    const parts = {};
    let pos = buf.indexOf(sep);
    while (pos >= 0) {
      const next = buf.indexOf(sep, pos + sep.length);
      if (next < 0) break;
      const part = buf.subarray(pos + sep.length + 2, next - 2);
      const headEnd = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, headEnd).toString();
      const name = /name="([^"]+)"/.exec(head)?.[1];
      if (name) parts[name] = { head, body: part.subarray(headEnd + 4) };
      pos = next;
    }
    return parts;
  }

  function apiCall(c, req, method, path, params) {
    const op = params.get('operation');
    if (path === 'query') {
      const text = method === 'GET' ? params.get('query') : req.text;
      return runQuery(c, text);
    }
    if (path === 'cdc') return runCdc(c, String(params.get('entities') || '').split(',').filter(Boolean), params.get('changedSince'));
    if (path === 'preferences') return { Preferences: pub(c.prefs), time: iso() };
    if (path.startsWith('companyinfo/')) return { CompanyInfo: pub(c.info), time: iso() };
    if (path === 'batch') {
      const items = JSON.parse(req.text || '{}').BatchItemRequest || [];
      if (items.length > state.batchMax) throw fault('6000', 'A business validation error has occurred while processing your request', `Batch size exceeds ${state.batchMax}`);
      const out = items.map((it) => {
        try {
          if (it.Query) return { bId: it.bId, QueryResponse: runQuery(c, it.Query).QueryResponse };
          const entity = ENTITIES.find((e) => it[e]);
          if (!entity) throw fault('2010', 'Request has invalid or unsupported property', 'No entity in batch item');
          const o = it.operation === 'delete' ? remove(c, entity, it[entity]) : it.operation === 'update' ? modify(c, entity, it[entity]) : insert(c, entity, it[entity]);
          return { bId: it.bId, [entity]: pub(o) };
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          return { bId: it.bId, Fault: { Error: [{ Message: e.message, Detail: e.detail, code: e.code }], type: e.type } };
        }
      });
      return { BatchItemResponse: out, time: iso() };
    }
    if (path === 'upload') {
      const parts = parseMultipart(req.raw, req.headers['content-type']);
      const meta = JSON.parse(parts.file_metadata_0?.body.toString() || '{}');
      const content = parts.file_content_0?.body || Buffer.alloc(0);
      const att = insert(c, 'Attachable', { ...meta, Size: content.length }, { silent: true });
      c.attachments.set(att.Id, content);
      return { AttachableResponse: [{ Attachable: pub(att) }], time: iso() };
    }
    const [rawEntity, id] = path.split('/');
    const entity = BY_LOWER[rawEntity];
    if (!entity) throw fault('2010', 'Request has invalid or unsupported property', `Unsupported entity ${rawEntity.slice(0, 30)}`);
    if (method === 'GET') {
      if (c.disabled.has(entity)) throw fault('5030', 'Feature Not Supported', `Feature Not Supported : ${entity}`);
      return { [entity]: pub(current(c, entity, id)), time: iso() };
    }
    const body = JSON.parse(req.text || '{}');
    let result;
    if (op === 'delete') result = remove(c, entity, body);
    else if (op === 'void' || (entity === 'Payment' && params.get('include') === 'void')) result = voidTxn(c, entity, body);
    else if (body.Id) result = modify(c, entity, body);
    else result = insert(c, entity, body);
    return { [entity]: pub(result), time: iso() };
  }

  async function handle(req) {
    const u = new URL(req.url);
    const method = req.method.toUpperCase();
    const path = u.pathname;
    if (method === 'GET' && path === '/connect/oauth2') { state.calls.push({ method, path, kind: 'oauth' }); return authorizeEndpoint(u); }
    if (method === 'POST' && path === '/oauth2/v1/tokens/bearer') { state.calls.push({ method, path, kind: 'oauth' }); return tokenEndpoint(req); }
    if (method === 'POST' && path === '/v2/oauth2/tokens/revoke') { state.calls.push({ method, path, kind: 'oauth' }); return revokeEndpoint(req); }
    const m = /^\/v3\/company\/(\d{1,20})\/(.+)$/.exec(path);
    if (!m) { state.unexpected.push(`${method} ${u.origin}${path}`); return json(404, { error: 'unexpected' }); }
    const [, realmId, sub] = m;
    const apiPath = sub.toLowerCase().replace(/\/+$/, '');
    const entity = BY_LOWER[apiPath.split('/')[0]] || (apiPath === 'query' ? 'Query' : apiPath.split('/')[0]);
    const kind = classify(method, apiPath);
    const call = { method, path: apiPath, entity, realmId, kind, requestId: u.searchParams.get('requestid'), minorversion: u.searchParams.get('minorversion'), at: now() };
    state.calls.push(call);
    const tid = `tid-${hex(6)}`;
    const send = (status, body) => json(status, body, { intuit_tid: tid });
    try {
      const token = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
      const t = state.access.get(token);
      const g = t && state.grants.get(t.realmId);
      if (!t || t.realmId !== realmId || t.expiresAt <= now() || !g?.alive || g.id !== t.grantId) {
        throw fault('3200', 'message=AuthenticationFailed; errorCode=003200; statusCode=401', 'Token expired or invalid', 401, 'AUTHENTICATION');
      }
      if (!call.minorversion) throw fault('2010', 'Request has invalid or unsupported property', 'minorversion is required by this fake');
      const f = takeFault(call);
      if (f && !f.drop) {
        if (f.latencyMs) await delay(f.latencyMs, req.signal);
        if (f.status) {
          if (f.status === 401) killAccessToken(token);
          const flt = new Fault(f.status, f.code || (f.status === 429 ? '003001' : f.status >= 500 ? '' : '6000'), f.message || (f.status === 429 ? 'message=ThrottleExceeded; errorCode=003001; statusCode=429' : 'Fault'), f.detail || '', f.type || (f.status === 429 ? 'SERVICE' : 'SystemFault'));
          return f.status >= 500 && !f.code ? { status: f.status, body: 'Service Unavailable', headers: { 'content-type': 'text/plain', intuit_tid: tid } } : send(f.status, flt.body());
        }
      }
      const c = company(realmId);
      const rid = call.requestId;
      if (rid && state.requestIdWindowMs > 0) {
        const seen = c.requestIds.get(rid);
        if (seen && now() - seen.at <= state.requestIdWindowMs) { call.replayed = true; return send(200, seen.body); }
      }
      const body = apiCall(c, req, method, apiPath, u.searchParams);
      if (rid) c.requestIds.set(rid, { at: now(), body });
      if (f?.drop) {
        call.dropped = true;
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', dropped: true });
      }
      return send(200, body);
    } catch (e) {
      if (e?.dropped) throw e;
      if (e instanceof Fault) { call.fault = e.code; return send(e.status, e.body()); }
      throw e;
    }
  }

  function killAccessToken(token) { state.access.delete(token); }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
  }

  function lowerHeaders(h) {
    if (!h) return {};
    const list = h instanceof Headers ? [...h.entries()] : Object.entries(h);
    return Object.fromEntries(list.map(([k, v]) => [k.toLowerCase(), v]));
  }

  async function bodyBuffer(b) {
    if (b == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(b)) return b;
    if (b instanceof Uint8Array) return Buffer.from(b);
    if (b instanceof URLSearchParams) return Buffer.from(b.toString());
    return Buffer.from(String(b));
  }

  /** A fetch for setFetch: handles Intuit's real hosts and this fake's listen address. */
  async function fakeFetch(url, init = {}) {
    const u = new URL(String(url));
    const ours = INTUIT_HOSTS.has(u.hostname) || (state.listenHost && u.host === state.listenHost);
    if (!ours) { state.unexpected.push(`${init.method || 'GET'} ${u.origin}${u.pathname}`); throw new Error('no network in tests'); }
    const raw = await bodyBuffer(init.body);
    const r = await handle({ method: init.method || 'GET', url: u.toString(), headers: lowerHeaders(init.headers), raw, text: raw.toString('utf8'), signal: init.signal });
    if (init.signal?.aborted) throw init.signal.reason;
    return new Response(r.status === 204 || r.status === 302 ? null : r.body, { status: r.status, headers: r.headers });
  }

  // ---- the fake's own controls ---------------------------------------------------------------

  const fake = {
    app,
    state,
    fetch: fakeFetch,
    /** Is this a URL the fake answers (for composing with other providers' fakes)? */
    handles(url) {
      try { const u = new URL(String(url)); return INTUIT_HOSTS.has(u.hostname) || (state.listenHost && u.host === state.listenHost); } catch { return false; }
    },
    now,
    advance(ms) { offset += ms; },
    addCompany,
    company: (realmId) => state.realms.get(String(realmId)),
    seed: (realmId) => company(realmId).seed,

    /** The next authorize answers for this realm (or `deny: true` for "Cancel"). */
    consent(o) { state.nextConsent = o; },
    /**
     * Follow Fishtape's authorize URL as the browser would and return the callback query
     * ({ code, state, realmId, error }).
     */
    async authorize(authorizeUrl, consent = null) {
      if (consent) state.nextConsent = consent;
      const r = authorizeEndpoint(new URL(authorizeUrl));
      if (r.status !== 302) throw new Error(`authorize refused: ${r.body}`);
      const back = new URL(r.headers.location);
      return { url: back.toString(), code: back.searchParams.get('code'), state: back.searchParams.get('state'), realmId: back.searchParams.get('realmId'), error: back.searchParams.get('error') };
    },
    /** Tokens for a realm without the browser dance (test set-up). */
    issueTokens(realmId) {
      const t = issue(String(realmId), grantFor(String(realmId)));
      return { ...t, expiresIn: state.accessExpiresIn, refreshExpiresIn: 8_726_400, refreshHardExpiresIn: state.hardExpiresIn };
    },
    /** A disconnect done inside QuickBooks: every token of the realm stops working (invalid_grant). */
    revokeRealm(realmId) { killGrant(String(realmId)); },
    grantAlive(realmId) { return Boolean(state.grants.get(String(realmId))?.alive); },
    expireAccessTokens() { for (const t of state.access.values()) t.expiresAt = now() - 1; },
    /** Next token-endpoint (or revoke) answers: { count, error: 'invalid_client'|'invalid_grant'|'server_error', status, kind: 'token'|'revoke' }. */
    failToken(o = {}) { state.tokenFaults.push({ count: 1, ...o }); },
    /**
     * Next API answers: { count, status (429, 500, 503, 401, 400...), code, message, detail, latencyMs, drop, match(call) }.
     * `drop: true` performs the request, then loses the answer (a timeout after the write landed).
     */
    failNext(o = {}) { state.faults.push({ count: 1, ...o }); },
    /** Run fn (awaited) at the start of every token-endpoint call; null to stop. */
    beforeToken(fn) { state.beforeToken = fn; },
    disableEntity(realmId, entity) { company(realmId).disabled.add(entity); },
    setBookCloseDate(realmId, date) { company(realmId).bookCloseDate = date; },
    setRequestIdWindow(ms) { state.requestIdWindowMs = ms; },
    setBatchMax(n) { state.batchMax = n; },

    /** Objects as QuickBooks holds them (copies). */
    get(realmId, entity, id) { return pub(store(company(realmId), entity).get(String(id))); },
    list(realmId, entity) { return [...store(company(realmId), entity).values()].map(pub); },
    /** Create, change, delete or void as a QuickBooks user would (emits webhook events; no call log). */
    create(realmId, entity, body) { return pub(insert(company(realmId), entity, body)); },
    edit(realmId, entity, id, patch) {
      const c = company(realmId);
      const cur = current(c, entity, id);
      return pub(modify(c, entity, { ...patch, Id: cur.Id, SyncToken: cur.SyncToken, sparse: true }));
    },
    destroy(realmId, entity, id) { const c = company(realmId); const cur = current(c, entity, id); return remove(c, entity, { Id: cur.Id, SyncToken: cur.SyncToken }); },
    void(realmId, entity, id) { const c = company(realmId); const cur = current(c, entity, id); return pub(voidTxn(c, entity, { Id: cur.Id, SyncToken: cur.SyncToken })); },
    /** QuickBooks "merge": `fromId` is folded into `intoId` and removed. */
    merge(realmId, entity, fromId, intoId) {
      const c = company(realmId);
      current(c, entity, intoId);
      const from = current(c, entity, fromId);
      store(c, entity).delete(from.Id);
      c.deleted.push({ entity, Id: from.Id, at: now() });
      for (const e of ['Invoice', 'Estimate', 'Payment']) for (const o of store(c, e).values()) if (refVal(o.CustomerRef) === from.Id) { o.CustomerRef = { value: String(intoId) }; touch(o); }
      emit(c, entity, 'merged', intoId, from.Id);
    },
    attachment(realmId, id) { return company(realmId).attachments.get(String(id)) || null; },

    // ---- webhooks ----
    /** Stop emitting events for an entity (true = all), to prove CDC catches up. */
    dropWebhooks(entity = true) { state.dropWebhooks.add(entity); },
    keepWebhooks() { state.dropWebhooks.clear(); },
    /** CloudEvents for the changes made since the last call (cleared), minus dropped ones. */
    webhookEvents(realmId) {
      const c = company(realmId);
      const out = c.events.filter((e) => !state.dropWebhooks.has(true) && !state.dropWebhooks.has(e.entity)).map((e) => ({
        specversion: '1.0', id: randomUUID(), source: 'intuit.qbo.fake', type: `qbo.${e.entity.toLowerCase()}.${e.op}.v1`,
        datacontenttype: 'application/json', time: e.time, intuitentityid: e.id, intuitaccountid: c.realmId,
        data: e.deletedId ? { deletedid: e.deletedId } : {},
      }));
      c.events.length = 0;
      return out;
    },
    /** The same changes in the legacy { eventNotifications } shape. */
    legacyWebhookEvents(realmId) {
      const c = company(realmId);
      const op = { created: 'Create', updated: 'Update', deleted: 'Delete', merged: 'Merge', voided: 'Void' };
      const entities = c.events.map((e) => ({ name: e.entity, id: e.id, operation: op[e.op], lastUpdated: e.time, ...(e.deletedId ? { deletedId: e.deletedId } : {}) }));
      c.events.length = 0;
      return { eventNotifications: [{ realmId: c.realmId, dataChangeEvent: { entities } }] };
    },
    sign(raw, verifier) { return createHmac('sha256', verifier).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).digest('base64'); },
    /** A signed webhook body for the realm's pending changes: { raw, signature, events }. */
    signedWebhook(realmId, verifier, { legacy = false } = {}) {
      const body = legacy ? fake.legacyWebhookEvents(realmId) : fake.webhookEvents(realmId);
      const raw = Buffer.from(JSON.stringify(body));
      return { raw, signature: fake.sign(raw, verifier), events: body };
    },

    // ---- call log ----
    calls: state.calls,
    unexpected: state.unexpected,
    counts() {
      const out = { core: 0, coreplus: 0, oauth: 0 };
      for (const c of state.calls) out[c.kind] = (out[c.kind] || 0) + 1;
      return out;
    },
    resetCalls() { state.calls.length = 0; state.tokenCalls.length = 0; },
    /** Throws when anything outside the fake's routes was called. */
    assertNoUnexpected() { if (state.unexpected.length) throw new Error(`unexpected calls: ${state.unexpected.join(', ')}`); },

    /** Serve over HTTP (e2e). Returns { url, apiBase, oauthBase, close }. */
    async listen(port = 0) {
      const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', async () => {
          const raw = Buffer.concat(chunks);
          try {
            const r = await handle({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers: lowerHeaders(req.headers), raw, text: raw.toString('utf8') });
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          } catch (e) {
            if (e?.dropped) { req.socket.destroy(); return; }
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('fake qbo error');
          }
        });
      });
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      const { port: p } = server.address();
      state.listenHost = `127.0.0.1:${p}`;
      const url = `http://127.0.0.1:${p}`;
      return { url, apiBase: `${url}/v3/company`, oauthBase: url, close: () => new Promise((r) => server.close(() => r())) };
    },
  };
  return fake;
}

/**
 * Connect a tenant to a fake realm through the real flow (ticket, start, authorize, callback), as a
 * test set-up step. setFetch must already route Intuit's URLs to fake.fetch.
 * @returns {Promise<{ result: string, redirect: string, tenantId: string|null }>}
 */
export async function connectViaFake(fake, { db, sealer, config, tenantId, userId, realmId, returnTo = 'app', reconnect = false }) {
  const { createConnectTicket, startPage, startFromTicket, completeCallback } = await import('../../src/qbo/connection.js');
  const { url } = await createConnectTicket(db, config, { tenantId, userId, returnTo, reconnect });
  const ticket = new URL(url).searchParams.get('ticket');
  // The interstitial first: its pre-flow cookie is what the POST must carry (2.2).
  const page = await startPage(db, config, ticket, { sessionUserId: userId });
  const start = await startFromTicket(db, sealer, config, ticket, { preflow: page.preflowCookie || null, sessionUserId: userId });
  if (!start.flowCookie) return { result: new URL(start.redirect).searchParams.get('result'), redirect: start.redirect, tenantId: null };
  const back = await fake.authorize(start.redirect, { realmId });
  return completeCallback(db, sealer, config, {
    code: back.code, state: back.state, realmId: back.realmId, error: back.error, flowCookie: start.flowCookie, sessionUserId: userId,
  });
}

# Imports and accounting exports: formats

What Fishtape reads (Import) and writes (Accounting export), and where each format comes from.
Code: `electrical-app/js/lib/{csv,importers,qbo-export}.js`, screen `#/import`. All pages below
were checked on **2026-10-19**; "updated" is the page's own date where it shows one.

## Reading files

- CSV (RFC 4180: quotes, `""`, line breaks in fields, CRLF/LF/CR, UTF-8 BOM, comma/semicolon/tab
  detected), Windows-1252 fallback for old Excel, and `.xlsx` (first worksheet; shared and inline
  strings; date-formatted cells become `YYYY-MM-DD`). Up to 20,000 rows and 25 MB per file.
- Money becomes integer cents exactly ("$1,234.56", "(45.00)", "1 234,56 $"). Units become the
  tokens wire runs price from (`ea`, `ft`, `100ft`, `1000ft`, `m`, `h`, `roll`, `stick`...).
- Dates: ISO, `a/b/yyyy` (order detected from values over 12, else asked), "Oct 19, 2026",
  Excel serials.
- Duplicates: clients by email, phone (last 10 digits) or name; items by SKU (else name); jobs by
  number; employees by email or name. "Skip" (default) or "Update" (only fields the file has).

## Presets

| preset | source | notes |
| --- | --- | --- |
| Jobber clients | help.getjobber.com 360045644734 (export, updated 2026-08-06) and 360034980534 (import headers, 2026-08-06) | Jobber publishes only some export columns (J-ID, Is Company?, Archived, Tags, custom fields); the rest follow its import headers. A client with several properties appears on several rows: the duplicate rows are skipped. |
| QuickBooks Online customers | Intuit community "export customer data to Excel" (CA, ~3 weeks before 2026-10-19); Customer Contact List report columns | Intuit does not publish the export headers: matched loosely with aliases. **VERIFY** with a real export. |
| QuickBooks Online products and services | Intuit L4o3mXx2u_US_en_US (updated 2026-05-26) | Import template column names; the list export's shorter names are also matched. **VERIFY** the export headers with a real file. |
| Housecall Pro customers | help.housecallpro.com 6797101 (export, 2026-07-21), 6584603 (import fields, 2026-01-23) | Export columns follow the list view's column setting; matched by field names. |
| Generic (each target) | — | Any spreadsheet with a header row; a template download per target. |

## QuickBooks Online (Canada) exports

- **Customers**: Settings → Import data → Customers. Fields (CA help L0fwkOCms_CA_en_CA, "updated 2
  months ago"): Name, Company, Email, Phone, Mobile, Fax, Website, Street, City, Province/Territory,
  Postal Code, Country, Opening Balance, Opening Balance Date, Account Number, Business Number,
  Resale Number. Name required, max 100, unique across customers/suppliers/employees, no `:` or `"`.
  1,000 rows or 2 MB per file (US help L12erg8Db, updated 2026-09-02). Fishtape writes Name, Company,
  Email, Phone, Street, City, Province/Territory, Postal Code, Country; repeated names get " (2)".
- **Invoices**: Settings → Import data → Invoices (CA help L7E9Xrd8l_CA_en_CA, "updated 2 weeks ago";
  US 2026-10-01). CSV only, 100 invoices and 1,000 rows per file, one row per line with the number
  repeated, no negative lines. Canada requires invoice number, customer, invoice date, due date, item
  amount and item tax code. Amounts are marked Exclusive in the wizard and tax codes are matched to
  the company's codes there. The date format is picked in the wizard. Headers follow Intuit's sample
  (InvoiceNo, Customer, InvoiceDate, DueDate, Terms, Memo, Item(Product/Service), ItemDescription,
  ItemQuantity, ItemRate, ItemAmount, Service Date) plus ItemTaxCode. **VERIFY** the CA sample's exact
  tax column spelling; the wizard maps columns, so a different spelling only needs one mapping.
- **Tax codes**: defaults are the names QuickBooks' automated sales tax uses (HST ON, HST NS, GST,
  GST/PST BC, GST/PST SK, GST/PST MB, GST/QST QC, Exempt). Intuit publishes no list; **VERIFY**
  against the company's tax list. The export screen lets each code be renamed (saved in
  `settings.accounting.qbo.codes`).
- **Payments**: QuickBooks Online has no native payments import. The file follows SaasAnt's
  "Received Payments" template (support.saasant.com 14000052968, 2025-08-20): Ref No, Customer,
  Payment Date, Payment method, Deposit To Account Name, Invoice No, Amount, Reference No, Memo,
  Currency Code. Without an add-on, use it as the list for + New → Receive payment.
- **Rounding**: Fishtape rounds each tax once per document; QuickBooks computes its own tax and can
  differ by a cent. The invoice summary CSV carries Fishtape's tax per component to compare.

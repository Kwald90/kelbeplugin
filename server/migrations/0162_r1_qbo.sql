-- 0162 Release 1 QuickBooks (docs/releases/r1-get-paid.md 9.2, 9.4; docs/integrations/quickbooks.md 17).
--
-- A credit note applied to an invoice is a $0 QuickBooks payment linking the invoice and the
-- CreditMemo: its link has role 'apply'. Credit notes link to a QuickBooks CreditMemo and supplier
-- credits (bills with negative lines) to a VendorCredit, so both entities join the link's list.

ALTER TABLE qbo_links DROP CONSTRAINT IF EXISTS qbo_links_role_check;
ALTER TABLE qbo_links ADD CONSTRAINT qbo_links_role_check CHECK (role IN ('main', 'fee', 'deposit', 'settlement', 'apply'));

ALTER TABLE qbo_links DROP CONSTRAINT IF EXISTS qbo_links_qbo_entity_check;
ALTER TABLE qbo_links ADD CONSTRAINT qbo_links_qbo_entity_check CHECK (qbo_entity IN ('Customer', 'Item', 'Employee', 'Vendor', 'Estimate', 'Invoice',
  'Payment', 'Bill', 'Purchase', 'PurchaseOrder', 'TimeActivity', 'Transfer', 'CreditMemo', 'VendorCredit'));

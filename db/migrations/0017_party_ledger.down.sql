-- Rollback of 0017_party_ledger. Only safe before real payments exist:
-- it drops the whole party ledger. Take a backup first.

DROP VIEW  IF EXISTS party_open_item_mismatches;
DROP VIEW  IF EXISTS party_open_items;
DROP VIEW  IF EXISTS party_balance_mismatches;
DROP TABLE IF EXISTS party_allocations;
DROP TABLE IF EXISTS party_balances;
DROP TABLE IF EXISTS party_ledger_entries;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sale_bills;
DROP FUNCTION IF EXISTS party_allocations_check();
DROP FUNCTION IF EXISTS party_balances_rebuild();
DROP FUNCTION IF EXISTS party_balances_guard();
DROP FUNCTION IF EXISTS party_ledger_apply();
DROP FUNCTION IF EXISTS party_ledger_immutable();
DROP FUNCTION IF EXISTS party_ledger_check();
DROP FUNCTION IF EXISTS payments_guard();
DROP FUNCTION IF EXISTS sale_bills_guard();
DELETE FROM document_sequences WHERE name IN ('payment_receipt', 'sale_bill_untaxed');
ALTER TABLE retailers DROP COLUMN IF EXISTS "creditDays", DROP COLUMN IF EXISTS "creditLimitPaise", DROP COLUMN IF EXISTS "taxType",
  DROP COLUMN IF EXISTS "earlyPayDiscountBp", DROP COLUMN IF EXISTS "earlyPayDays";

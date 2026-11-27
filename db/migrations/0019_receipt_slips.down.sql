-- Rollback of 0019_receipt_slips. Only safe before any slip exists. Take a backup first.

DELETE FROM document_sequences WHERE name = 'slip_cash' OR name LIKE 'slip_bank_%';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_cheque;
ALTER TABLE payments ADD CONSTRAINT payments_cheque CHECK (mode <> 'cheque' OR ("chequeNo" <> '' AND "chequeBank" <> '' AND "chequeDate" IS NOT NULL));
DROP INDEX IF EXISTS payments_slip_idx;
ALTER TABLE payments DROP COLUMN IF EXISTS "bankAccountId";
ALTER TABLE payments DROP COLUMN IF EXISTS "slipId";
DROP TABLE IF EXISTS receipt_slips;
DROP TABLE IF EXISTS bank_accounts;

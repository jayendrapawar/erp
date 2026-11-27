-- detect: select exists (select 1 from information_schema.columns where table_name = 'retailers' and column_name = 'email') as present
--
-- Bill by email (owner, 21 Nov 2026): Biller → Receipts → Mail sends the bill PDFs from the shop's
-- Gmail to the retailer. The retailer's email is remembered here (filled in next time); '' = none.
-- The sender (Gmail address + app password, encrypted) is an app setting, not a column.
--
-- Rollback: ALTER TABLE retailers DROP COLUMN email;

ALTER TABLE retailers ADD COLUMN email text NOT NULL DEFAULT '';

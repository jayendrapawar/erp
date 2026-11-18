-- Rollback of 0006_bill_scans. Stock movements posted by bills stay in the ledger
-- (sourceType 'bill_scan'); reverse them first if the bills should not count.
DROP TABLE IF EXISTS bill_scans;
DROP TABLE IF EXISTS direct_bill_drafts;

-- Rollback of 0007_purchases. Stock movements posted from cartons stay in the ledger
-- (sourceType 'carton_receipt'); void the receipts first if they should not count.
ALTER TABLE bill_scans DROP CONSTRAINT "bill_scans_stockSource_check";
ALTER TABLE bill_scans ADD CONSTRAINT "bill_scans_stockSource_check"
  CHECK ("stockSource" IN ('scanned', 'unscanned', 'unscanned_dispatch'));
DROP TABLE IF EXISTS carton_receipts;
DROP TABLE IF EXISTS purchase_bill_lines;
DROP TABLE IF EXISTS purchase_bills;

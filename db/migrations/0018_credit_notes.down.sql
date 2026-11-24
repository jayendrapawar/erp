-- Rollback of 0018_credit_notes. Only safe before any credit note exists (it would drop them and
-- their ledger link). Take a backup first.

DELETE FROM document_sequences WHERE name = 'credit_note';
DROP INDEX IF EXISTS ple_credit_note_once;
ALTER TABLE party_ledger_entries DROP CONSTRAINT IF EXISTS ple_credit_note;
ALTER TABLE party_ledger_entries DROP CONSTRAINT IF EXISTS party_ledger_entries_kind_check;
ALTER TABLE party_ledger_entries ADD CONSTRAINT party_ledger_entries_kind_check
  CHECK (kind IN ('opening', 'bill', 'payment', 'charge', 'discount', 'adjustment', 'reversal'));
ALTER TABLE party_ledger_entries DROP COLUMN IF EXISTS "creditNoteId";
ALTER TABLE bill_scans DROP CONSTRAINT IF EXISTS bill_scans_returned_check;
ALTER TABLE bill_scans DROP CONSTRAINT IF EXISTS bill_scans_status_check;
ALTER TABLE bill_scans ADD CONSTRAINT bill_scans_status_check CHECK (status IN ('active', 'released'));
ALTER TABLE bill_scans DROP COLUMN IF EXISTS "creditNoteId";
DROP TABLE IF EXISTS credit_note_lines;
DROP TABLE IF EXISTS credit_notes;
DROP FUNCTION IF EXISTS credit_notes_guard();

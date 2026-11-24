-- detect: select to_regclass('public.credit_notes') is not null as present
-- requires-backup
--
-- Credit notes (owner, 24 Nov 2026): money given back to a party after its bill, with GST shown.
--   kind 'money'   discount / rate difference: amount before GST typed, GST added at the bill's
--                  rates (or, with no bill, at the chosen bill type's rates).
--   kind 'return'  goods sent back: boxes of the bill are scanned; each goes back into stock and is
--                  marked 'returned' on its bill; the amount is what those boxes were billed at.
-- Against one bill (GST: the original invoice) or none (money only). Own number series CN1, CN2 …
-- (document_sequences 'credit_note', editable in Master → Bill template).
--
-- credit_notes       Frozen amounts like sale_bills; only status columns change (a money note can be
--                    cancelled with a reason; a goods return cannot — bill the boxes again).
-- credit_note_lines  The returned articles (article, MRP, pairs); append-only.
-- party_ledger_entries + kind 'credit_note' (always −, points at its note) + "creditNoteId".
-- bill_scans         + status 'returned' + "creditNoteId": the box came back on that credit note.
--
-- New tables, one new column on two tables, two widened CHECKs, one counter row. Nothing existing
-- is changed or deleted. Rollback: 0018_credit_notes.down.sql (only before any credit note exists).

CREATE TABLE credit_notes (
  id                bigserial PRIMARY KEY,
  "clientId"        uuid    NOT NULL UNIQUE,                 -- from the browser: a retry saves once
  "noteNo"          text    NOT NULL UNIQUE,
  "noteDate"        date    NOT NULL,
  "retailerId"      text    NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  "saleBillId"      bigint  REFERENCES sale_bills(id) ON DELETE RESTRICT,  -- the original bill (NULL = none)
  kind              text    NOT NULL CHECK (kind IN ('money', 'return')),
  reason            text    NOT NULL CHECK (btrim(reason) <> ''),
  "taxType"         text    NOT NULL CHECK ("taxType" IN ('intra_state', 'inter_state', 'untaxed')),
  "totalQty"        integer NOT NULL DEFAULT 0 CHECK ("totalQty" >= 0),
  "lineDiscPct"     numeric(5,2),                             -- returns: the bill's line discount
  "grossPaise"      bigint  NOT NULL DEFAULT 0 CHECK ("grossPaise" >= 0),
  "discountPct"     numeric(5,2) NOT NULL DEFAULT 0,
  "discountPaise"   bigint  NOT NULL DEFAULT 0 CHECK ("discountPaise" >= 0),
  "taxablePaise"    bigint  NOT NULL CHECK ("taxablePaise" > 0),
  "cgstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "cgstPaise"       bigint  NOT NULL DEFAULT 0 CHECK ("cgstPaise" >= 0),
  "sgstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "sgstPaise"       bigint  NOT NULL DEFAULT 0 CHECK ("sgstPaise" >= 0),
  "igstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "igstPaise"       bigint  NOT NULL DEFAULT 0 CHECK ("igstPaise" >= 0),
  "roundOffPaise"   integer NOT NULL DEFAULT 0 CHECK ("roundOffPaise" BETWEEN -99 AND 99),
  "totalPaise"      bigint  NOT NULL CHECK ("totalPaise" > 0),
  status            text    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  "cancelledAt"     timestamptz,
  "cancelledBy"     text REFERENCES "user"(id) ON DELETE SET NULL,
  "cancelReason"    text,
  "createdBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdByName"   text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cn_return_bill CHECK (kind <> 'return' OR ("saleBillId" IS NOT NULL AND "totalQty" > 0)),
  CONSTRAINT cn_taxable     CHECK (kind <> 'return' OR "taxablePaise" = "grossPaise" - "discountPaise"),
  CONSTRAINT cn_total       CHECK ("totalPaise" = "taxablePaise" + "cgstPaise" + "sgstPaise" + "igstPaise" + "roundOffPaise"),
  CONSTRAINT cn_gst         CHECK (("taxType" = 'intra_state' AND "igstPaise" = 0)
                                OR ("taxType" = 'inter_state' AND "cgstPaise" = 0 AND "sgstPaise" = 0)
                                OR ("taxType" = 'untaxed' AND "cgstPaise" = 0 AND "sgstPaise" = 0 AND "igstPaise" = 0)),
  CONSTRAINT cn_cancel      CHECK (status = 'active' OR ("cancelledAt" IS NOT NULL AND coalesce("cancelReason", '') <> '')),
  CONSTRAINT cn_cancel_kind CHECK (status = 'active' OR kind = 'money')
);
CREATE INDEX credit_notes_retailer_idx ON credit_notes ("retailerId", "noteDate" DESC, id DESC);
CREATE INDEX credit_notes_bill_idx     ON credit_notes ("saleBillId") WHERE "saleBillId" IS NOT NULL;

CREATE FUNCTION credit_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;  -- db:restore
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit notes are never deleted. Cancel the note instead.'; END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'cancelled'
     OR (to_jsonb(NEW) - ARRAY['status','cancelledAt','cancelledBy','cancelReason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','cancelledAt','cancelledBy','cancelReason']) THEN
    RAISE EXCEPTION 'credit note amounts are frozen; only an active note can be cancelled.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_notes_guard BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION credit_notes_guard();

CREATE TABLE credit_note_lines (
  id                bigserial PRIMARY KEY,
  "creditNoteId"    bigint  NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  "artNumber"       text    NOT NULL,
  mrp               numeric(10,2) NOT NULL CHECK (mrp >= 0),
  qty               integer NOT NULL CHECK (qty > 0),
  hsn               text
);
CREATE INDEX credit_note_lines_note_idx ON credit_note_lines ("creditNoteId");
CREATE TRIGGER credit_note_lines_no_update   BEFORE UPDATE OR DELETE ON credit_note_lines FOR EACH ROW       EXECUTE FUNCTION party_ledger_immutable();
CREATE TRIGGER credit_note_lines_no_truncate BEFORE TRUNCATE         ON credit_note_lines FOR EACH STATEMENT EXECUTE FUNCTION party_ledger_immutable();

-- A returned box: back in stock, still linked to its bill, and to the credit note it came back on.
ALTER TABLE bill_scans ADD COLUMN "creditNoteId" bigint REFERENCES credit_notes(id) ON DELETE RESTRICT;
ALTER TABLE bill_scans DROP CONSTRAINT bill_scans_status_check;
ALTER TABLE bill_scans ADD CONSTRAINT bill_scans_status_check CHECK (status IN ('active', 'released', 'returned'));
ALTER TABLE bill_scans ADD CONSTRAINT bill_scans_returned_check CHECK ((status = 'returned') = ("creditNoteId" IS NOT NULL));

-- The party ledger: a credit note is one − entry pointing at its note.
ALTER TABLE party_ledger_entries ADD COLUMN "creditNoteId" bigint REFERENCES credit_notes(id) ON DELETE RESTRICT;
ALTER TABLE party_ledger_entries DROP CONSTRAINT party_ledger_entries_kind_check;
ALTER TABLE party_ledger_entries ADD CONSTRAINT party_ledger_entries_kind_check
  CHECK (kind IN ('opening', 'bill', 'payment', 'charge', 'discount', 'adjustment', 'reversal', 'credit_note'));
ALTER TABLE party_ledger_entries ADD CONSTRAINT ple_credit_note
  CHECK (kind <> 'credit_note' OR ("creditNoteId" IS NOT NULL AND "amountPaise" < 0));
CREATE UNIQUE INDEX ple_credit_note_once ON party_ledger_entries ("creditNoteId") WHERE kind = 'credit_note';

INSERT INTO document_sequences (name, prefix, next, padding) VALUES ('credit_note', 'CN', 1, 0);

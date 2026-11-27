-- detect: select to_regclass('public.bank_statement_lines') is not null as present
-- requires-backup
--
-- Bank statement import (owner, 24–25 Nov 2026): UPI, bank transfers and cheques come into different
-- banks, and the names on the statement differ from the retailers' names. Entries must be accurate:
-- nothing reaches a party's ledger until a person confirms the line.
--
-- bank_accounts            + "statementColumns": which columns of this bank's Excel / CSV statement are
--                          the date, details, reference, credit, debit (saved on the first upload).
-- bank_statement_imports   One uploaded file (bank, name, sha256, rows read / new).
-- bank_statement_lines     One line of a statement. "lineKey" (bank + date + amount + reference + details
--                          + its occurrence) makes an overlapping file add nothing twice. Status:
--                          new → confirmed (its payments point at it) | ignored (with a reason: bank
--                          charge, own transfer …). Money going out (debit) is kept, never posted.
-- payer_aliases            A payer name / UPI ID seen on statements → a party; learnt when a line is
--                          confirmed. One payer may pay for several parties (one owner, two shops).
-- payments                 + "statementLineId": the statement line that confirms this payment.
--
-- New tables, one column on two tables. Nothing existing is changed or deleted.
-- Rollback: 0020_bank_statements.down.sql (only before any statement is imported).

ALTER TABLE bank_accounts ADD COLUMN "statementColumns" jsonb;

CREATE TABLE bank_statement_imports (
  id                bigserial PRIMARY KEY,
  "bankAccountId"   integer NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  "fileName"        text    NOT NULL,
  sha256            text    NOT NULL,
  "rowsRead"        integer NOT NULL DEFAULT 0,
  "rowsNew"         integer NOT NULL DEFAULT 0,
  "importedBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "importedByName"  text    NOT NULL DEFAULT '',
  "importedAt"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_statement_imports_bank_idx ON bank_statement_imports ("bankAccountId", "importedAt" DESC);

CREATE TABLE bank_statement_lines (
  id                bigserial PRIMARY KEY,
  "bankAccountId"   integer NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  "importId"        bigint  NOT NULL REFERENCES bank_statement_imports(id) ON DELETE RESTRICT,
  "lineKey"         text    NOT NULL UNIQUE,
  "txnDate"         date    NOT NULL,
  details           text    NOT NULL DEFAULT '',
  reference         text    NOT NULL DEFAULT '',            -- cheque no. / UTR / UPI ref, as the bank gives it
  "creditPaise"     bigint  NOT NULL DEFAULT 0 CHECK ("creditPaise" >= 0),
  "debitPaise"      bigint  NOT NULL DEFAULT 0 CHECK ("debitPaise" >= 0),
  "balancePaise"    bigint,
  "payerKey"        text    NOT NULL DEFAULT '',            -- UPI ID or cleaned payer name (for payer_aliases)
  status            text    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'ignored')),
  "ignoreReason"    text,
  "doneBy"          text REFERENCES "user"(id) ON DELETE SET NULL,
  "doneByName"      text    NOT NULL DEFAULT '',
  "doneAt"          timestamptz,
  CONSTRAINT bsl_one_side CHECK (("creditPaise" > 0) <> ("debitPaise" > 0)),
  CONSTRAINT bsl_ignored  CHECK (status <> 'ignored' OR coalesce("ignoreReason", '') <> ''),
  CONSTRAINT bsl_done     CHECK ((status = 'new') = ("doneAt" IS NULL))
);
CREATE INDEX bank_statement_lines_bank_idx ON bank_statement_lines ("bankAccountId", status, "txnDate" DESC);

CREATE TABLE payer_aliases (
  id                bigserial PRIMARY KEY,
  "payerKey"        text    NOT NULL CHECK ("payerKey" <> ''),
  "retailerId"      text    NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  "timesUsed"       integer NOT NULL DEFAULT 1,
  "lastUsedAt"      timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("payerKey", "retailerId")
);
CREATE INDEX payer_aliases_key_idx ON payer_aliases ("payerKey");

ALTER TABLE payments ADD COLUMN "statementLineId" bigint REFERENCES bank_statement_lines(id) ON DELETE RESTRICT;
CREATE INDEX payments_statement_line_idx ON payments ("statementLineId") WHERE "statementLineId" IS NOT NULL;

-- Payments stay unchangeable, with one more allowed move: a payment typed by hand is linked ONCE to
-- the statement line that confirms it (nothing else changes). The status moves are as before (0017).
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keep text[] := ARRAY['status','countedOn','countedBy','countedByName','reversedAt','reversedBy','reversedByName','reversalReason'];
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;  -- db:restore
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payments are never deleted. Reverse the payment instead.'; END IF;
  IF OLD."statementLineId" IS NULL AND NEW."statementLineId" IS NOT NULL
     AND (to_jsonb(NEW) - 'statementLineId') = (to_jsonb(OLD) - 'statementLineId') THEN
    RETURN NEW;  -- linked to its statement line
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'returned'))
       OR (OLD.status = 'active'  AND NEW.status IN ('bounced', 'reversed')))
     OR (to_jsonb(NEW) - keep) IS DISTINCT FROM (to_jsonb(OLD) - keep)
     OR (OLD."countedOn" IS NOT NULL AND NEW."countedOn" IS DISTINCT FROM OLD."countedOn") THEN
    RAISE EXCEPTION 'payments cannot be edited; only the status moves pending → deposited / returned, deposited → bounced / reversed.';
  END IF;
  RETURN NEW;
END $$;

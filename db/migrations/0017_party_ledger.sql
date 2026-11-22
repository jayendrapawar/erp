-- detect: select to_regclass('public.party_ledger_entries') is not null as present
-- requires-backup
--
-- Money owed by retailers (owner, 22–23 Nov 2026; approved 23 Nov). Same spirit as the stock ledger
-- (migration 0002):
--
-- sale_bills            The frozen amounts of every sale bill, written in the billing transaction
--                       (order invoice and Direct Bill): tax type (within state / outside state /
--                       untaxed), discount, GST, round-off, grand total. Walk-in bills too (no retailer).
--                       Amounts never change. A bill sent back / cancelled is marked cancelled (only
--                       status columns may change); billing the order again writes a NEW row, same no.
-- payments              Money received: cash / UPI / cheque / bank transfer. clientId (uuid from the
--                       browser) makes a retry or double tap record once. A cheque waits as 'pending'
--                       (in hand, not counted) until deposited. Only status columns change; the money
--                       effect is in the ledger.
-- party_ledger_entries  Append-only. + = the party owes more (bill, opening balance, bounced cheque);
--                       − = the party owes less (payment, negative opening balance = advance).
--                       A mistake is fixed by a 'reversal' row (exact opposite amount + reason).
-- party_allocations     Which credit (payment …) pays which debit (bill, opening item …). Append-only;
--                       undoing an allocation is a negative row pointing at the original. Unpaid on a
--                       bill = amount − allocations; advance on a party = credits − allocations.
-- party_balances        Balance per retailer, maintained ONLY by a trigger on party_ledger_entries
--                       (like stock_balances). party_balance_mismatches must be empty (db:verify).
-- retailers             + "taxType", "creditDays" (NULL = default, 90), "creditLimitPaise" (NULL = none).
--
-- Model follows ERPNext's Payment Ledger (open source, docs.frappe.io): every receivable movement is a
-- ledger row; a payment settles a bill through an "against" link (here party_allocations); unlinking
-- does not delete the payment (here a negative allocation row instead of ERPNext's "delinked" flag, so
-- nothing is ever updated); outstanding, advance and ageing (0–30/31–60/61–90/90+) come from it.
-- document_sequences    + 'payment_receipt' counter for receipt numbers (R1, R2 …).
--
-- All money is integer paise (bigint). Dates are business dates in IST.
-- Left room for later (not built): credit notes = new kind 'credit_note' + "creditNoteId" column
-- (allocations already work for any credit row); supplier side = its own supplier_* tables with the
-- same shape (different party, money flows the other way), so nothing here changes.
--
-- New tables / columns / one counter row only; nothing existing is changed or deleted.
-- Backfill of existing bills is a SEPARATE script with a dry run (owner sees numbers first).
-- Rollback: 0017_party_ledger.down.sql (only before real payments are recorded).
-- db:restore: every guard below lets 'shayona.restore' through, like the stock ledger; restore.ts gets
-- the new tables in its LEDGER list and rebuilds party_balances (party_balances_rebuild()).

-- ── Retailer credit terms ────────────────────────────────────────────────────

-- taxType: how this party is normally billed (owner, 23 Nov 2026): within the state (CGST 2.5 % +
-- SGST 2.5 %), outside the state (IGST 5 %), or not taxed (a few small parties). The biller can change
-- it on a bill; the bill saves what was used. Existing retailers: from the GSTIN state code when
-- they have one, else intra_state — set by the backfill script, listed for the owner to check.
-- creditDays: days a bill may stay unpaid (NULL = the default in settings, 90 today).
-- creditLimitPaise: optional amount limit (NULL = none).
-- earlyPayDiscountBp / earlyPayDays: some parties get a discount when they pay a bill within a month
--   (owner, 23 Nov 2026). NULL = no such discount. 100 bp = 1 %. The discount is a ledger credit
--   ('discount') against that bill; exact rules in docs/architecture/payments.md.
ALTER TABLE retailers
  ADD COLUMN "taxType"            text    NOT NULL DEFAULT 'intra_state' CHECK ("taxType" IN ('intra_state', 'inter_state', 'untaxed')),
  ADD COLUMN "creditLimitPaise"   bigint  CHECK ("creditLimitPaise" IS NULL OR "creditLimitPaise" >= 0),
  ADD COLUMN "creditDays"         integer CHECK ("creditDays" IS NULL OR "creditDays" BETWEEN 0 AND 365),
  ADD COLUMN "earlyPayDiscountBp" integer CHECK ("earlyPayDiscountBp" IS NULL OR "earlyPayDiscountBp" BETWEEN 1 AND 10000),
  ADD COLUMN "earlyPayDays"       integer CHECK ("earlyPayDays" IS NULL OR "earlyPayDays" BETWEEN 1 AND 365);

-- ── Frozen bill amounts ──────────────────────────────────────────────────────

-- Walk-in customer (owner, 23 Nov 2026): no retailer, the customer's name typed on the bill, not taxed,
-- paid at once (cash / UPI saved on the bill). Nothing is owed, so a walk-in bill has no ledger entry;
-- its money shows in the day's collections from "paidMode".
CREATE TABLE sale_bills (
  id                bigserial PRIMARY KEY,
  "orderId"         integer NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  "retailerId"      text    REFERENCES retailers(id) ON DELETE RESTRICT,   -- NULL only for walk-in
  "customerName"    text    NOT NULL DEFAULT '',                           -- walk-in only
  "customerPhone"   text    NOT NULL DEFAULT '',
  "paidMode"        text    CHECK ("paidMode" IS NULL OR "paidMode" IN ('cash', 'upi')),  -- walk-in only
  "billNo"          text    NOT NULL,
  "billDate"        date    NOT NULL,
  "billedAt"        timestamptz NOT NULL DEFAULT now(),
  source            text    NOT NULL CHECK (source IN ('invoice', 'direct', 'backfill')),
  "taxType"         text    NOT NULL CHECK ("taxType" IN ('intra_state', 'inter_state', 'untaxed')),
  "totalQty"        integer NOT NULL CHECK ("totalQty" >= 0),
  "lineDiscPct"     numeric(5,2) NOT NULL,
  "grossPaise"      bigint  NOT NULL CHECK ("grossPaise" >= 0),  -- printed "Sub total" (after line discount)
  "discountPct"     numeric(5,2) NOT NULL,                       -- 4.75 today (BILL_RATES)
  "discountPaise"   bigint  NOT NULL CHECK ("discountPaise" >= 0),
  "taxablePaise"    bigint  NOT NULL,
  "cgstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "cgstPaise"       bigint  NOT NULL DEFAULT 0,
  "sgstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "sgstPaise"       bigint  NOT NULL DEFAULT 0,
  "igstPct"         numeric(5,2) NOT NULL DEFAULT 0,
  "igstPaise"       bigint  NOT NULL DEFAULT 0,
  "roundOffPaise"   integer NOT NULL DEFAULT 0 CHECK ("roundOffPaise" BETWEEN -99 AND 99),
  "grandTotalPaise" bigint  NOT NULL CHECK ("grandTotalPaise" >= 0),
  status            text    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  "cancelledAt"     timestamptz,
  "cancelledBy"     text REFERENCES "user"(id) ON DELETE SET NULL,
  "cancelReason"    text,
  "createdBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdByName"   text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_bills_taxable CHECK ("taxablePaise" = "grossPaise" - "discountPaise"),
  CONSTRAINT sale_bills_total   CHECK ("grandTotalPaise" = "taxablePaise" + "cgstPaise" + "sgstPaise" + "igstPaise" + "roundOffPaise"),
  CONSTRAINT sale_bills_gst     CHECK (("taxType" = 'intra_state' AND "igstPaise" = 0)
                                    OR ("taxType" = 'inter_state' AND "cgstPaise" = 0 AND "sgstPaise" = 0)
                                    OR ("taxType" = 'untaxed' AND "cgstPaise" = 0 AND "sgstPaise" = 0 AND "igstPaise" = 0)),
  CONSTRAINT sale_bills_party   CHECK (("retailerId" IS NOT NULL AND "paidMode" IS NULL)
                                    OR ("retailerId" IS NULL AND btrim("customerName") <> '' AND "paidMode" IS NOT NULL AND "taxType" = 'untaxed')),
  CONSTRAINT sale_bills_cancel  CHECK (status = 'active' OR ("cancelledAt" IS NOT NULL AND coalesce("cancelReason", '') <> ''))
);
CREATE UNIQUE INDEX sale_bills_active_order   ON sale_bills ("orderId") WHERE status = 'active';
CREATE UNIQUE INDEX sale_bills_active_bill_no ON sale_bills ("billNo")  WHERE status = 'active';
CREATE INDEX        sale_bills_order_idx      ON sale_bills ("orderId");

-- Amounts are frozen: only active → cancelled (with its three columns) may change. Never deleted.
CREATE FUNCTION sale_bills_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;  -- db:restore
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sale_bills rows are never deleted. Cancel the bill instead.'; END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'cancelled'
     OR (to_jsonb(NEW) - ARRAY['status','cancelledAt','cancelledBy','cancelReason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','cancelledAt','cancelledBy','cancelReason']) THEN
    RAISE EXCEPTION 'sale_bills amounts are frozen; only an active bill can be cancelled.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_bills_guard BEFORE UPDATE OR DELETE ON sale_bills FOR EACH ROW EXECUTE FUNCTION sale_bills_guard();

-- ── Payments ─────────────────────────────────────────────────────────────────

-- Status (owner, 23 Nov 2026: a cheque counts only when it is deposited):
--   pending   cheque in hand — NOT counted, no ledger entry. Later also: a salesman's collection
--             waiting for the office (salesman app, not built; source = 'salesman').
--   active    counted: cash / UPI / bank at once; a cheque from its deposit date ("countedOn").
--   returned  a pending cheque given back / torn up — never counted.
--   bounced   a deposited cheque bounced — ledger reversal (+ optional bounce charge).
--   reversed  recorded by mistake — ledger reversal.
CREATE TABLE payments (
  id                bigserial PRIMARY KEY,
  "clientId"        uuid   NOT NULL UNIQUE,                 -- from the browser: a retry records once
  "receiptNo"       text   NOT NULL UNIQUE,
  "retailerId"      text   NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  "receivedOn"      date   NOT NULL,                        -- money / cheque handed over
  "countedOn"       date,                                   -- = receivedOn, or the cheque's deposit date
  mode              text   NOT NULL CHECK (mode IN ('cash', 'upi', 'cheque', 'bank')),
  "amountPaise"     bigint NOT NULL CHECK ("amountPaise" > 0),
  "chequeNo"        text   NOT NULL DEFAULT '',
  "chequeBank"      text   NOT NULL DEFAULT '',
  "chequeDate"      date,
  reference         text   NOT NULL DEFAULT '',             -- UPI ref / NEFT-RTGS UTR
  note              text   NOT NULL DEFAULT '',
  source            text   NOT NULL DEFAULT 'office' CHECK (source IN ('office', 'salesman')),
  "collectedBy"     text REFERENCES "user"(id) ON DELETE SET NULL,  -- salesman app later
  status            text   NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'returned', 'bounced', 'reversed')),
  "countedBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "countedByName"   text NOT NULL DEFAULT '',
  "reversedAt"      timestamptz,
  "reversedBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "reversedByName"  text NOT NULL DEFAULT '',
  "reversalReason"  text,
  "createdBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdByName"   text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_cheque   CHECK (mode <> 'cheque' OR ("chequeNo" <> '' AND "chequeBank" <> '' AND "chequeDate" IS NOT NULL)),
  CONSTRAINT payments_counted  CHECK ((status IN ('pending', 'returned')) = ("countedOn" IS NULL)),
  CONSTRAINT payments_bounced  CHECK (status <> 'bounced' OR mode = 'cheque'),
  CONSTRAINT payments_reversal CHECK (status IN ('pending', 'active') OR ("reversedAt" IS NOT NULL AND coalesce("reversalReason", '') <> ''))
);
CREATE INDEX payments_retailer_idx ON payments ("retailerId", "receivedOn" DESC, id DESC);
CREATE INDEX payments_pending_idx  ON payments ("chequeDate") WHERE status = 'pending';

-- Only these moves, and only their own columns change:
--   pending → active (deposited) | returned;  active → bounced (cheque) | reversed.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keep text[] := ARRAY['status','countedOn','countedBy','countedByName','reversedAt','reversedBy','reversedByName','reversalReason'];
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;  -- db:restore
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payments are never deleted. Reverse the payment instead.'; END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'returned'))
       OR (OLD.status = 'active'  AND NEW.status IN ('bounced', 'reversed')))
     OR (to_jsonb(NEW) - keep) IS DISTINCT FROM (to_jsonb(OLD) - keep)
     OR (OLD."countedOn" IS NOT NULL AND NEW."countedOn" IS DISTINCT FROM OLD."countedOn") THEN
    RAISE EXCEPTION 'payments cannot be edited; only the status moves pending → deposited / returned, deposited → bounced / reversed.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();

-- ── Party ledger (append-only) ───────────────────────────────────────────────

CREATE TABLE party_ledger_entries (
  id                bigserial PRIMARY KEY,
  "retailerId"      text   NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  -- charge   = cheque bounce charge (and any later charge to the party); always + with a reason.
  -- discount = early-payment discount on one bill; always − and points at that bill.
  kind              text   NOT NULL CHECK (kind IN ('opening', 'bill', 'payment', 'charge', 'discount', 'adjustment', 'reversal')),
  "amountPaise"     bigint NOT NULL CHECK ("amountPaise" <> 0), -- + owes more, − owes less
  "entryDate"       date   NOT NULL,
  "saleBillId"      bigint REFERENCES sale_bills(id) ON DELETE RESTRICT,
  "paymentId"       bigint REFERENCES payments(id) ON DELETE RESTRICT,
  "reversalOfId"    bigint REFERENCES party_ledger_entries(id) ON DELETE RESTRICT,
  "refNo"           text   NOT NULL DEFAULT '',               -- bill no. / receipt no. / old bill no.
  note              text   NOT NULL DEFAULT '',
  reason            text,
  "idempotencyKey"  text   NOT NULL UNIQUE,
  "createdBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdByName"   text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ple_bill     CHECK (kind <> 'bill'     OR ("saleBillId" IS NOT NULL AND "amountPaise" > 0)),
  CONSTRAINT ple_payment  CHECK (kind <> 'payment'  OR ("paymentId"  IS NOT NULL AND "amountPaise" < 0)),
  CONSTRAINT ple_reversal CHECK (kind <> 'reversal' OR ("reversalOfId" IS NOT NULL AND coalesce(reason, '') <> '')),
  CONSTRAINT ple_adjust   CHECK (kind <> 'adjustment' OR coalesce(reason, '') <> ''),
  CONSTRAINT ple_charge   CHECK (kind <> 'charge' OR ("amountPaise" > 0 AND coalesce(reason, '') <> '')),
  CONSTRAINT ple_discount CHECK (kind <> 'discount' OR ("amountPaise" < 0 AND "saleBillId" IS NOT NULL)),
  CONSTRAINT ple_bill_link CHECK ("saleBillId" IS NULL OR kind IN ('bill', 'discount'))
);
CREATE INDEX        ple_retailer_date_idx ON party_ledger_entries ("retailerId", "entryDate", id);
CREATE UNIQUE INDEX ple_one_reversal      ON party_ledger_entries ("reversalOfId") WHERE "reversalOfId" IS NOT NULL;
CREATE UNIQUE INDEX ple_bill_once         ON party_ledger_entries ("saleBillId")   WHERE kind = 'bill';
CREATE UNIQUE INDEX ple_payment_once      ON party_ledger_entries ("paymentId")    WHERE kind = 'payment';

-- A reversal is the exact opposite of a non-reversal row of the same party.
CREATE FUNCTION party_ledger_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o party_ledger_entries%ROWTYPE;
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NEW.kind = 'reversal' THEN
    SELECT * INTO o FROM party_ledger_entries WHERE id = NEW."reversalOfId";
    IF o.kind = 'reversal' OR o."retailerId" <> NEW."retailerId" OR o."amountPaise" <> -NEW."amountPaise" THEN
      RAISE EXCEPTION 'A reversal must be the exact opposite of an entry of the same party.';
    END IF;
  ELSIF NEW."reversalOfId" IS NOT NULL THEN
    RAISE EXCEPTION 'Only reversal entries point at another entry.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER party_ledger_check BEFORE INSERT ON party_ledger_entries FOR EACH ROW EXECUTE FUNCTION party_ledger_check();

CREATE FUNCTION party_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;  -- db:restore
  RAISE EXCEPTION '% is append-only. Post a reversal instead.', TG_TABLE_NAME;
END $$;
CREATE TRIGGER party_ledger_no_update   BEFORE UPDATE OR DELETE ON party_ledger_entries FOR EACH ROW       EXECUTE FUNCTION party_ledger_immutable();
CREATE TRIGGER party_ledger_no_truncate BEFORE TRUNCATE         ON party_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION party_ledger_immutable();

-- ── Balance per party (trigger-maintained, like stock_balances) ──────────────

CREATE TABLE party_balances (
  "retailerId"   text   PRIMARY KEY REFERENCES retailers(id) ON DELETE RESTRICT,
  "balancePaise" bigint NOT NULL DEFAULT 0,
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION party_ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('shayona.ledger', 'on', true);
  INSERT INTO party_balances ("retailerId", "balancePaise", "updatedAt")
  VALUES (NEW."retailerId", NEW."amountPaise", now())
  ON CONFLICT ("retailerId") DO UPDATE
    SET "balancePaise" = party_balances."balancePaise" + EXCLUDED."balancePaise", "updatedAt" = now();
  PERFORM set_config('shayona.ledger', 'off', true);
  RETURN NEW;
END $$;
CREATE TRIGGER party_ledger_apply AFTER INSERT ON party_ledger_entries FOR EACH ROW EXECUTE FUNCTION party_ledger_apply();

CREATE FUNCTION party_balances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('shayona.ledger', true), '') <> 'on' THEN
    RAISE EXCEPTION 'party_balances is maintained from party_ledger_entries. Post an entry instead.';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER party_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON party_balances FOR EACH ROW EXECUTE FUNCTION party_balances_guard();

CREATE VIEW party_balance_mismatches AS
SELECT coalesce(l."retailerId", b."retailerId") AS "retailerId",
       coalesce(l.total, 0) AS "ledgerPaise", coalesce(b."balancePaise", 0) AS "balancePaise"
FROM (SELECT "retailerId", sum("amountPaise") AS total FROM party_ledger_entries GROUP BY 1) l
FULL JOIN party_balances b USING ("retailerId")
WHERE coalesce(l.total, 0) <> coalesce(b."balancePaise", 0);

CREATE FUNCTION party_balances_rebuild() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('shayona.ledger', 'on', true);
  DELETE FROM party_balances;
  INSERT INTO party_balances ("retailerId", "balancePaise")
  SELECT "retailerId", sum("amountPaise") FROM party_ledger_entries GROUP BY 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('shayona.ledger', 'off', true);
  RETURN n;
END $$;

-- ── Allocations: which credit pays which debit (append-only) ─────────────────

CREATE TABLE party_allocations (
  id               bigserial PRIMARY KEY,
  "retailerId"     text   NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  "debitEntryId"   bigint NOT NULL REFERENCES party_ledger_entries(id) ON DELETE RESTRICT,
  "creditEntryId"  bigint NOT NULL REFERENCES party_ledger_entries(id) ON DELETE RESTRICT,
  "amountPaise"    bigint NOT NULL CHECK ("amountPaise" <> 0),  -- − = undoes the row in reversalOfId
  "reversalOfId"   bigint REFERENCES party_allocations(id) ON DELETE RESTRICT,
  method           text   NOT NULL CHECK (method IN ('auto', 'manual', 'reversal')),
  "createdBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pa_sign CHECK (("amountPaise" > 0) = ("reversalOfId" IS NULL))
);
CREATE INDEX        pa_debit_idx     ON party_allocations ("debitEntryId");
CREATE INDEX        pa_credit_idx    ON party_allocations ("creditEntryId");
CREATE UNIQUE INDEX pa_one_reversal  ON party_allocations ("reversalOfId") WHERE "reversalOfId" IS NOT NULL;

CREATE TRIGGER party_allocations_no_update   BEFORE UPDATE OR DELETE ON party_allocations FOR EACH ROW       EXECUTE FUNCTION party_ledger_immutable();
CREATE TRIGGER party_allocations_no_truncate BEFORE TRUNCATE         ON party_allocations FOR EACH STATEMENT EXECUTE FUNCTION party_ledger_immutable();

-- Checked at commit (deferred): the debit is a + row and the credit a − row of the same party, a
-- reversal exactly undoes its original, and neither side is ever over- or under-allocated.
CREATE FUNCTION party_allocations_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d party_ledger_entries%ROWTYPE; c party_ledger_entries%ROWTYPE; o party_allocations%ROWTYPE; used bigint;
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM party_ledger_entries WHERE id = NEW."debitEntryId";
  SELECT * INTO c FROM party_ledger_entries WHERE id = NEW."creditEntryId";
  IF d."amountPaise" <= 0 OR c."amountPaise" >= 0 OR d."retailerId" <> NEW."retailerId" OR c."retailerId" <> NEW."retailerId" THEN
    RAISE EXCEPTION 'Allocation must link a debit and a credit entry of the same party.';
  END IF;
  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT * INTO o FROM party_allocations WHERE id = NEW."reversalOfId";
    IF o."reversalOfId" IS NOT NULL OR o."debitEntryId" <> NEW."debitEntryId" OR o."creditEntryId" <> NEW."creditEntryId" OR o."amountPaise" <> -NEW."amountPaise" THEN
      RAISE EXCEPTION 'An allocation reversal must exactly undo one allocation.';
    END IF;
  END IF;
  SELECT coalesce(sum("amountPaise"), 0) INTO used FROM party_allocations WHERE "debitEntryId" = NEW."debitEntryId";
  IF used < 0 OR used > d."amountPaise" THEN RAISE EXCEPTION 'Entry % would be allocated % of %.', d.id, used, d."amountPaise"; END IF;
  SELECT coalesce(sum("amountPaise"), 0) INTO used FROM party_allocations WHERE "creditEntryId" = NEW."creditEntryId";
  IF used < 0 OR used > -c."amountPaise" THEN RAISE EXCEPTION 'Entry % would be allocated % of %.', c.id, used, -c."amountPaise"; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER party_allocations_check AFTER INSERT ON party_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION party_allocations_check();

-- Open items: debit rows with money still unpaid, credit rows with money not yet used (advance).
-- Per party: sum(open debits) − sum(open credits) = balance (checked by db:verify).
CREATE VIEW party_open_items AS
SELECT e.id, e."retailerId", e.kind, e."entryDate", e."refNo", e."saleBillId", e."paymentId",
       CASE WHEN e."amountPaise" > 0 THEN 'debit' ELSE 'credit' END AS side,
       abs(e."amountPaise") AS "amountPaise",
       abs(e."amountPaise") - coalesce(ad.s, 0) - coalesce(ac.s, 0) AS "openPaise"
FROM party_ledger_entries e
LEFT JOIN LATERAL (SELECT sum("amountPaise") AS s FROM party_allocations WHERE "debitEntryId"  = e.id) ad ON e."amountPaise" > 0
LEFT JOIN LATERAL (SELECT sum("amountPaise") AS s FROM party_allocations WHERE "creditEntryId" = e.id) ac ON e."amountPaise" < 0
WHERE abs(e."amountPaise") - coalesce(ad.s, 0) - coalesce(ac.s, 0) > 0;

CREATE VIEW party_open_item_mismatches AS
SELECT coalesce(b."retailerId", o."retailerId") AS "retailerId", coalesce(b."balancePaise", 0) AS "balancePaise", coalesce(o.net, 0) AS "openNetPaise"
FROM party_balances b
FULL JOIN (SELECT "retailerId", sum(CASE side WHEN 'debit' THEN "openPaise" ELSE -"openPaise" END) AS net
           FROM party_open_items GROUP BY 1) o USING ("retailerId")
WHERE coalesce(b."balancePaise", 0) <> coalesce(o.net, 0);

-- ── Receipt numbers ──────────────────────────────────────────────────────────

INSERT INTO document_sequences (name, prefix, next, padding) VALUES ('payment_receipt', 'R', 1, 0);
-- Bills without GST (small parties and walk-in) have their own series (owner, 23 Nov 2026).
-- Prefix 'E' until the admin changes it in Master → Bill template → Bill numbers.
INSERT INTO document_sequences (name, prefix, next, padding) VALUES ('sale_bill_untaxed', 'E', 1, 0);

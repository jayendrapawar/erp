-- detect: select to_regclass('public.receipt_slips') is not null as present
-- requires-backup
--
-- Cash and bank slips (owner, 24 Nov 2026), like the old software: a numbered slip holds one day's
-- receipts from many parties — a cash slip, or a bank slip for one of the shop's banks.
--
-- bank_accounts   The shop's banks (Master → Banks): name, account no., IFSC, branch, and the prefix
--                 of its slip numbers. Added / edited / retired by the office; never deleted once used.
-- receipt_slips   One slip per day for cash, and one per bank per day ("open today's slip again to add
--                 lines"). Numbers: cash C1, C2 … (document_sequences 'slip_cash'); each bank its own
--                 series with its own prefix ('slip_bank_<id>', created with the bank).
-- payments        + "slipId", "bankAccountId": the slip (and bank) a payment is on. A cheque on a bank
--                 slip is a deposited cheque (counted on the slip date); who issued it / its date may
--                 not be known, so only the cheque number is required now.
--
-- New tables, two new columns, one relaxed CHECK, one counter row. Nothing existing is deleted.
-- Rollback: 0019_receipt_slips.down.sql (only before any slip exists).

CREATE TABLE bank_accounts (
  id                serial PRIMARY KEY,
  name              text    NOT NULL CHECK (btrim(name) <> ''),
  "slipPrefix"      text    NOT NULL CHECK ("slipPrefix" ~ '^[A-Za-z0-9/-]{1,12}$'),
  "accountNo"       text    NOT NULL DEFAULT '',
  ifsc              text    NOT NULL DEFAULT '',
  branch            text    NOT NULL DEFAULT '',
  note              text    NOT NULL DEFAULT '',
  active            boolean NOT NULL DEFAULT true,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedByName"   text    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX bank_accounts_name_unique   ON bank_accounts (lower(btrim(name)));
CREATE UNIQUE INDEX bank_accounts_prefix_unique ON bank_accounts (upper("slipPrefix"));

CREATE TABLE receipt_slips (
  id                bigserial PRIMARY KEY,
  kind              text    NOT NULL CHECK (kind IN ('cash', 'bank')),
  "bankAccountId"   integer REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  "slipNo"          text    NOT NULL UNIQUE,
  "slipDate"        date    NOT NULL,
  "createdBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdByName"   text    NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_slips_bank CHECK ((kind = 'bank') = ("bankAccountId" IS NOT NULL))
);
CREATE UNIQUE INDEX receipt_slips_one_per_day ON receipt_slips (kind, coalesce("bankAccountId", 0), "slipDate");
CREATE INDEX receipt_slips_date_idx ON receipt_slips ("slipDate" DESC);

ALTER TABLE payments ADD COLUMN "slipId" bigint REFERENCES receipt_slips(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD COLUMN "bankAccountId" integer REFERENCES bank_accounts(id) ON DELETE RESTRICT;
CREATE INDEX payments_slip_idx ON payments ("slipId", id) WHERE "slipId" IS NOT NULL;
ALTER TABLE payments DROP CONSTRAINT payments_cheque;
ALTER TABLE payments ADD CONSTRAINT payments_cheque CHECK (mode <> 'cheque' OR "chequeNo" <> '');

INSERT INTO document_sequences (name, prefix, next, padding) VALUES ('slip_cash', 'C', 1, 0);

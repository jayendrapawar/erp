-- detect: select to_regclass('purchase_bills') is not null as present
--
-- Purchases: expected stock from supplier bills, carton receiving and verification (owner, 18 Nov 2026).
--
-- purchase_bills / purchase_bill_lines
--   One row per supplier bill PDF (Relaxo proforma invoice) and its lines. Goods are expected
--   5 days after the bill date ("expectedOn"); bills not fully received by then show as overdue.
--   A line = article + colour + size range + pack letter, N cartons × pairs per carton, MRP.
-- carton_receipts
--   One row per outer carton scanned at receiving (one active receipt per carton label).
--   Matched to an open bill line by article, colour, size range and pack letter. Its contents
--   come from the line's carton assortment and enter stock as provenance 'carton' (+pairs per
--   size). If the assortment or the article is not known yet, the carton is recorded and posted
--   automatically once they are. A carton not on any open bill is recorded as 'unexpected' and
--   does not change stock.
-- bill_scans.stockSource gains 'carton': a billed box may come out of carton stock.
--
-- New tables + one widened CHECK; no existing rows change. Rollback: 0007_purchases.down.sql.

CREATE TABLE purchase_bills (
  id                serial PRIMARY KEY,
  supplier          text NOT NULL DEFAULT 'Relaxo Footwears Limited',
  "docType"         text NOT NULL DEFAULT 'proforma' CHECK ("docType" IN ('proforma', 'invoice')),
  -- Supplier's reference printed on the bill, e.g. 0520364945/1062 (also the PDF file name).
  "refNo"           text NOT NULL,
  "invoiceNo"       text NOT NULL DEFAULT '',
  "billDate"        date NOT NULL,
  "soNo"            text,
  "soDate"          date,
  "poNo"            text,
  "customerCode"    text,
  division          text NOT NULL DEFAULT '',
  "expectedOn"      date NOT NULL,
  "totalCartons"    integer NOT NULL CHECK ("totalCartons" >= 0),
  "totalPairs"      integer NOT NULL CHECK ("totalPairs" >= 0),
  "grossAmount"     numeric(12, 2),
  status            text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'partial', 'received', 'cancelled')),
  source            text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'mail')),
  "fileName"        text,
  "fileSha256"      text NOT NULL,
  "uploadedBy"      text REFERENCES "user"(id) ON DELETE SET NULL,
  "uploadedByName"  text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "receivedAt"      timestamptz,
  "cancelledAt"     timestamptz,
  "cancelReason"    text
);
CREATE UNIQUE INDEX purchase_bills_ref_unique ON purchase_bills ("refNo");
CREATE UNIQUE INDEX purchase_bills_file_unique ON purchase_bills ("fileSha256");
CREATE INDEX purchase_bills_open_idx ON purchase_bills ("expectedOn") WHERE status IN ('expected', 'partial');

CREATE TABLE purchase_bill_lines (
  id                serial PRIMARY KEY,
  "billId"          integer NOT NULL REFERENCES purchase_bills(id) ON DELETE RESTRICT,
  "lineNo"          integer NOT NULL,
  hsn               text,
  "articleCode"     text NOT NULL,
  "colourCode"      text NOT NULL,
  "sizeFrom"        text NOT NULL,
  "sizeTo"          text NOT NULL,
  "packLetter"      text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  cartons           integer NOT NULL CHECK (cartons > 0),
  "pairsPerCarton"  integer NOT NULL CHECK ("pairsPerCarton" > 0),
  pairs             integer NOT NULL CHECK (pairs > 0),
  mrp               numeric(10, 2) NOT NULL,
  rate              numeric(10, 2),
  amount            numeric(12, 2),
  -- Carton assortment chosen for this line (exact version). Null = not chosen / not resolvable yet.
  "assortmentId"    integer REFERENCES carton_assortments(id),
  CONSTRAINT purchase_bill_lines_line_unique UNIQUE ("billId", "lineNo"),
  CONSTRAINT purchase_bill_lines_total_check CHECK (pairs = cartons * "pairsPerCarton")
);
CREATE INDEX purchase_bill_lines_match_idx ON purchase_bill_lines ("articleCode", "colourCode", "sizeFrom", "sizeTo");

CREATE TABLE carton_receipts (
  id                bigserial PRIMARY KEY,
  "clientEventId"   uuid NOT NULL UNIQUE,
  "rawInput"        text NOT NULL,
  "dedupeKey"       text NOT NULL,
  "articleCode"     text NOT NULL,
  "colourCode"      text NOT NULL,
  "sizeFrom"        text NOT NULL,
  "sizeTo"          text NOT NULL,
  "packLetter"      text NOT NULL DEFAULT '',
  mrp               numeric(10, 2),
  match             text NOT NULL CHECK (match IN ('matched', 'unexpected')),
  "billId"          integer REFERENCES purchase_bills(id),
  "billLineId"      integer REFERENCES purchase_bill_lines(id),
  -- Set when the contents entered stock (exact assortment version used).
  "assortmentId"    integer REFERENCES carton_assortments(id),
  "postedAt"        timestamptz,
  "postedPairs"     integer,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  "userId"          text REFERENCES "user"(id) ON DELETE SET NULL,
  "userName"        text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "voidedAt"        timestamptz,
  "voidedBy"        text REFERENCES "user"(id) ON DELETE SET NULL,
  "voidReason"      text,
  CONSTRAINT carton_receipts_line_check CHECK ((match = 'matched') = ("billLineId" IS NOT NULL)),
  CONSTRAINT carton_receipts_void_check CHECK ((status = 'voided') = ("voidedAt" IS NOT NULL))
);
-- One active receipt per physical carton label.
CREATE UNIQUE INDEX carton_receipts_active_label ON carton_receipts ("dedupeKey") WHERE status = 'active';
CREATE INDEX carton_receipts_line_idx ON carton_receipts ("billLineId") WHERE status = 'active';
CREATE INDEX carton_receipts_pending_idx ON carton_receipts ("billId") WHERE status = 'active' AND match = 'matched' AND "postedAt" IS NULL;
CREATE INDEX carton_receipts_recent_idx ON carton_receipts ("createdAt" DESC);

ALTER TABLE bill_scans DROP CONSTRAINT "bill_scans_stockSource_check";
ALTER TABLE bill_scans ADD CONSTRAINT "bill_scans_stockSource_check"
  CHECK ("stockSource" IN ('scanned', 'carton', 'unscanned', 'unscanned_dispatch'));

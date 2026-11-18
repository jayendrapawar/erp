-- detect: select to_regclass('bill_scans') is not null as present
--
-- Billing takes stock out (owner, 18 Nov 2026).
--
-- direct_bill_drafts  A Direct Bill (formerly "Emergency Bill") from its first scan until it is
--                     generated or discarded. Every scan is saved at once, so leaving the page
--                     by mistake keeps the bill as a draft.
-- bill_scans          One row per physical box scanned by a biller (Direct Bill draft or order
--                     invoice). A box (its unique label) can be on only one active bill.
--                     When the bill is generated the box leaves stock:
--                       stockSource 'scanned'            the warehouse scanned this exact box in → −1 scanned
--                       stockSource 'unscanned'          not scanned in, but its size has hand-counted
--                                                        (unscanned) stock → −1 unscanned
--                       stockSource 'unscanned_dispatch' neither → stock not touched; listed as
--                                                        "Unscanned dispatch" for checking
--                     Deleting a bill or sending it back releases its boxes and reverses their
--                     stock movements (the ledger keeps both lines).
--
-- New tables only; no existing data changes. Rollback: 0006_bill_scans.down.sql.

CREATE TABLE direct_bill_drafts (
  id                  serial PRIMARY KEY,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'billed', 'discarded')),
  "billerId"          text REFERENCES "user"(id) ON DELETE SET NULL,
  "billerName"        text NOT NULL DEFAULT '',
  "shopkeeperName"    text NOT NULL DEFAULT '',
  "shopkeeperPhone"   text,
  "shopkeeperAddress" text,
  "lineDiscPct"       numeric(5, 2) NOT NULL DEFAULT 30 CHECK ("lineDiscPct" BETWEEN 0 AND 100),
  -- Lines typed by hand (no box label): [{"artNumber": "...", "mrp": 499, "qty": 2}]
  "manualLines"       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("manualLines") = 'array'),
  "orderId"           integer REFERENCES orders(id) ON DELETE SET NULL,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),
  "closedAt"          timestamptz
);
CREATE INDEX direct_bill_drafts_open_idx ON direct_bill_drafts ("updatedAt" DESC) WHERE status = 'open';

CREATE TABLE bill_scans (
  id                 bigserial PRIMARY KEY,
  "clientEventId"    uuid NOT NULL UNIQUE,
  "draftId"          integer REFERENCES direct_bill_drafts(id),
  -- Set when the bill is generated. Cleared (with status 'released') when the bill is deleted
  -- or sent back, so an order cannot be deleted while it still holds boxes.
  "orderId"          integer REFERENCES orders(id) ON DELETE RESTRICT,
  "orderNumber"      text,
  "rawInput"         text NOT NULL,
  -- Unique label identity from the QR parser (same key as scan_events), else the raw text.
  "dedupeKey"        text NOT NULL,
  "articleCode"      text,
  "colourCode"       text,
  "sizeLabel"        text,
  mrp                numeric(10, 2),
  "skuId"            integer REFERENCES article_sizes(id) ON DELETE RESTRICT,
  "stockSource"      text CHECK ("stockSource" IN ('scanned', 'unscanned', 'unscanned_dispatch')),
  "stockScanEventId" bigint REFERENCES scan_events(id),
  "movementId"       bigint REFERENCES stock_movements(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  "userId"           text REFERENCES "user"(id) ON DELETE SET NULL,
  "userName"         text NOT NULL DEFAULT '',
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "postedAt"         timestamptz,
  "releasedAt"       timestamptz,
  "releasedReason"   text,
  CONSTRAINT bill_scans_released_check CHECK ((status = 'released') = ("releasedAt" IS NOT NULL)),
  CONSTRAINT bill_scans_posted_check CHECK (("postedAt" IS NULL) = ("stockSource" IS NULL))
);
-- A box can be on one active bill only.
CREATE UNIQUE INDEX bill_scans_active_box ON bill_scans ("dedupeKey") WHERE status = 'active';
CREATE INDEX bill_scans_draft_idx ON bill_scans ("draftId") WHERE "draftId" IS NOT NULL;
CREATE INDEX bill_scans_order_idx ON bill_scans ("orderId") WHERE "orderId" IS NOT NULL;
CREATE INDEX bill_scans_unscanned_dispatch_idx ON bill_scans ("postedAt" DESC) WHERE "stockSource" = 'unscanned_dispatch' AND status = 'active';

-- detect: select exists (select 1 from information_schema.columns where table_name = 'orders' and column_name = 'source') as present
--
-- Retailer shop, step 2 (owner, 21 Nov 2026): retailers sign in at /shop with phone + PIN, see
-- article colours that have a photo with the LATEST MRP, and place orders that wait for staff.
--
-- retailers  : shop sign-in. "shopPhone" = the phone they sign in with (10 digits, unique when set);
--              "shopPinHash" = scrypt hash, never the PIN; "shopPinSetAt" changes with every PIN set,
--              which signs out old sessions; 5 wrong PINs lock sign-in for 15 minutes.
-- orders     : status 'to_confirm' (retailer order not yet confirmed by staff — pickers never see it)
--              and "source" ('staff' | 'retailer').
-- article_mrps: "mfgYm" (newest manufacture year*100+month seen at that MRP) and "lastSeenAt", so the
--              shop can show the latest MRP: newest manufacture first, then the most recently seen.
--              Filled from past warehouse scans and billed boxes.
--
-- Rollback: DROP INDEX retailers_shop_phone_key; ALTER TABLE retailers DROP COLUMN "shopPhone",
--   DROP COLUMN "shopPinHash", DROP COLUMN "shopEnabled", DROP COLUMN "shopPinSetAt",
--   DROP COLUMN "shopFailedPins", DROP COLUMN "shopLockedUntil"; ALTER TABLE orders DROP COLUMN source;
--   ALTER TABLE article_mrps DROP COLUMN "mfgYm", DROP COLUMN "lastSeenAt".
--   (The enum value 'to_confirm' cannot be dropped; move any such orders to 'cancelled' first.)

ALTER TABLE retailers
  ADD COLUMN "shopPhone"       text    NOT NULL DEFAULT '',
  ADD COLUMN "shopPinHash"     text    NOT NULL DEFAULT '',
  ADD COLUMN "shopEnabled"     boolean NOT NULL DEFAULT false,
  ADD COLUMN "shopPinSetAt"    timestamptz,
  ADD COLUMN "shopFailedPins"  integer NOT NULL DEFAULT 0,
  ADD COLUMN "shopLockedUntil" timestamptz;
CREATE UNIQUE INDEX retailers_shop_phone_key ON retailers ("shopPhone") WHERE "shopPhone" <> '';

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'to_confirm' BEFORE 'pending';
ALTER TABLE orders ADD COLUMN source text NOT NULL DEFAULT 'staff' CONSTRAINT orders_source_check CHECK (source IN ('staff', 'retailer'));

ALTER TABLE article_mrps
  ADD COLUMN "mfgYm"      integer,
  ADD COLUMN "lastSeenAt" timestamptz;

UPDATE article_mrps m SET "mfgYm" = x.ym, "lastSeenAt" = x.seen
FROM (
  SELECT upper(btrim(e."articleCode")) AS code, e.mrp,
         max(CASE WHEN e."mfgYear" BETWEEN 2000 AND 2100 AND e."mfgMonth" BETWEEN 1 AND 12 THEN e."mfgYear" * 100 + e."mfgMonth" END) AS ym,
         max(e."createdAt") AS seen
  FROM scan_events e WHERE e."articleCode" IS NOT NULL AND e.mrp IS NOT NULL
  GROUP BY 1, 2
) x
WHERE x.code = m."artCode" AND x.mrp = m.mrp;

UPDATE article_mrps m SET "lastSeenAt" = greatest(coalesce(m."lastSeenAt", x.seen), x.seen)
FROM (
  SELECT upper(btrim(b."articleCode")) AS code, b.mrp, max(b."createdAt") AS seen
  FROM bill_scans b WHERE b."articleCode" IS NOT NULL AND b.mrp IS NOT NULL
  GROUP BY 1, 2
) x
WHERE x.code = m."artCode" AND x.mrp = m.mrp;

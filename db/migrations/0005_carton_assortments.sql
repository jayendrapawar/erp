-- detect: select to_regclass('carton_assortments') is not null as present
--
-- Carton assortments: how many pairs of each size one carton holds, per division, segment,
-- pairs per carton (packing) and assortment code (e.g. Flite EVA, Gents, 30, 608 = 6×12 7×10 8×8).
--
-- Separate from article packing (pairs per carton of an article size row, from the price list).
-- Versioned: an edit retires the active row and inserts the next version, so a carton received
-- against version 1 keeps pointing at version 1. Rows are never deleted.
--
-- New table only; no existing data changes. Rollback: 0005_carton_assortments.down.sql.

CREATE TABLE carton_assortments (
  id              serial PRIMARY KEY,
  division        text NOT NULL CHECK (btrim(division) <> ''),
  segment         text NOT NULL CHECK (btrim(segment) <> ''),
  packing         integer NOT NULL CHECK (packing BETWEEN 1 AND 1000),
  code            text NOT NULL CHECK (code ~ '^[0-9A-Z][0-9A-Z-]{0,15}$'),
  -- [{"size": "6", "pairs": 12}, …] in size order; pairs add up to packing (checked by the app).
  sizes           jsonb NOT NULL CHECK (jsonb_typeof(sizes) = 'array' AND jsonb_array_length(sizes) > 0),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  active          boolean NOT NULL DEFAULT true,
  note            text NOT NULL DEFAULT '',
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'upload')),
  "sourceFile"    text,
  "createdBy"     text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "retiredAt"     timestamptz,
  "retiredBy"     text REFERENCES "user"(id) ON DELETE SET NULL,
  "retiredReason" text,
  "replacedById"  integer REFERENCES carton_assortments(id),
  CONSTRAINT carton_assortments_retired_check CHECK (active = ("retiredAt" IS NULL))
);

-- One active assortment per key; every version of a key is unique.
CREATE UNIQUE INDEX carton_assortments_active_key ON carton_assortments (division, segment, packing, code) WHERE active;
CREATE UNIQUE INDEX carton_assortments_version_key ON carton_assortments (division, segment, packing, code, version);

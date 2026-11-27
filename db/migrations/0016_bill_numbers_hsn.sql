-- detect: select to_regclass('public.document_sequences') is not null as present
--
-- Bill numbers and HSN (owner, 22 Nov 2026).
--
-- document_sequences: counters for official document numbers. 'sale_bill' = sale bill number
--   (prefix + next number, zero-padded to "padding" digits). A bill takes its number inside the
--   billing transaction with one locked UPDATE … RETURNING, so two bills can never share a number
--   and a bill that fails gives its number back (no gaps). Admin sets "next" in Master → Bill
--   template; at go-live it is set to the old software's next number so both match.
-- orders."billNo": the bill's official number (unique when set). Bills made before this keep NULL
--   and print their ORD-… order number.
-- articles.hsn: HSN code per article (same for every colour of a code), filled below from the
--   Relaxo proforma invoices already uploaded (the most frequent HSN per article code) and later
--   from every new purchase bill.
-- bill_lines.hsn: HSN copied onto the bill line when billed, so a reprint never changes.
--
-- Rollback: DROP TABLE document_sequences; DROP INDEX orders_bill_no_key;
--   ALTER TABLE orders DROP COLUMN "billNo"; ALTER TABLE articles DROP COLUMN hsn;
--   ALTER TABLE bill_lines DROP COLUMN hsn;

CREATE TABLE document_sequences (
  name            text PRIMARY KEY,
  prefix          text NOT NULL DEFAULT '',
  next            bigint NOT NULL CHECK (next > 0),
  padding         integer NOT NULL DEFAULT 0 CHECK (padding BETWEEN 0 AND 10),
  "updatedAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedByName" text NOT NULL DEFAULT ''
);
INSERT INTO document_sequences (name, prefix, next, padding) VALUES ('sale_bill', '', 1, 0);

ALTER TABLE orders ADD COLUMN "billNo" text;
CREATE UNIQUE INDEX orders_bill_no_key ON orders ("billNo") WHERE "billNo" IS NOT NULL;

ALTER TABLE articles ADD COLUMN hsn text NOT NULL DEFAULT '';
ALTER TABLE bill_lines ADD COLUMN hsn text;

UPDATE articles a SET hsn = x.hsn
FROM (
  SELECT DISTINCT ON (code) code, hsn
  FROM (
    SELECT upper(btrim("articleCode")) AS code, btrim(hsn) AS hsn, count(*) AS n
    FROM purchase_bill_lines WHERE btrim(coalesce(hsn, '')) ~ '^[0-9]{4,8}$'
    GROUP BY 1, 2
  ) y
  ORDER BY code, n DESC, hsn
) x
WHERE upper(btrim(a."artCode")) = x.code AND a.hsn = '';

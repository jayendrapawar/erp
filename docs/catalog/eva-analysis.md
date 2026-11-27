# Flite EVA: price list, carton packing and assortments — analysis

Sources (business context, **not** the Sparx article master):

| Source | What it is | Extracted to |
|---|---|---|
| `EVA.pdf` | Relaxo "Distributors' price list updated as on 01-08-2026", 7 scanned pages (no text layer), signed by VP Sales | `eva/eva-price-list-2026-08-01.txt` (hand transcription, one line per size row) → `eva/price-list.csv` |
| `eva assortment.xlsx` | "FLITE EVA ASSORTMENT": pairs per size inside one carton, by segment, packing and assortment code | `eva/assortments.csv` |

Regenerate the CSVs and `eva/analysis.json`: `npx tsx scripts/catalog/eva-analysis.ts --assortments "<eva assortment.xlsx>"`.
Parsing and checks: `lib/catalog/eva.ts`. The 32 assortments are now stored as carton assortments
(division Flite EVA) — see `docs/architecture/carton-assortments.md`; upload-format copy:
`eva/flite-eva-assortments.xlsx`. The price list is still not in the database.

## 1. Price list (article level)

- 144 articles, 195 size rows, 4 collections: EVA (pages 1–4), AIR (5), URBAN BASIC (6), KIDS (7).
- Columns: article, colour names (no colour codes), size range, WSP, MRP, packing per carton.
- Packing per carton: 24 (67 rows), 30 (57), 36 (57), 48 (10), 60 (4).
- **Packing depends on the size row, not only the article**: 19 articles have different packing
  per size row, e.g. FL-02: 11 → 30, 6–10 → 30, 4–5 → 30, 1–3 → 36, 11–13 → 48.
- Size rows include adult runs (6–10, 11, 11–12), ladies (3–8, 4–7), children's (11–13, 11–1, 1–3,
  2–5, 7–10, 8–10, 5–7). The same printed size can be an adult or a child's size (FL-02 lists "11"
  at ₹259.50 and "11–13" at ₹199.50).
- **No gender / segment column.** The collection is printed; segment is not. FL-291 being a
  ladies' article is the owner's knowledge (recorded as such, not as a PDF fact).
- Label cross-check (QR regression corpus): box FL0020L sizes 4/5 at ₹239.50 = FL-20 row 4–5 ✓;
  FL0291L size 4 ₹249.50 = FL-291 3–8 ✓; FL0532L, FL0548L ✓; carton FL0020L 04–05 ₹239.50 ✓;
  carton FLN115G 06–10 ₹229.50 = FL-115 6–10 ✓. So one printed article ("FL-20") is several
  manufacturer codes (FL0020L for its 4–5 run, …), and codes may contain letters (FLN115G).
  FL2020G size 8 shows ₹549.50 against ₹599.50 in this list — the label was made 07/2024, before
  this price list: **MRP must be kept per label / batch as history**, not as one value per article.

## 2. Assortment workbook (carton contents)

33 assortment rows on the sheet; 32 used (Gents 11, Ladies 17, Baby 1, Kids 3) — row 44 is ignored, see issue 1. Every row's quantities add up to its
Total and Total equals Packing. The assortment code reads as a size range: first size +
two-digit last size (305 = 3–5, 610 = 6–10, 1101 = 11–1, 205 = 2–5, 103 = 1–3).

Issues found (`eva/analysis.json`):

1. **Row 44 ("Ladies", packing 36, code 405)** sits in the Baby/Ladies mini-table whose size
   columns are 1–5, so it fills sizes 2 and 3 (12 + 24) — but code 405 means sizes 4–5, and row 21
   already defines Ladies 36/405 as 4×12, 5×24. Almost certainly the row was copied into the wrong
   table. **Owner decision (18 Nov 2026): row 44 is the same as row 21 and is ignored** (`IGNORED_ROWS` in `scripts/catalog/eva-analysis.ts`).
2. **Segment is part of the key.** Gents and Ladies both have packing 30 code 608 (Gents 6×12,
   7×10, 8×8; Ladies 6×10, 7×10, 8×10) and packing 24 code 608 (Gents 6×10, 7×8, 8×6; Ladies
   6×8, 7×8, 8×8). A carton label does not carry the segment; it must come from the article master.
3. **Same code, different size systems.** Kids 48/710 means children's sizes 7–10 (12 each);
   Gents 30/710 and 24/710 mean adult 7–10. The size label "7" alone is ambiguous across systems;
   the article code's segment decides.
4. **Missing assortments.** 32 of 195 price-list rows have no assortment with their packing whose
   sizes fit their range: 11 @ 24/30/36, 4–5 @ 30, 1–3 @ 30, 11–12 @ 24/30, 11–13 @ 36/48/60,
   11–1 @ 24/48/60, 8–10 @ 36/60, 5–7 @ 36. Cartons of those articles cannot get expected
   size-wise contents until the owner supplies those assortments.
5. **Several assortments per row.** Only 90 rows have an assortment covering their full range;
   most rows have several candidates (FL-291, ladies 3–8 @ 30: 305, 406, 407, 507, 508, 608). The
   **carton QR's own size range picks the code** (e.g. a 03–05 carton → 305). The full article
   range is never assumed to be in one carton.

## 3. Carton labels (existing parser and corpus)

- Every carton sample the owner pasted on 18 Nov 2026 is already in the regression corpus
  (`tests/qr/corpus.ts`) and parses to the owner's table (article, colour, size range, MRP,
  date). Nothing new to add. The owner's table writes `SFG234G` for the label `SF0234G…`; the
  label is authoritative.
- The owner calls the DDMMYYYY field "MFG DATE"; the parser keeps it as `cartonDate`
  ("probable") with that note, because the label itself does not say.
- The compact format's single letter after the size range is "A" on every sample. It is **not**
  needed to find the assortment code (the range gives it) and its meaning is still unconfirmed —
  it may distinguish assortment versions. Do not key anything on it yet.
- No identifier links a carton to the boxes inside it (verified on all 7 groups), so carton
  contents are always *expected*, never proof of boxes.
- Against the new Sparx master (development): SS0703G, SF0204G, SF0234G cartons resolve to active
  variants with all their sizes; **SD0364L GEPK (a real carton) is not in the approved workbook**;
  PU, Flite, CU, RH cartons have no coded master rows yet.

## 4. Proposed data model (not built yet — carton module comes after the stocktake)

Keep three facts separate and versioned:

```
price_lists            id, supplier, title, effectiveDate, fileName, fileSha256, importedAt
price_list_lines       id, priceListId, articleLabel ("FL-291"), catalogArticleId NULL, colourNames[],
                       sizeFrom, sizeTo, wsp, mrp, pairsPerCarton, sourcePage
                       -- packing per carton is a price-list fact, per article + size row

carton_assortments     id, segment (gents|ladies|kids|baby), pairsPerCarton, code ("305"),
                       version, validFrom, validTo NULL, source, status (draft|approved|retired)
                       UNIQUE (segment, pairsPerCarton, code, version)
carton_assortment_lines assortmentId, sizeLabel, sizeSystem (adult|child), pairs
                       CHECK sum(pairs) = pairsPerCarton (enforced on approval)

article_segments       catalogArticleId → segment (confirmed by owner / supplier; never inferred)
```

Expected contents of a scanned carton (future carton-check module):

1. Parse the carton QR (article code, colour code, size range, MRP, date). Raw and payload kept.
2. Article code + colour code → variant (must be active in the master), segment from
   `article_segments`.
3. Packing: the price-list line for that article covering the carton's range (version in force on
   the carton date).
4. Assortment: (segment, packing, code = carton range) → the version valid on the carton date.
   Exactly one match → expected lines; zero or several → the carton is saved as
   "needs assortment" for an admin. Nothing is guessed.
5. The carton check stores a **snapshot** of the expected lines (so later edits never change
   history). It posts **no stock**. Stock increases only through a confirmed receipt (counted
   boxes, or an approved carton-derived receipt with provenance `carton`).

Assortments are never stored on the article: one article ships in several configurations
(FL-291 3–8 → six ladies assortments at packing 30).

## 5. Decisions needed from the owner

1. ~~Row 44~~ — decided: ignore (same as row 21).
2. Assortments for the 16 missing (range @ packing) combinations listed in §2.4.
3. Segment of each Flite article (or a rule the owner confirms, e.g. code suffix G/L/C/B).
4. Flite article codes and colour codes (the master has none) — or approval to build them from
   scanned labels via the Missing Articles workflow.
5. Meaning of the "A" pack letter (ask Relaxo).

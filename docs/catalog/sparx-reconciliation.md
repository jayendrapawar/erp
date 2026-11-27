# Sparx article workbook — reconciliation report

Generated 2026-11-18T15:21:21.888Z against database endpoint `ep-damp-scene-b3i40jjo` (read-only comparison).

Source: `sparx_article_list_filled (2).xlsx`, sheet `Articles`, SHA-256 `aebae679ab501f3aa304c76b52e668a9b8b351381c2a8b6a28ddb0e2b177abbd`.

## 1. Workbook

| Check | Expected (brief) | Found |
|---|---:|---:|
| Populated rows | 714 | 714 |
| Unique article codes | 267 | 267 |
| Distinct article names | 230 | 230 |
| Repeated code + colour combinations | 47 | 47 (44 after removing exact duplicates) |
| Exact duplicate rows | 3 | 3 |
| Variants (code + colour) | — | 651 |
| Size ranges kept | — | 704 |
| SKUs (variant + size) | — | 3120 |
| Rows rejected | — | 0 |

Repeated code + colour rows are **not** errors in general: most are separate size ranges of one variant (kids 11–13, 1 and 2–5; adult 6–10 and 11–12). They are stored as one variant with several ranges.

Issues: 0 error, 15 for admin review, 10 informational.

### exact duplicate row (3, info)

- Row 561 repeats row 556 exactly; counted once. _(rows 556, 561)_
- Row 562 repeats row 558 exactly; counted once. _(rows 558, 562)_
- Row 563 repeats row 560 exactly; counted once. _(rows 560, 563)_

### range overlap (3, review)

- SS0702B|OLYL: ranges 1–5 and 1–1 both include size 1. Each size is created once; confirm which range is correct. _(rows 68, 180)_
- SS0702B|BKRD: ranges 1–5 and 1–1 both include size 1. Each size is created once; confirm which range is correct. _(rows 69, 179)_
- SS0702B|NBOR: ranges 1–5 and 1–1 both include size 1. Each size is created once; confirm which range is correct. _(rows 70, 182)_

### colour name conflict (7, review)

- SS0702B|OLYL is named "Olive G.Yellow" and "Olive Yellow". Shown as "Olive G.Yellow / Olive Yellow" until an admin chooses. _(rows 68, 180, 184)_
- SF4049G|BKGY is named "Grey Black" and "Black Grey". Shown as "Grey Black / Black Grey" until an admin chooses. _(rows 240, 241)_
- SF0230G|BKDG is named "Black D.Grey" and "D.Grey Black". Shown as "Black D.Grey / D.Grey Black" until an admin chooses. _(rows 275, 276)_
- SF0183G|BRCL is named "Brown Camel" and "Camel Brown". Shown as "Brown Camel / Camel Brown" until an admin chooses. _(rows 380, 381)_
- SD1135G|BKPW is named "Black Pearl White" and "Pearl White Black". Shown as "Black Pearl White / Pearl White Black" until an admin chooses. _(rows 600, 601)_
- SD0323G|BKWH is named "White Black" and "Black White". Shown as "White Black / Black White" until an admin chooses. _(rows 633, 634, 636, 637)_
- SX0168L|PKNB is named "N.Blue Pink" and "Pink N.Blue". Shown as "N.Blue Pink / Pink N.Blue" until an admin chooses. _(rows 699, 700)_

### repeated range (7, info)

- SF4049G|BKGY size range 6–10 appears in rows 240, 241; kept once. _(rows 240, 241)_
- SF0230G|BKDG size range 6–10 appears in rows 275, 276; kept once. _(rows 275, 276)_
- SF0183G|BRCL size range 6–10 appears in rows 380, 381; kept once. _(rows 380, 381)_
- SD1135G|BKPW size range 6–10 appears in rows 600, 601; kept once. _(rows 600, 601)_
- SD0323G|BKWH size range 4–5 appears in rows 633, 634; kept once. _(rows 633, 634)_
- SD0323G|BKWH size range 6–10 appears in rows 636, 637; kept once. _(rows 636, 637)_
- SX0168L|PKNB size range 4–8 appears in rows 699, 700; kept once. _(rows 699, 700)_

### same colour name different code (1, review)

- SS0101C: colour "BLACK" appears under colour codes BLAK and BKBK. Kept separate; confirm whether one is a typo. _(rows 158, 215, 220)_

### name code mismatch (4, review)

- SF0105G is named "SS-105": no other article pairs a "SS-" name with a "SF" code. _(rows 213, 218)_
- SC0162G is named "SM-162": no other article pairs a "SM-" name with a "SC" code. _(rows 643, 644, 645, 646)_
- SX1103B is named "SK-1103": no other article pairs a "SK-" name with a "SX" code. _(rows 703, 704)_
- SN0970B is named "SK-970": no other article pairs a "SK-" name with a "SN" code. _(rows 709, 710)_

## 2. Comparison with the database

| Outcome | Count |
|---|---:|
| Article codes: new | 0 |
| Article codes: display name changed | 0 |
| Variants matched on code + colour (id kept) | 651 |
| … of which updated (name, colour name, sizes, status) | 0 |
| … of which re-activated | 0 |
| Variants to create | 0 |
| Sparx-scope variants to retire (inactive, not deleted) | 0 |
| … retired variants with scans, stock or scan links | 0 |
| SKUs to create | 0 |
| SKUs updated (label normalised, order, re-activated) | 0 |
| SKUs deactivated (size not in workbook) | 0 |
| Size ranges written | 0 |
| Other-brand variants left untouched | 0 (0 active) |
| Retired rows with a same-name same-colour workbook candidate (report only) | 0 |
| Review items | 0 |
| Waiting scans that will resolve | 0 variant(s) |

**The database already matches this workbook: an apply would change nothing.**

### Other brands (not in the Sparx workbook; untouched)



## 3. Files

- `retired.csv` — every variant that will be retired, with its references.
- `possible-matches.csv` — retired legacy rows whose name and colour name equal a workbook variant (for an admin to confirm; never merged automatically).
- `variants-updated.csv` — matched variants and what changes.
- `review-items.csv` — the admin review queue the import creates.

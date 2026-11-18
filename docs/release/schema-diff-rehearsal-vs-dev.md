# Schema comparison

A = `ep-damp-scene-b3i40jjo` schema rehearsal_prod (production data from backup 2026-11-18T11-20-02-732Z after the rehearsed release steps), B = `ep-damp-scene-b3i40jjo` schema public (development). Generated 2026-11-18T11:22:37Z, read-only.

## Migration tracking

A: schema_migrations 0000 baseline (applied); schema_migrations 0001 feature01_articles (applied); schema_migrations 0002 inventory_foundation (applied); schema_migrations 0003 article_catalog (applied); schema_migrations 0004 article_duplicate_archive (applied)

B: schema_migrations 0000 baseline (adopted); schema_migrations 0001 feature01_articles (adopted); schema_migrations 0002 inventory_foundation (applied); schema_migrations 0003 article_catalog (applied); schema_migrations 0004 article_duplicate_archive (applied)

## columns

319 in A, 330 in B — only in A: 0, only in B: 11, different: 0

- only B: `article_duplicate_review.artCode`
- only B: `article_duplicate_review.artName`
- only B: `article_duplicate_review.color`
- only B: `article_duplicate_review.colorCode`
- only B: `article_duplicate_review.createdAt`
- only B: `article_duplicate_review.id`
- only B: `article_duplicate_review.keptArticleId`
- only B: `article_duplicate_review.maxSize`
- only B: `article_duplicate_review.minSize`
- only B: `article_duplicate_review.reviewSavedAt`
- only B: `article_duplicate_review.updatedAt`

## tables

32 in A, 33 in B — only in A: 0, only in B: 1, different: 0

- only B: `article_duplicate_review`

## indexes

69 in A, 69 in B — only in A: 0, only in B: 0, different: 0


## constraints

330 in A, 330 in B — only in A: 0, only in B: 0, different: 0


## triggers

6 in A, 6 in B — only in A: 0, only in B: 0, different: 0


## functions

4 in A, 4 in B — only in A: 0, only in B: 0, different: 0


## enums

2 in A, 2 in B — only in A: 0, only in B: 0, different: 0


## rowCounts

30 in A, 31 in B — only in A: 0, only in B: 1, different: 16

| Table | A | B |
|---|---:|---:|
| account | 0 | 4 |
| article_colors | 2772 | 2778 |
| article_duplicate_archive | 111 | 0 |
| article_duplicate_review | — | 110 |
| article_mrps | 0 | 9 |
| article_scan_links | 0 | 4 |
| article_size_ranges | 704 | 704 |
| article_sizes | 15628 | 15763 |
| articles | 2772 | 2778 |
| audit_events | 867 | 1008 |
| bill_lines | 0 | 0 |
| catalog_articles | 267 | 267 |
| catalog_import_batches | 1 | 1 |
| catalog_review_items | 21 | 31 |
| catalog_source_rows | 714 | 714 |
| flags | 2 | 2 |
| legacy_scans | 0 | 10 |
| locations | 1 | 1 |
| missing_article_reviews | 0 | 0 |
| order_items | 0 | 0 |
| order_sets | 0 | 0 |
| orders | 0 | 0 |
| retailers | 0 | 0 |
| scan_events | 0 | 10 |
| schema_migrations | 5 | 5 |
| session | 0 | 14 |
| stock_balances | 0 | 10 |
| stock_movements | 0 | 10 |
| suppliers | 0 | 0 |
| user | 0 | 4 |
| verification | 0 | 1 |

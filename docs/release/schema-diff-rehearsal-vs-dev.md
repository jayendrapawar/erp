# Schema comparison

A = `ep-damp-scene-b3i40jjo` schema rehearsal_prod2 (.env.local), B = `ep-damp-scene-b3i40jjo` schema public (.env.local). Generated 2026-11-18T14:48:56.806Z, read-only.

## Migration tracking

A: schema_migrations 0000 baseline (applied); schema_migrations 0001 feature01_articles (applied); schema_migrations 0002 inventory_foundation (applied); schema_migrations 0003 article_catalog (applied); schema_migrations 0004 article_duplicate_archive (applied); schema_migrations 0005 carton_assortments (applied)

B: schema_migrations 0000 baseline (adopted); schema_migrations 0001 feature01_articles (adopted); schema_migrations 0002 inventory_foundation (applied); schema_migrations 0003 article_catalog (applied); schema_migrations 0004 article_duplicate_archive (applied); schema_migrations 0005 carton_assortments (applied)

## columns

336 in A, 336 in B — only in A: 0, only in B: 0, different: 0


## tables

33 in A, 33 in B — only in A: 0, only in B: 0, different: 0


## indexes

72 in A, 72 in B — only in A: 0, only in B: 0, different: 0


## constraints

353 in A, 353 in B — only in A: 0, only in B: 0, different: 0


## triggers

6 in A, 6 in B — only in A: 0, only in B: 0, different: 0


## functions

4 in A, 4 in B — only in A: 0, only in B: 0, different: 0


## enums

2 in A, 2 in B — only in A: 0, only in B: 0, different: 0


## rowCounts

31 in A, 31 in B — only in A: 0, only in B: 0, different: 2

| Table | A | B |
|---|---:|---:|
| account | 4 | 4 |
| article_colors | 651 | 651 |
| article_duplicate_archive | 0 | 0 |
| article_mrps | 0 | 0 |
| article_scan_links | 0 | 0 |
| article_size_ranges | 704 | 704 |
| article_sizes | 3120 | 3120 |
| articles | 651 | 651 |
| audit_events | 3 | 1022 |
| bill_lines | 0 | 0 |
| carton_assortments | 32 | 32 |
| catalog_articles | 267 | 267 |
| catalog_import_batches | 1 | 1 |
| catalog_review_items | 0 | 0 |
| catalog_source_rows | 714 | 714 |
| flags | 2 | 2 |
| legacy_scans | 0 | 0 |
| locations | 1 | 1 |
| missing_article_reviews | 0 | 0 |
| order_items | 0 | 0 |
| order_sets | 0 | 0 |
| orders | 0 | 0 |
| retailers | 0 | 0 |
| scan_events | 0 | 0 |
| schema_migrations | 6 | 6 |
| session | 17 | 14 |
| stock_balances | 0 | 0 |
| stock_movements | 0 | 0 |
| suppliers | 0 | 0 |
| user | 4 | 4 |
| verification | 1 | 1 |

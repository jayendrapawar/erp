# Legacy migration files (history only)

These SQL files were applied by hand before 18 Nov 2026. They are inconsistent (duplicate
numbers 0002–0004, 0006 missing, the drizzle journal lists only four of them, and no file
creates the `vendors` table), so they cannot rebuild a database.

They were replaced by `db/migrations/0000_baseline.sql` (production schema as of 18 Nov 2026)
and `0001_feature01_articles.sql` (the content of 0011–0014). Do not run anything in this folder.

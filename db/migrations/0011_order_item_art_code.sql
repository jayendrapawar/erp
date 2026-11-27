-- detect: select exists (select 1 from information_schema.columns where table_name = 'order_items' and column_name = 'artCode') as present
--
-- Article code on order lines (owner, 20 Nov 2026). One article NAME can cover several codes with
-- overlapping sizes (SS-101: SS0101C children 11–13, 1; SS0101G 6–10; SS0101S big 11–12), so
-- "SS-101 Black size 11" was ambiguous. New Order now saves the exact code; picking and billing
-- use it when present. Older lines keep NULL (matched by name as before).
--
-- One nullable column; no data change. Rollback: ALTER TABLE order_items DROP COLUMN "artCode".

ALTER TABLE order_items ADD COLUMN "artCode" text;

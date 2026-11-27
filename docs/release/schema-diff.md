# Schema comparison

A = `ep-royal-tooth-b3ub6jie` (.env), B = `ep-damp-scene-b3i40jjo` (.env.local). Generated 2026-11-18T11:16:58.472Z, read-only.

## Migration tracking

A: none (no schema_migrations, no drizzle journal)

B: schema_migrations 0000 baseline (adopted); schema_migrations 0001 feature01_articles (adopted); schema_migrations 0002 inventory_foundation (applied); schema_migrations 0003 article_catalog (applied)

## columns

139 in A, 320 in B — only in A: 38, only in B: 219, different: 0

- only A: `articles.createdAt`
- only A: `articles.updatedAt`
- only A: `scans.artNumber`
- only A: `scans.boxCodes`
- only A: `scans.colorNumber`
- only A: `scans.createdAt`
- only A: `scans.division`
- only A: `scans.entryType`
- only A: `scans.id`
- only A: `scans.mfgMonth`
- only A: `scans.mfgYear`
- only A: `scans.mrp`
- only A: `scans.notes`
- only A: `scans.quantity`
- only A: `scans.rawQrCode`
- only A: `scans.scannedAt`
- only A: `scans.scannedByName`
- only A: `scans.sizeNumber`
- only A: `scans.updatedAt`
- only A: `shopkeepers.address`
- only A: `shopkeepers.code`
- only A: `shopkeepers.createdAt`
- only A: `shopkeepers.id`
- only A: `shopkeepers.name`
- only A: `shopkeepers.phone`
- only A: `shopkeepers.updatedAt`
- only A: `vendors.address`
- only A: `vendors.area`
- only A: `vendors.city`
- only A: `vendors.createdAt`
- only A: `vendors.day`
- only A: `vendors.gst`
- only A: `vendors.id`
- only A: `vendors.partyName`
- only A: `vendors.phone`
- only A: `vendors.salesman`
- only A: `vendors.status`
- only A: `vendors.updatedAt`
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
- only B: `article_mrps.artCode`
- only B: `article_mrps.id`
- only B: `article_mrps.mrp`
- only B: `article_quality_issues.articleId`
- only B: `article_quality_issues.issue`
- only B: `article_scan_links.action`
- only B: `article_scan_links.articleId`
- only B: `article_scan_links.createdAt`
- only B: `article_scan_links.id`
- only B: `article_scan_links.rawQr`
- only B: `article_scan_links.scanEventId`
- only B: `article_scan_links.userId`
- only B: `article_scan_links.userName`
- only B: `article_size_ranges.active`
- only B: `article_size_ranges.articleId`
- only B: `article_size_ranges.createdAt`
- only B: `article_size_ranges.id`
- only B: `article_size_ranges.maxSize`
- only B: `article_size_ranges.minSize`
- only B: `article_size_ranges.sizes`
- only B: `article_size_ranges.sourceBatchId`
- only B: `article_sizes.active`
- only B: `articles.active`
- only B: `articles.catalogArticleId`
- only B: `articles.division`
- only B: `articles.retiredAt`
- only B: `articles.retiredReason`
- only B: `articles.reviewStatus`
- only B: `articles.source`
- only B: `audit_events.action`
- only B: `audit_events.actorName`
- only B: `audit_events.actorUserId`
- only B: `audit_events.after`
- only B: `audit_events.before`
- only B: `audit_events.entityId`
- only B: `audit_events.entityType`
- only B: `audit_events.id`
- only B: `audit_events.metadata`
- only B: `audit_events.occurredAt`
- only B: `audit_events.reason`
- only B: `catalog_articles.active`
- only B: `catalog_articles.artCode`
- only B: `catalog_articles.artName`
- only B: `catalog_articles.brand`
- only B: `catalog_articles.createdAt`
- only B: `catalog_articles.id`
- only B: `catalog_articles.reviewStatus`
- only B: `catalog_articles.segmentHint`
- only B: `catalog_articles.source`
- only B: `catalog_articles.updatedAt`
- only B: `catalog_import_batches.appliedAt`
- only B: `catalog_import_batches.appliedBy`
- only B: `catalog_import_batches.appliedByName`
- only B: `catalog_import_batches.fileName`
- only B: `catalog_import_batches.fileSha256`
- only B: `catalog_import_batches.id`
- only B: `catalog_import_batches.rowCount`
- only B: `catalog_import_batches.sheetName`
- only B: `catalog_import_batches.source`
- only B: `catalog_import_batches.summary`
- only B: `catalog_review_items.artCode`
- only B: `catalog_review_items.articleId`
- only B: `catalog_review_items.colorCode`
- only B: `catalog_review_items.createdAt`
- only B: `catalog_review_items.details`
- only B: `catalog_review_items.firstBatchId`
- only B: `catalog_review_items.id`
- only B: `catalog_review_items.kind`
- only B: `catalog_review_items.lastBatchId`
- only B: `catalog_review_items.message`
- only B: `catalog_review_items.resolution`
- only B: `catalog_review_items.resolvedAt`
- only B: `catalog_review_items.resolvedBy`
- only B: `catalog_review_items.severity`
- only B: `catalog_review_items.status`
- only B: `catalog_review_items.subjectKey`
- only B: `catalog_source_rows.artCode`
- only B: `catalog_source_rows.artName`
- only B: `catalog_source_rows.articleId`
- only B: `catalog_source_rows.batchId`
- only B: `catalog_source_rows.color`
- only B: `catalog_source_rows.colorCode`
- only B: `catalog_source_rows.id`
- only B: `catalog_source_rows.maxSize`
- only B: `catalog_source_rows.minSize`
- only B: `catalog_source_rows.outcome`
- only B: `catalog_source_rows.raw`
- only B: `catalog_source_rows.rowNumber`
- only B: `legacy_scans.artNumber`
- only B: `legacy_scans.boxCodes`
- only B: `legacy_scans.colorNumber`
- only B: `legacy_scans.createdAt`
- only B: `legacy_scans.division`
- only B: `legacy_scans.entryType`
- only B: `legacy_scans.id`
- only B: `legacy_scans.mfgMonth`
- only B: `legacy_scans.mfgYear`
- only B: `legacy_scans.mrp`
- only B: `legacy_scans.notes`
- only B: `legacy_scans.quantity`
- only B: `legacy_scans.rawQrCode`
- only B: `legacy_scans.scannedAt`
- only B: `legacy_scans.scannedByName`
- only B: `legacy_scans.sizeNumber`
- only B: `legacy_scans.updatedAt`
- only B: `locations.active`
- only B: `locations.code`
- only B: `locations.createdAt`
- only B: `locations.id`
- only B: `locations.kind`
- only B: `locations.name`
- only B: `locations.parentId`
- only B: `missing_article_reviews.articleCode`
- only B: `missing_article_reviews.colourCode`
- only B: `missing_article_reviews.note`
- only B: `missing_article_reviews.status`
- only B: `missing_article_reviews.updatedAt`
- only B: `missing_article_reviews.updatedBy`
- only B: `orders.retailerId`
- only B: `retailers.address`
- only B: `retailers.area`
- only B: `retailers.city`
- only B: `retailers.createdAt`
- only B: `retailers.day`
- only B: `retailers.gst`
- only B: `retailers.id`
- only B: `retailers.partyName`
- only B: `retailers.phone`
- only B: `retailers.salesman`
- only B: `retailers.status`
- only B: `retailers.updatedAt`
- only B: `scan_events.articleCode`
- only B: `scan_events.articleId`
- only B: `scan_events.clientEventId`
- only B: `scan_events.colourCode`
- only B: `scan_events.createdAt`
- only B: `scan_events.dedupeKey`
- only B: `scan_events.deviceAt`
- only B: `scan_events.entryType`
- only B: `scan_events.flag`
- only B: `scan_events.formatId`
- only B: `scan_events.id`
- only B: `scan_events.legacyScanId`
- only B: `scan_events.locationId`
- only B: `scan_events.mfgMonth`
- only B: `scan_events.mfgYear`
- only B: `scan_events.mrp`
- only B: `scan_events.notes`
- only B: `scan_events.parseStatus`
- only B: `scan_events.parsed`
- only B: `scan_events.parserVersion`
- only B: `scan_events.payload`
- only B: `scan_events.purpose`
- only B: `scan_events.quantity`
- only B: `scan_events.rawInput`
- only B: `scan_events.resolution`
- only B: `scan_events.sizeLabel`
- only B: `scan_events.skuId`
- only B: `scan_events.source`
- only B: `scan_events.status`
- only B: `scan_events.userId`
- only B: `scan_events.userName`
- only B: `scan_events.voidReason`
- only B: `scan_events.voidedAt`
- only B: `scan_events.voidedBy`
- only B: `schema_migrations.applied_at`
- only B: `schema_migrations.checksum`
- only B: `schema_migrations.execution_ms`
- only B: `schema_migrations.method`
- only B: `schema_migrations.name`
- only B: `schema_migrations.version`
- only B: `stock_balance_mismatches.balance_quantity`
- only B: `stock_balance_mismatches.ledger_quantity`
- only B: `stock_balance_mismatches.locationId`
- only B: `stock_balance_mismatches.provenance`
- only B: `stock_balance_mismatches.skuId`
- only B: `stock_balances.locationId`
- only B: `stock_balances.provenance`
- only B: `stock_balances.quantity`
- only B: `stock_balances.skuId`
- only B: `stock_balances.updatedAt`
- only B: `stock_movements.createdAt`
- only B: `stock_movements.id`
- only B: `stock_movements.idempotencyKey`
- only B: `stock_movements.locationId`
- only B: `stock_movements.movementType`
- only B: `stock_movements.provenance`
- only B: `stock_movements.quantity`
- only B: `stock_movements.reason`
- only B: `stock_movements.reversalOfId`
- only B: `stock_movements.skuId`
- only B: `stock_movements.sourceId`
- only B: `stock_movements.sourceType`
- only B: `stock_movements.userId`
- only B: `suppliers.address`
- only B: `suppliers.city`
- only B: `suppliers.contactPerson`
- only B: `suppliers.createdAt`
- only B: `suppliers.divisions`
- only B: `suppliers.email`
- only B: `suppliers.gst`
- only B: `suppliers.id`
- only B: `suppliers.name`
- only B: `suppliers.notes`
- only B: `suppliers.paymentTermsDays`
- only B: `suppliers.phone`
- only B: `suppliers.status`
- only B: `suppliers.updatedAt`

## tables

15 in A, 32 in B — only in A: 3, only in B: 20, different: 0

- only A: `scans`
- only A: `shopkeepers`
- only A: `vendors`
- only B: `article_duplicate_review`
- only B: `article_mrps`
- only B: `article_quality_issues`
- only B: `article_scan_links`
- only B: `article_size_ranges`
- only B: `audit_events`
- only B: `catalog_articles`
- only B: `catalog_import_batches`
- only B: `catalog_review_items`
- only B: `catalog_source_rows`
- only B: `legacy_scans`
- only B: `locations`
- only B: `missing_article_reviews`
- only B: `retailers`
- only B: `scan_events`
- only B: `schema_migrations`
- only B: `stock_balance_mismatches`
- only B: `stock_balances`
- only B: `stock_movements`
- only B: `suppliers`

## indexes

23 in A, 68 in B — only in A: 5, only in B: 50, different: 0

- only A: `scans_pkey`
- only A: `shopkeepers_name_idx`
- only A: `shopkeepers_pkey`
- only A: `vendors_party_name_idx`
- only A: `vendors_pkey`
- only B: `article_mrps_artCode_mrp_unique`
- only B: `article_mrps_pkey`
- only B: `article_scan_links_pkey`
- only B: `article_size_ranges_pkey`
- only B: `article_size_ranges_unique`
- only B: `article_sizes_article_size_unique`
- only B: `articles_artCode_colorCode_unique`
- only B: `articles_catalog_article_idx`
- only B: `articles_code_colour_idx`
- only B: `audit_events_action_idx`
- only B: `audit_events_actor_idx`
- only B: `audit_events_entity_idx`
- only B: `audit_events_pkey`
- only B: `catalog_articles_code_unique`
- only B: `catalog_articles_name_idx`
- only B: `catalog_articles_pkey`
- only B: `catalog_import_batches_pkey`
- only B: `catalog_review_items_open_idx`
- only B: `catalog_review_items_pkey`
- only B: `catalog_review_items_subject_unique`
- only B: `catalog_source_rows_article_idx`
- only B: `catalog_source_rows_pkey`
- only B: `catalog_source_rows_unique`
- only B: `legacy_scans_pkey`
- only B: `locations_code_unique`
- only B: `locations_pkey`
- only B: `missing_article_reviews_pkey`
- only B: `orders_retailer_idx`
- only B: `retailers_party_name_idx`
- only B: `retailers_party_name_unique`
- only B: `retailers_pkey`
- only B: `scan_events_active_label_unique`
- only B: `scan_events_client_event_unique`
- only B: `scan_events_legacy_unique`
- only B: `scan_events_pkey`
- only B: `scan_events_recent_idx`
- only B: `scan_events_sku_idx`
- only B: `scan_events_unresolved_idx`
- only B: `scan_events_user_recent_idx`
- only B: `schema_migrations_pkey`
- only B: `stock_balances_location_idx`
- only B: `stock_balances_pkey`
- only B: `stock_movements_created_idx`
- only B: `stock_movements_idempotency_unique`
- only B: `stock_movements_pkey`
- only B: `stock_movements_reversal_once`
- only B: `stock_movements_sku_idx`
- only B: `stock_movements_source_idx`
- only B: `suppliers_name_unique`
- only B: `suppliers_pkey`

## constraints

122 in A, 319 in B — only in A: 27, only in B: 224, different: 0

- only A: `articles.articles_createdAt_not_null`
- only A: `articles.articles_updatedAt_not_null`
- only A: `scans.scans_createdAt_not_null`
- only A: `scans.scans_entryType_not_null`
- only A: `scans.scans_id_not_null`
- only A: `scans.scans_pkey`
- only A: `scans.scans_quantity_not_null`
- only A: `scans.scans_scannedAt_not_null`
- only A: `scans.scans_updatedAt_not_null`
- only A: `shopkeepers.shopkeepers_createdAt_not_null`
- only A: `shopkeepers.shopkeepers_id_not_null`
- only A: `shopkeepers.shopkeepers_name_not_null`
- only A: `shopkeepers.shopkeepers_pkey`
- only A: `shopkeepers.shopkeepers_updatedAt_not_null`
- only A: `vendors.vendors_address_not_null`
- only A: `vendors.vendors_area_not_null`
- only A: `vendors.vendors_city_not_null`
- only A: `vendors.vendors_createdAt_not_null`
- only A: `vendors.vendors_day_not_null`
- only A: `vendors.vendors_gst_not_null`
- only A: `vendors.vendors_id_not_null`
- only A: `vendors.vendors_partyName_not_null`
- only A: `vendors.vendors_phone_not_null`
- only A: `vendors.vendors_pkey`
- only A: `vendors.vendors_salesman_not_null`
- only A: `vendors.vendors_status_not_null`
- only A: `vendors.vendors_updatedAt_not_null`
- only B: `article_mrps.article_mrps_artCode_mrp_unique`
- only B: `article_mrps.article_mrps_artCode_normalized_check`
- only B: `article_mrps.article_mrps_artCode_not_null`
- only B: `article_mrps.article_mrps_id_not_null`
- only B: `article_mrps.article_mrps_mrp_not_null`
- only B: `article_mrps.article_mrps_pkey`
- only B: `article_scan_links.article_scan_links_action_check`
- only B: `article_scan_links.article_scan_links_action_not_null`
- only B: `article_scan_links.article_scan_links_articleId_fkey`
- only B: `article_scan_links.article_scan_links_articleId_not_null`
- only B: `article_scan_links.article_scan_links_createdAt_not_null`
- only B: `article_scan_links.article_scan_links_id_not_null`
- only B: `article_scan_links.article_scan_links_pkey`
- only B: `article_scan_links.article_scan_links_rawQr_not_null`
- only B: `article_scan_links.article_scan_links_scan_event_fk`
- only B: `article_scan_links.article_scan_links_userId_fkey`
- only B: `article_scan_links.article_scan_links_userName_not_null`
- only B: `article_size_ranges.article_size_ranges_active_not_null`
- only B: `article_size_ranges.article_size_ranges_articleId_fkey`
- only B: `article_size_ranges.article_size_ranges_articleId_not_null`
- only B: `article_size_ranges.article_size_ranges_batch_fkey`
- only B: `article_size_ranges.article_size_ranges_createdAt_not_null`
- only B: `article_size_ranges.article_size_ranges_id_not_null`
- only B: `article_size_ranges.article_size_ranges_maxSize_not_null`
- only B: `article_size_ranges.article_size_ranges_minSize_not_null`
- only B: `article_size_ranges.article_size_ranges_pkey`
- only B: `article_size_ranges.article_size_ranges_sizes_not_null`
- only B: `article_size_ranges.article_size_ranges_sizes_present`
- only B: `article_size_ranges.article_size_ranges_unique`
- only B: `article_sizes.article_sizes_active_not_null`
- only B: `article_sizes.article_sizes_article_size_unique`
- only B: `articles.articles_active_not_null`
- only B: `articles.articles_catalogArticleId_fkey`
- only B: `articles.articles_reviewStatus_check`
- only B: `articles.articles_reviewStatus_not_null`
- only B: `articles.articles_source_check`
- only B: `articles.articles_source_not_null`
- only B: `audit_events.audit_events_action_not_null`
- only B: `audit_events.audit_events_actorName_not_null`
- only B: `audit_events.audit_events_actorUserId_fkey`
- only B: `audit_events.audit_events_entityId_not_null`
- only B: `audit_events.audit_events_entityType_not_null`
- only B: `audit_events.audit_events_id_not_null`
- only B: `audit_events.audit_events_occurredAt_not_null`
- only B: `audit_events.audit_events_pkey`
- only B: `catalog_articles.catalog_articles_active_not_null`
- only B: `catalog_articles.catalog_articles_artCode_not_null`
- only B: `catalog_articles.catalog_articles_artName_not_null`
- only B: `catalog_articles.catalog_articles_code_normalised`
- only B: `catalog_articles.catalog_articles_code_unique`
- only B: `catalog_articles.catalog_articles_createdAt_not_null`
- only B: `catalog_articles.catalog_articles_id_not_null`
- only B: `catalog_articles.catalog_articles_pkey`
- only B: `catalog_articles.catalog_articles_reviewStatus_check`
- only B: `catalog_articles.catalog_articles_reviewStatus_not_null`
- only B: `catalog_articles.catalog_articles_source_check`
- only B: `catalog_articles.catalog_articles_source_not_null`
- only B: `catalog_articles.catalog_articles_updatedAt_not_null`
- only B: `catalog_import_batches.catalog_import_batches_appliedAt_not_null`
- only B: `catalog_import_batches.catalog_import_batches_appliedByName_not_null`
- only B: `catalog_import_batches.catalog_import_batches_appliedBy_fkey`
- only B: `catalog_import_batches.catalog_import_batches_fileName_not_null`
- only B: `catalog_import_batches.catalog_import_batches_fileSha256_not_null`
- only B: `catalog_import_batches.catalog_import_batches_id_not_null`
- only B: `catalog_import_batches.catalog_import_batches_pkey`
- only B: `catalog_import_batches.catalog_import_batches_rowCount_not_null`
- only B: `catalog_import_batches.catalog_import_batches_sheetName_not_null`
- only B: `catalog_import_batches.catalog_import_batches_source_not_null`
- only B: `catalog_import_batches.catalog_import_batches_summary_not_null`
- only B: `catalog_review_items.catalog_review_items_artCode_not_null`
- only B: `catalog_review_items.catalog_review_items_articleId_fkey`
- only B: `catalog_review_items.catalog_review_items_createdAt_not_null`
- only B: `catalog_review_items.catalog_review_items_firstBatchId_fkey`
- only B: `catalog_review_items.catalog_review_items_id_not_null`
- only B: `catalog_review_items.catalog_review_items_kind_not_null`
- only B: `catalog_review_items.catalog_review_items_lastBatchId_fkey`
- only B: `catalog_review_items.catalog_review_items_message_not_null`
- only B: `catalog_review_items.catalog_review_items_pkey`
- only B: `catalog_review_items.catalog_review_items_resolvedBy_fkey`
- only B: `catalog_review_items.catalog_review_items_severity_check`
- only B: `catalog_review_items.catalog_review_items_severity_not_null`
- only B: `catalog_review_items.catalog_review_items_status_check`
- only B: `catalog_review_items.catalog_review_items_status_not_null`
- only B: `catalog_review_items.catalog_review_items_subjectKey_not_null`
- only B: `catalog_review_items.catalog_review_items_subject_unique`
- only B: `catalog_source_rows.catalog_source_rows_artCode_not_null`
- only B: `catalog_source_rows.catalog_source_rows_artName_not_null`
- only B: `catalog_source_rows.catalog_source_rows_articleId_fkey`
- only B: `catalog_source_rows.catalog_source_rows_batchId_fkey`
- only B: `catalog_source_rows.catalog_source_rows_batchId_not_null`
- only B: `catalog_source_rows.catalog_source_rows_colorCode_not_null`
- only B: `catalog_source_rows.catalog_source_rows_color_not_null`
- only B: `catalog_source_rows.catalog_source_rows_id_not_null`
- only B: `catalog_source_rows.catalog_source_rows_maxSize_not_null`
- only B: `catalog_source_rows.catalog_source_rows_minSize_not_null`
- only B: `catalog_source_rows.catalog_source_rows_outcome_check`
- only B: `catalog_source_rows.catalog_source_rows_outcome_not_null`
- only B: `catalog_source_rows.catalog_source_rows_pkey`
- only B: `catalog_source_rows.catalog_source_rows_raw_not_null`
- only B: `catalog_source_rows.catalog_source_rows_rowNumber_not_null`
- only B: `catalog_source_rows.catalog_source_rows_unique`
- only B: `legacy_scans.legacy_scans_pkey`
- only B: `legacy_scans.scans_createdAt_not_null`
- only B: `legacy_scans.scans_entryType_not_null`
- only B: `legacy_scans.scans_id_not_null`
- only B: `legacy_scans.scans_quantity_not_null`
- only B: `legacy_scans.scans_scannedAt_not_null`
- only B: `legacy_scans.scans_updatedAt_not_null`
- only B: `locations.locations_active_not_null`
- only B: `locations.locations_code_not_null`
- only B: `locations.locations_code_unique`
- only B: `locations.locations_createdAt_not_null`
- only B: `locations.locations_id_not_null`
- only B: `locations.locations_kind_check`
- only B: `locations.locations_kind_not_null`
- only B: `locations.locations_name_not_null`
- only B: `locations.locations_parentId_fkey`
- only B: `locations.locations_parent_check`
- only B: `locations.locations_pkey`
- only B: `missing_article_reviews.missing_article_reviews_articleCode_not_null`
- only B: `missing_article_reviews.missing_article_reviews_colourCode_not_null`
- only B: `missing_article_reviews.missing_article_reviews_note_not_null`
- only B: `missing_article_reviews.missing_article_reviews_pkey`
- only B: `missing_article_reviews.missing_article_reviews_status_check`
- only B: `missing_article_reviews.missing_article_reviews_status_not_null`
- only B: `missing_article_reviews.missing_article_reviews_updatedAt_not_null`
- only B: `missing_article_reviews.missing_article_reviews_updatedBy_fkey`
- only B: `orders.orders_retailerId_fkey`
- only B: `retailers.retailers_pkey`
- only B: `retailers.vendors_address_not_null`
- only B: `retailers.vendors_area_not_null`
- only B: `retailers.vendors_city_not_null`
- only B: `retailers.vendors_createdAt_not_null`
- only B: `retailers.vendors_day_not_null`
- only B: `retailers.vendors_gst_not_null`
- only B: `retailers.vendors_id_not_null`
- only B: `retailers.vendors_partyName_not_null`
- only B: `retailers.vendors_phone_not_null`
- only B: `retailers.vendors_salesman_not_null`
- only B: `retailers.vendors_status_not_null`
- only B: `retailers.vendors_updatedAt_not_null`
- only B: `scan_events.scan_events_articleId_fkey`
- only B: `scan_events.scan_events_clientEventId_not_null`
- only B: `scan_events.scan_events_client_event_unique`
- only B: `scan_events.scan_events_createdAt_not_null`
- only B: `scan_events.scan_events_entryType_check`
- only B: `scan_events.scan_events_entryType_not_null`
- only B: `scan_events.scan_events_id_not_null`
- only B: `scan_events.scan_events_locationId_fkey`
- only B: `scan_events.scan_events_locationId_not_null`
- only B: `scan_events.scan_events_mfgMonth_check`
- only B: `scan_events.scan_events_parseStatus_check`
- only B: `scan_events.scan_events_pkey`
- only B: `scan_events.scan_events_purpose_check`
- only B: `scan_events.scan_events_purpose_not_null`
- only B: `scan_events.scan_events_quantity_check`
- only B: `scan_events.scan_events_quantity_not_null`
- only B: `scan_events.scan_events_resolution_check`
- only B: `scan_events.scan_events_resolution_not_null`
- only B: `scan_events.scan_events_resolved_has_sku`
- only B: `scan_events.scan_events_scan_has_input`
- only B: `scan_events.scan_events_scan_is_single`
- only B: `scan_events.scan_events_skuId_fkey`
- only B: `scan_events.scan_events_source_check`
- only B: `scan_events.scan_events_source_not_null`
- only B: `scan_events.scan_events_status_check`
- only B: `scan_events.scan_events_status_not_null`
- only B: `scan_events.scan_events_userId_fkey`
- only B: `scan_events.scan_events_userName_not_null`
- only B: `scan_events.scan_events_void_complete`
- only B: `scan_events.scan_events_voidedBy_fkey`
- only B: `schema_migrations.schema_migrations_applied_at_not_null`
- only B: `schema_migrations.schema_migrations_checksum_not_null`
- only B: `schema_migrations.schema_migrations_method_check`
- only B: `schema_migrations.schema_migrations_method_not_null`
- only B: `schema_migrations.schema_migrations_name_not_null`
- only B: `schema_migrations.schema_migrations_pkey`
- only B: `schema_migrations.schema_migrations_version_not_null`
- only B: `stock_balances.stock_balances_locationId_fkey`
- only B: `stock_balances.stock_balances_locationId_not_null`
- only B: `stock_balances.stock_balances_pkey`
- only B: `stock_balances.stock_balances_provenance_check`
- only B: `stock_balances.stock_balances_provenance_not_null`
- only B: `stock_balances.stock_balances_quantity_not_null`
- only B: `stock_balances.stock_balances_skuId_fkey`
- only B: `stock_balances.stock_balances_skuId_not_null`
- only B: `stock_balances.stock_balances_updatedAt_not_null`
- only B: `stock_movements.stock_movements_createdAt_not_null`
- only B: `stock_movements.stock_movements_id_not_null`
- only B: `stock_movements.stock_movements_idempotencyKey_not_null`
- only B: `stock_movements.stock_movements_idempotency_unique`
- only B: `stock_movements.stock_movements_locationId_fkey`
- only B: `stock_movements.stock_movements_locationId_not_null`
- only B: `stock_movements.stock_movements_movementType_check`
- only B: `stock_movements.stock_movements_movementType_not_null`
- only B: `stock_movements.stock_movements_pkey`
- only B: `stock_movements.stock_movements_provenance_check`
- only B: `stock_movements.stock_movements_provenance_not_null`
- only B: `stock_movements.stock_movements_quantity_check`
- only B: `stock_movements.stock_movements_quantity_not_null`
- only B: `stock_movements.stock_movements_reversalOfId_fkey`
- only B: `stock_movements.stock_movements_reversal_once`
- only B: `stock_movements.stock_movements_reversal_type`
- only B: `stock_movements.stock_movements_skuId_fkey`
- only B: `stock_movements.stock_movements_skuId_not_null`
- only B: `stock_movements.stock_movements_sourceId_not_null`
- only B: `stock_movements.stock_movements_sourceType_not_null`
- only B: `stock_movements.stock_movements_userId_fkey`
- only B: `suppliers.suppliers_address_not_null`
- only B: `suppliers.suppliers_city_not_null`
- only B: `suppliers.suppliers_contactPerson_not_null`
- only B: `suppliers.suppliers_createdAt_not_null`
- only B: `suppliers.suppliers_divisions_not_null`
- only B: `suppliers.suppliers_email_not_null`
- only B: `suppliers.suppliers_gst_not_null`
- only B: `suppliers.suppliers_id_not_null`
- only B: `suppliers.suppliers_name_not_null`
- only B: `suppliers.suppliers_notes_not_null`
- only B: `suppliers.suppliers_paymentTermsDays_check`
- only B: `suppliers.suppliers_phone_not_null`
- only B: `suppliers.suppliers_pkey`
- only B: `suppliers.suppliers_status_check`
- only B: `suppliers.suppliers_status_not_null`
- only B: `suppliers.suppliers_updatedAt_not_null`

## triggers

0 in A, 6 in B — only in A: 0, only in B: 6, different: 0

- only B: `stock_balances.stock_balances_guard.DELETE`
- only B: `stock_balances.stock_balances_guard.INSERT`
- only B: `stock_balances.stock_balances_guard.UPDATE`
- only B: `stock_movements.stock_movements_apply.INSERT`
- only B: `stock_movements.stock_movements_no_update.DELETE`
- only B: `stock_movements.stock_movements_no_update.UPDATE`

## functions

0 in A, 4 in B — only in A: 0, only in B: 4, different: 0

- only B: `stock_balances_guard`
- only B: `stock_balances_rebuild`
- only B: `stock_movements_apply`
- only B: `stock_movements_immutable`

## enums

2 in A, 2 in B — only in A: 0, only in B: 0, different: 0


## rowCounts

15 in A, 30 in B — only in A: 3, only in B: 18, different: 4

| Table | A | B |
|---|---:|---:|
| account | 4 | 4 |
| article_colors | 2759 | 2778 |
| article_duplicate_review | — | 110 |
| article_mrps | — | 9 |
| article_scan_links | — | 4 |
| article_size_ranges | — | 704 |
| article_sizes | 15398 | 15763 |
| articles | 2759 | 2778 |
| audit_events | — | 1008 |
| bill_lines | 0 | 0 |
| catalog_articles | — | 267 |
| catalog_import_batches | — | 1 |
| catalog_review_items | — | 31 |
| catalog_source_rows | — | 714 |
| flags | 2 | 2 |
| legacy_scans | — | 10 |
| locations | — | 1 |
| missing_article_reviews | — | 0 |
| order_items | 0 | 0 |
| order_sets | 0 | 0 |
| orders | 0 | 0 |
| retailers | — | 0 |
| scan_events | — | 10 |
| scans | 0 | — |
| schema_migrations | — | 4 |
| session | 17 | 14 |
| shopkeepers | 0 | — |
| stock_balances | — | 10 |
| stock_movements | — | 10 |
| suppliers | — | 0 |
| user | 4 | 4 |
| vendors | 0 | — |
| verification | 1 | 1 |

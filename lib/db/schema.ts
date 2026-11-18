import { pgTable, text, timestamp, boolean, serial, integer, jsonb, numeric, unique, pgEnum, index, uniqueIndex, check, bigserial, bigint, uuid, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  role: text('role').default('user'),
  banned: boolean('banned').default(false),
  banReason: text('banReason'),
  banExpires: timestamp('banExpires'),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow(),
  updatedAt: timestamp('updatedAt').defaultNow(),
})

// --- Master data tables ---

// Retailers (parties we sell to). The table was called "vendors" until migration 0002;
// real suppliers live in `suppliers`.
export const retailers = pgTable('retailers', {
  id:         text('id').primaryKey(),
  partyName:  text('partyName').notNull(),
  gst:        text('gst').notNull().default(''),
  phone:      text('phone').notNull().default(''),
  address:    text('address').notNull().default(''),
  city:       text('city').notNull().default(''),
  area:       text('area').notNull().default(''),
  day:        text('day').notNull().default(''),
  salesman:   text('salesman').notNull().default(''),
  status:     text('status').notNull().default('active'),
  createdAt:  timestamp('createdAt').notNull().defaultNow(),
  updatedAt:  timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [
  index('retailers_party_name_idx').on(t.partyName),
])

/** @deprecated The table holds retailers. Use `retailers`. */
export const vendors = retailers

export const suppliers = pgTable('suppliers', {
  id:               serial('id').primaryKey(),
  name:             text('name').notNull(),
  contactPerson:    text('contactPerson').notNull().default(''),
  phone:            text('phone').notNull().default(''),
  email:            text('email').notNull().default(''),
  gst:              text('gst').notNull().default(''),
  address:          text('address').notNull().default(''),
  city:             text('city').notNull().default(''),
  divisions:        text('divisions').array().notNull().default(sql`'{}'::text[]`),
  paymentTermsDays: integer('paymentTermsDays'),
  notes:            text('notes').notNull().default(''),
  status:           text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  createdAt:        timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export type ReviewStatus = 'unverified' | 'approved' | 'needs_review'

// Article = manufacturer article code (SS0702B). artName ("SS-702") is its display / family name
// and may cover several codes (boys and children's versions of one design).
export const catalogArticles = pgTable('catalog_articles', {
  id:           serial('id').primaryKey(),
  artCode:      text('artCode').notNull().unique('catalog_articles_code_unique'),
  artName:      text('artName').notNull(),
  brand:        text('brand'),
  /** Last letter of the code (G, L, B, C …). A hint only. */
  segmentHint:  text('segmentHint'),
  active:       boolean('active').notNull().default(true),
  reviewStatus: text('reviewStatus').$type<ReviewStatus>().notNull().default('unverified'),
  source:       text('source').$type<'legacy' | 'import' | 'manual' | 'scan_dialog'>().notNull().default('import'),
  createdAt:    timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

// VARIANTS: one row per article code + colour code (the table keeps its historical name
// "articles" because scans, SKUs and the stock ledger reference these ids).
// Never deleted once referenced; variants absent from the approved catalogue are retired
// (active = false, retiredAt set).
export const articles = pgTable('articles', {
  id:        serial('id').primaryKey(),
  artName:   text('artName').notNull().default(''),
  artCode:   text('artCode').notNull().default(''),
  color:     text('color').notNull().default(''),
  colorCode: text('colorCode').notNull().default(''),
  /** First and last size of the variant in size order (may wrap: 11 … 5 for children). SKUs are the source of truth. */
  maxSize:   text('maxSize').notNull().default(''),
  minSize:   text('minSize').notNull().default(''),
  // 'unverified' = imported, not yet reviewed (still usable); 'approved' = matches the approved
  // catalogue; 'needs_review' = usable, but the source had a conflict an admin must settle.
  reviewStatus: text('reviewStatus').$type<ReviewStatus>().notNull().default('unverified'),
  active:    boolean('active').notNull().default(true),
  source:    text('source').$type<'legacy' | 'import' | 'manual' | 'scan_dialog'>().notNull().default('legacy'),
  division:  text('division'),
  catalogArticleId: integer('catalogArticleId').references(() => catalogArticles.id, { onDelete: 'restrict' }),
  retiredAt:     timestamp('retiredAt', { withTimezone: true }),
  retiredReason: text('retiredReason'),
}, (t) => [
  index('articles_art_name_idx').on(t.artName),
  index('articles_catalog_article_idx').on(t.catalogArticleId),
  uniqueIndex('articles_artCode_colorCode_unique')
    .on(sql`upper(regexp_replace(btrim(${t.artCode}), '\\s+', ' ', 'g'))`, sql`upper(regexp_replace(btrim(${t.colorCode}), '\\s+', ' ', 'g'))`)
    .where(sql`btrim(${t.artCode}) <> '' AND btrim(${t.colorCode}) <> ''`),
])

export const articleMrps = pgTable('article_mrps', {
  id: serial('id').primaryKey(),
  artCode: text('artCode').notNull(),
  mrp: numeric('mrp', { precision: 10, scale: 2 }).notNull(),
}, (t) => [
  unique('article_mrps_artCode_mrp_unique').on(t.artCode, t.mrp),
  check('article_mrps_artCode_normalized_check', sql`${t.artCode} = upper(btrim(${t.artCode}))`),
])

export const articleScanLinks = pgTable('article_scan_links', {
  id: serial('id').primaryKey(),
  articleId: integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  action: text('action').$type<'created' | 'linked'>().notNull(),
  rawQr: text('rawQr').notNull(),
  userName: text('userName').notNull().default(''),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  userId: text('userId').references(() => user.id, { onDelete: 'set null' }),
  scanEventId: bigint('scanEventId', { mode: 'number' }),
})

export const articleColors = pgTable('article_colors', {
  id:          serial('id').primaryKey(),
  articleId:   integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  colorName:   text('colorName').notNull(),
  colorHex:    text('colorHex'),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
})

// Each row is a SKU (article + colour + size). Ids are referenced by the stock ledger:
// deactivate rows, never delete or re-create them.
export const articleSizes = pgTable('article_sizes', {
  id:          serial('id').primaryKey(),
  articleId:   integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  sizeLabel:   text('sizeLabel').notNull(),
  sortOrder:   integer('sortOrder').notNull().default(0),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
  active:      boolean('active').notNull().default(true),
}, (t) => [
  unique('article_sizes_article_size_unique').on(t.articleId, t.sizeLabel),
])

// Size ranges a variant was supplied with, kept as given (the SKUs are their expansion).
export const articleSizeRanges = pgTable('article_size_ranges', {
  id:            serial('id').primaryKey(),
  articleId:     integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  minSize:       text('minSize').notNull(),
  maxSize:       text('maxSize').notNull(),
  sizes:         text('sizes').array().notNull(),
  active:        boolean('active').notNull().default(true),
  sourceBatchId: integer('sourceBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('article_size_ranges_unique').on(t.articleId, t.minSize, t.maxSize)])

export const catalogImportBatches = pgTable('catalog_import_batches', {
  id:            serial('id').primaryKey(),
  source:        text('source').notNull(),
  fileName:      text('fileName').notNull(),
  fileSha256:    text('fileSha256').notNull(),
  sheetName:     text('sheetName').notNull(),
  rowCount:      integer('rowCount').notNull(),
  appliedBy:     text('appliedBy').references(() => user.id, { onDelete: 'set null' }),
  appliedByName: text('appliedByName').notNull().default(''),
  appliedAt:     timestamp('appliedAt', { withTimezone: true }).notNull().defaultNow(),
  summary:       jsonb('summary').notNull().default({}),
})

export const catalogSourceRows = pgTable('catalog_source_rows', {
  id:        bigserial('id', { mode: 'number' }).primaryKey(),
  batchId:   integer('batchId').notNull().references(() => catalogImportBatches.id, { onDelete: 'cascade' }),
  rowNumber: integer('rowNumber').notNull(),
  raw:       jsonb('raw').notNull(),
  artName:   text('artName').notNull().default(''),
  artCode:   text('artCode').notNull().default(''),
  color:     text('color').notNull().default(''),
  colorCode: text('colorCode').notNull().default(''),
  minSize:   text('minSize').notNull().default(''),
  maxSize:   text('maxSize').notNull().default(''),
  articleId: integer('articleId').references(() => articles.id, { onDelete: 'set null' }),
  outcome:   text('outcome').$type<'used' | 'duplicate' | 'rejected'>().notNull(),
}, (t) => [unique('catalog_source_rows_unique').on(t.batchId, t.rowNumber)])

export type CatalogReviewStatus = 'open' | 'resolved' | 'dismissed'

export const catalogReviewItems = pgTable('catalog_review_items', {
  id:           serial('id').primaryKey(),
  kind:         text('kind').notNull(),
  severity:     text('severity').$type<'info' | 'review' | 'error'>().notNull(),
  subjectKey:   text('subjectKey').notNull(),
  artCode:      text('artCode').notNull().default(''),
  colorCode:    text('colorCode'),
  articleId:    integer('articleId').references(() => articles.id, { onDelete: 'set null' }),
  message:      text('message').notNull(),
  details:      jsonb('details'),
  status:       text('status').$type<CatalogReviewStatus>().notNull().default('open'),
  firstBatchId: integer('firstBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  lastBatchId:  integer('lastBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  createdAt:    timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:   timestamp('resolvedAt', { withTimezone: true }),
  resolvedBy:   text('resolvedBy').references(() => user.id, { onDelete: 'set null' }),
  resolution:   text('resolution'),
}, (t) => [unique('catalog_review_items_subject_unique').on(t.kind, t.subjectKey)])

export type Article    = typeof articles.$inferSelect
export type ArticleColor = typeof articleColors.$inferSelect
export type ArticleSize  = typeof articleSizes.$inferSelect

// --- App tables: Inventory Management ---

// Read-only since migration 0002: merged rows from the old scanner. New scans go to scan_events.
// entryType: 'scan' = camera/image scan, 'manual' = manually entered
export const legacyScans = pgTable('legacy_scans', {
  id: serial('id').primaryKey(),
  entryType: text('entryType').notNull().default('scan'), // 'scan' | 'manual'
  rawQrCode: text('rawQrCode'),  // All rawQrCodes that have been merged into this row (one per physical box scanned)
  boxCodes: jsonb('boxCodes').$type<string[]>().default([]),
  artNumber: text('artNumber'),
  colorNumber: text('colorNumber'),
  sizeNumber: text('sizeNumber'),
  division: text('division'),
  mrp: numeric('mrp'),
  mfgMonth: integer('mfgMonth'),
  mfgYear: integer('mfgYear'),
  scannedByName: text('scannedByName'),
  notes: text('notes'),
  quantity: integer('quantity').notNull().default(1),
  scannedAt: timestamp('scannedAt').notNull().defaultNow(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// Scan grouping flags — shared across all users, list displayed in scanner UI
export const flags = pgTable('flags', {
  id:        serial('id').primaryKey(),
  name:      text('name').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (t) => [unique('flags_name_unique').on(t.name)])

// --- Order Management ---

export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'assigned',
  'packed',
  'billed',
  'dispatched',
  'delivered',
  'cancelled',
])

export const orderItemStatusEnum = pgEnum('order_item_status', [
  'pending',
  'packed',
  'out_of_stock',
])

export const orders = pgTable('orders', {
  id:                serial('id').primaryKey(),
  orderNumber:       text('orderNumber').notNull().unique(),
  shopkeeperName:    text('shopkeeperName').notNull(),
  shopkeeperPhone:   text('shopkeeperPhone'),
  shopkeeperAddress: text('shopkeeperAddress'),
  salesmanId:        text('salesmanId').references(() => user.id, { onDelete: 'set null' }),
  pickerId:          text('pickerId').references(() => user.id, { onDelete: 'set null' }),
  billerId:          text('billerId').references(() => user.id, { onDelete: 'set null' }),
  dispatcherId:      text('dispatcherId').references(() => user.id, { onDelete: 'set null' }),
  retailerId:        text('retailerId').references(() => retailers.id, { onDelete: 'restrict' }),
  status:            orderStatusEnum('status').notNull().default('pending'),
  notes:             text('notes'),
  totalBundles:      integer('totalBundles'),
  deliveryAgentName: text('deliveryAgentName'),
  isEmergency:       boolean('isEmergency').notNull().default(false),
  orderedAt:         timestamp('orderedAt').notNull().defaultNow(),
  packedAt:          timestamp('packedAt'),
  billedAt:          timestamp('billedAt'),
  dispatchedAt:      timestamp('dispatchedAt'),
  deliveredAt:       timestamp('deliveredAt'),
  createdAt:         timestamp('createdAt').notNull().defaultNow(),
  updatedAt:         timestamp('updatedAt').notNull().defaultNow(),
})

export const billLines = pgTable('bill_lines', {
  id:          serial('id').primaryKey(),
  orderId:     integer('orderId').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  artNumber:   text('artNumber').notNull(),
  mrp:         numeric('mrp', { precision: 10, scale: 2 }).notNull(),
  qty:         integer('qty').notNull(),
  lineDiscPct: numeric('lineDiscPct', { precision: 5, scale: 2 }).notNull().default('30'),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
})

export const orderItems = pgTable('order_items', {
  id:               serial('id').primaryKey(),
  orderId:          integer('orderId').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  artNumber:        text('artNumber').notNull(),
  colorNumber:      text('colorNumber'),
  sizeNumber:       text('sizeNumber'),
  quantityOrdered:  integer('quantityOrdered').notNull().default(1),
  quantityPacked:   integer('quantityPacked').notNull().default(0),
  status:           orderItemStatusEnum('status').notNull().default('pending'),
  createdAt:        timestamp('createdAt').notNull().defaultNow(),
  updatedAt:        timestamp('updatedAt').notNull().defaultNow(),
})

export type BillLine    = typeof billLines.$inferSelect
export type NewBillLine = typeof billLines.$inferInsert

export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert
export type OrderStatus = typeof orderStatusEnum.enumValues[number]
export type OrderItemStatus = typeof orderItemStatusEnum.enumValues[number]

// --- Size Sets (admin-defined size+quantity templates) ---

export const orderSets = pgTable('order_sets', {
  id:          serial('id').primaryKey(),
  name:        text('name').notNull(),
  // quantities: { [sizeLabel]: qty } — e.g. { "6": 1, "7": 2, "8": 2, "9": 2, "10": 1 }
  quantities:  jsonb('quantities').$type<Record<string, number>>().notNull().default({}),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
  updatedAt:   timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [
  unique('order_sets_name_unique').on(t.name),
])

export type OrderSet    = typeof orderSets.$inferSelect
export type NewOrderSet = typeof orderSets.$inferInsert

// ── Inventory foundation (migration 0002) ────────────────────────────────────

export const auditEvents = pgTable('audit_events', {
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt:  timestamp('occurredAt', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: text('actorUserId').references(() => user.id, { onDelete: 'set null' }),
  actorName:   text('actorName').notNull().default(''),
  action:      text('action').notNull(),
  entityType:  text('entityType').notNull(),
  entityId:    text('entityId').notNull(),
  before:      jsonb('before'),
  after:       jsonb('after'),
  reason:      text('reason'),
  metadata:    jsonb('metadata'),
})

export const locations = pgTable('locations', {
  id:        serial('id').primaryKey(),
  code:      text('code').notNull().unique('locations_code_unique'),
  name:      text('name').notNull(),
  kind:      text('kind').$type<'warehouse' | 'section' | 'rack' | 'shelf' | 'zone'>().notNull(),
  parentId:  integer('parentId'),
  active:    boolean('active').notNull().default(true),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export type ScanResolution = 'resolved' | 'missing_article' | 'missing_size'

export const scanEvents = pgTable('scan_events', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  clientEventId: uuid('clientEventId').notNull().unique('scan_events_client_event_unique'),
  purpose:       text('purpose').$type<'stocktake'>().notNull().default('stocktake'),
  entryType:     text('entryType').$type<'scan' | 'manual'>().notNull(),
  source:        text('source').$type<'app' | 'offline_sync' | 'legacy_import'>().notNull().default('app'),
  status:        text('status').$type<'active' | 'voided'>().notNull().default('active'),
  rawInput:      text('rawInput'),
  payload:       text('payload'),
  dedupeKey:     text('dedupeKey'),
  formatId:      text('formatId'),
  parserVersion: text('parserVersion'),
  parseStatus:   text('parseStatus').$type<'parsed' | 'partial' | 'manual'>(),
  parsed:        jsonb('parsed'),
  articleCode:   text('articleCode'),
  colourCode:    text('colourCode'),
  sizeLabel:     text('sizeLabel'),
  mrp:           numeric('mrp', { precision: 10, scale: 2 }),
  mfgMonth:      integer('mfgMonth'),
  mfgYear:       integer('mfgYear'),
  quantity:      integer('quantity').notNull().default(1),
  resolution:    text('resolution').$type<ScanResolution>().notNull(),
  articleId:     integer('articleId').references(() => articles.id, { onDelete: 'restrict' }),
  skuId:         integer('skuId').references(() => articleSizes.id, { onDelete: 'restrict' }),
  locationId:    integer('locationId').notNull().references(() => locations.id),
  flag:          text('flag'),
  notes:         text('notes'),
  userId:        text('userId').references(() => user.id, { onDelete: 'set null' }),
  userName:      text('userName').notNull().default(''),
  deviceAt:      timestamp('deviceAt', { withTimezone: true }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  voidedAt:      timestamp('voidedAt', { withTimezone: true }),
  voidedBy:      text('voidedBy').references(() => user.id, { onDelete: 'set null' }),
  voidReason:    text('voidReason'),
  legacyScanId:  integer('legacyScanId'),
})

export type ScanEvent = typeof scanEvents.$inferSelect

export type Provenance = 'scanned' | 'unscanned' | 'carton'
export type MovementType =
  | 'stocktake_scan' | 'stocktake_manual' | 'legacy_import' | 'adjustment' | 'reversal'
  | 'transfer' | 'provenance_transfer' | 'receipt' | 'dispatch' | 'return'

// Append-only. stock_balances is maintained from this table by a database trigger.
export const stockMovements = pgTable('stock_movements', {
  id:             bigserial('id', { mode: 'number' }).primaryKey(),
  skuId:          integer('skuId').notNull().references(() => articleSizes.id, { onDelete: 'restrict' }),
  locationId:     integer('locationId').notNull().references(() => locations.id),
  provenance:     text('provenance').$type<Provenance>().notNull(),
  quantity:       integer('quantity').notNull(),
  movementType:   text('movementType').$type<MovementType>().notNull(),
  sourceType:     text('sourceType').notNull(),
  sourceId:       text('sourceId').notNull(),
  idempotencyKey: text('idempotencyKey').notNull().unique('stock_movements_idempotency_unique'),
  reversalOfId:   bigint('reversalOfId', { mode: 'number' }),
  userId:         text('userId').references(() => user.id, { onDelete: 'set null' }),
  reason:         text('reason'),
  createdAt:      timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

// Read-only from the application: written only by the stock_movements trigger.
export const stockBalances = pgTable('stock_balances', {
  skuId:      integer('skuId').notNull().references(() => articleSizes.id),
  locationId: integer('locationId').notNull().references(() => locations.id),
  provenance: text('provenance').$type<Provenance>().notNull(),
  quantity:   integer('quantity').notNull().default(0),
  updatedAt:  timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.skuId, t.locationId, t.provenance] })])

export const missingArticleReviews = pgTable('missing_article_reviews', {
  articleCode: text('articleCode').notNull(),
  colourCode:  text('colourCode').notNull(),
  status:      text('status').$type<'open' | 'ignored'>().notNull().default('open'),
  note:        text('note').notNull().default(''),
  updatedBy:   text('updatedBy').references(() => user.id, { onDelete: 'set null' }),
  updatedAt:   timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.articleCode, t.colourCode] })])

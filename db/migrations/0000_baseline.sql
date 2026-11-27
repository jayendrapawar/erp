-- detect: select to_regclass('articles') is not null and to_regclass('orders') is not null as present
--
-- Baseline: the schema as it exists in production on 18 Nov 2026 (endpoint ep-royal-tooth),
-- reconstructed from information_schema / pg_constraint / pg_indexes. Before this file the
-- schema was applied by hand; the files in db/legacy-migrations are kept for history only.
-- Existing databases adopt this migration (detect query) instead of running it.

CREATE TYPE order_status AS ENUM ('pending', 'assigned', 'packed', 'billed', 'dispatched', 'delivered', 'cancelled');
CREATE TYPE order_item_status AS ENUM ('pending', 'packed', 'out_of_stock');

-- Better Auth
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text,
  email text NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  role text DEFAULT 'user',
  banned boolean DEFAULT false,
  "banReason" text,
  "banExpires" timestamp,
  CONSTRAINT user_email_unique UNIQUE (email)
);

CREATE TABLE session (
  id text PRIMARY KEY,
  "expiresAt" timestamp NOT NULL,
  token text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL,
  CONSTRAINT session_token_unique UNIQUE (token),
  CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  scope text,
  password text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now(),
  "updatedAt" timestamp DEFAULT now()
);

-- Parties (these are retailers; renamed in 0002)
CREATE TABLE vendors (
  id text PRIMARY KEY,
  "partyName" text NOT NULL,
  gst text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  area text NOT NULL DEFAULT '',
  day text NOT NULL DEFAULT '',
  salesman text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX vendors_party_name_idx ON vendors ("partyName");

CREATE TABLE shopkeepers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  code text,
  phone text,
  address text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX shopkeepers_name_idx ON shopkeepers (name);

-- Article master
CREATE TABLE articles (
  id serial PRIMARY KEY,
  "artName" text NOT NULL DEFAULT '',
  "artCode" text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '',
  "colorCode" text NOT NULL DEFAULT '',
  "maxSize" text NOT NULL DEFAULT '',
  "minSize" text NOT NULL DEFAULT '',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX articles_art_name_idx ON articles ("artName");

CREATE TABLE article_colors (
  id serial PRIMARY KEY,
  "articleId" integer NOT NULL,
  "colorName" text NOT NULL,
  "colorHex" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "article_colors_articleId_articles_id_fk" FOREIGN KEY ("articleId") REFERENCES articles(id) ON DELETE CASCADE
);

CREATE TABLE article_sizes (
  id serial PRIMARY KEY,
  "articleId" integer NOT NULL,
  "sizeLabel" text NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "article_sizes_articleId_articles_id_fk" FOREIGN KEY ("articleId") REFERENCES articles(id) ON DELETE CASCADE
);

-- Legacy scanner table (renamed to legacy_scans in 0002)
CREATE TABLE scans (
  id serial PRIMARY KEY,
  "entryType" text NOT NULL DEFAULT 'scan',
  "rawQrCode" text,
  "boxCodes" jsonb DEFAULT '[]'::jsonb,
  "artNumber" text,
  "colorNumber" text,
  "sizeNumber" text,
  division text,
  mrp numeric,
  "mfgMonth" integer,
  "mfgYear" integer,
  "scannedByName" text,
  notes text,
  quantity integer NOT NULL DEFAULT 1,
  "scannedAt" timestamp NOT NULL DEFAULT now(),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE flags (
  id serial PRIMARY KEY,
  name text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT flags_name_unique UNIQUE (name)
);

-- Orders
CREATE TABLE orders (
  id serial PRIMARY KEY,
  "orderNumber" text NOT NULL,
  "shopkeeperName" text NOT NULL,
  "shopkeeperPhone" text,
  "shopkeeperAddress" text,
  "salesmanId" text,
  "pickerId" text,
  "billerId" text,
  "dispatcherId" text,
  status order_status NOT NULL DEFAULT 'pending',
  notes text,
  "totalBundles" integer,
  "deliveryAgentName" text,
  "isEmergency" boolean NOT NULL DEFAULT false,
  "orderedAt" timestamp NOT NULL DEFAULT now(),
  "packedAt" timestamp,
  "billedAt" timestamp,
  "dispatchedAt" timestamp,
  "deliveredAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "orders_orderNumber_unique" UNIQUE ("orderNumber"),
  CONSTRAINT "orders_salesmanId_user_id_fk" FOREIGN KEY ("salesmanId") REFERENCES "user"(id) ON DELETE SET NULL,
  CONSTRAINT "orders_pickerId_user_id_fk" FOREIGN KEY ("pickerId") REFERENCES "user"(id) ON DELETE SET NULL,
  CONSTRAINT "orders_billerId_user_id_fk" FOREIGN KEY ("billerId") REFERENCES "user"(id) ON DELETE SET NULL,
  CONSTRAINT "orders_dispatcherId_user_id_fk" FOREIGN KEY ("dispatcherId") REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  "orderId" integer NOT NULL,
  "artNumber" text NOT NULL,
  "colorNumber" text,
  "sizeNumber" text,
  "quantityOrdered" integer NOT NULL DEFAULT 1,
  "quantityPacked" integer NOT NULL DEFAULT 0,
  status order_item_status NOT NULL DEFAULT 'pending',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "order_items_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE bill_lines (
  id serial PRIMARY KEY,
  "orderId" integer NOT NULL,
  "artNumber" text NOT NULL,
  mrp numeric(10, 2) NOT NULL,
  qty integer NOT NULL,
  "lineDiscPct" numeric(5, 2) NOT NULL DEFAULT '30',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "bill_lines_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE order_sets (
  id serial PRIMARY KEY,
  name text NOT NULL,
  quantities jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT order_sets_name_unique UNIQUE (name)
);

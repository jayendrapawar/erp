import { defineConfig } from 'drizzle-kit'

// Schema changes are written by hand as numbered SQL files in db/migrations and applied
// with `npm run db:migrate` (scripts/db/migrate.ts), which tracks them in schema_migrations.
// This config is for `drizzle-kit studio` / `introspect` only. Do NOT use `drizzle-kit push`
// or `generate` against shared databases: they bypass the reviewed migration history.
export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './db/drizzle-kit',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})

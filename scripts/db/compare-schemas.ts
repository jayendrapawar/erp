// Read-only schema comparison between two databases (for release planning).
//
//   npx tsx scripts/db/compare-schemas.ts --env-file .env --other-env-file .env.local [--out docs/release/schema-diff.md]
//
// Compares tables, columns (type / nullability / default), indexes, constraints, triggers, views,
// functions and migration-tracking tables. Both connections are opened READ ONLY.

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { arg, log } from './_connect'

function urlFor(envFile: string) {
  const m = fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL\s*=\s*(.*)$/m)
  if (!m) throw new Error(`${envFile} has no DATABASE_URL`)
  const u = new URL(m[1].trim().replace(/^["']|["']$/g, ''))
  u.hostname = u.hostname.replace('-pooler.', '.')
  return { url: u.toString(), endpoint: u.hostname.split('.')[0] }
}

const Q = (S: string) => ({
  columns: `select table_name || '.' || column_name as k, data_type || coalesce('(' || character_maximum_length || ')', '') || case when is_nullable = 'NO' then ' not null' else '' end || coalesce(' default ' || column_default, '') as v
            from information_schema.columns where table_schema = '${S}'`,
  tables: `select table_name as k, table_type as v from information_schema.tables where table_schema = '${S}'`,
  indexes: `select indexname as k, indexdef as v from pg_indexes where schemaname = '${S}'`,
  constraints: `select conrelid::regclass::text || '.' || conname as k, pg_get_constraintdef(oid) as v from pg_constraint where connamespace = '${S}'::regnamespace`,
  triggers: `select event_object_table || '.' || trigger_name || '.' || event_manipulation as k, action_statement as v from information_schema.triggers where trigger_schema = '${S}'`,
  functions: `select p.proname as k, pg_get_function_identity_arguments(p.oid) as v from pg_proc p where p.pronamespace = '${S}'::regnamespace`,
  enums: `select t.typname as k, string_agg(e.enumlabel, ',' order by e.enumsortorder) as v from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typnamespace = '${S}'::regnamespace group by t.typname`,
})

async function snapshot(url: string, S: string) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  if (!/^[a-z_][a-z0-9_]*$/.test(S)) throw new Error('Invalid schema name.')
  await c.query(`SET search_path TO ${S}`)
  // Strip the schema prefix so a rehearsal schema compares equal to public.
  const strip = (x: string) => (x ?? '').split(`${S}.`).join('')
  const out: Record<string, Map<string, string>> = {}
  for (const [name, q] of Object.entries(Q(S))) out[name] = new Map((await c.query(q)).rows.map((r) => [strip(r.k as string), strip(r.v as string)]))
  const counts = new Map<string, string>()
  for (const t of [...out.tables.entries()].filter(([, v]) => v === 'BASE TABLE').map(([k]) => k).sort()) {
    counts.set(t, String((await c.query(`select count(*)::int as n from "${S}"."${t}"`)).rows[0].n))
  }
  out.rowCounts = counts
  const tracking: string[] = []
  if ((await c.query(`select to_regclass('schema_migrations') is not null as ok`)).rows[0].ok) {
    for (const r of (await c.query(`select version, name, method from schema_migrations order by version`)).rows) tracking.push(`schema_migrations ${r.version} ${r.name} (${r.method})`)
  }
  if ((await c.query(`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`)).rows[0].ok) {
    for (const r of (await c.query(`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)).rows) tracking.push(`drizzle ${r.id} ${String(r.hash).slice(0, 12)} ${new Date(Number(r.created_at)).toISOString()}`)
  }
  await c.end()
  return { sets: out, tracking }
}

async function main() {
  const a = urlFor(arg('env-file')!)
  const b = urlFor(arg('other-env-file')!)
  const out = arg('out') || 'docs/release/schema-diff.md'
  const schemaA = arg('schema') || 'public', schemaB = arg('other-schema') || 'public'
  const [sa, sb] = await Promise.all([snapshot(a.url, schemaA), snapshot(b.url, schemaB)])
  const L = [`# Schema comparison`, '', `A = \`${a.endpoint}\` schema ${schemaA} (${arg('env-file')}), B = \`${b.endpoint}\` schema ${schemaB} (${arg('other-env-file')}). Generated ${new Date().toISOString()}, read-only.`, '']
  L.push('## Migration tracking', '', `A: ${sa.tracking.length ? sa.tracking.join('; ') : 'none (no schema_migrations, no drizzle journal)'}`, '', `B: ${sb.tracking.length ? sb.tracking.join('; ') : 'none'}`, '')
  for (const name of [...Object.keys(Q('public')), 'rowCounts']) {
    const A = sa.sets[name], B = sb.sets[name]
    const onlyA = [...A.keys()].filter((k) => !B.has(k)).sort()
    const onlyB = [...B.keys()].filter((k) => !A.has(k)).sort()
    const diff = [...A.keys()].filter((k) => B.has(k) && A.get(k) !== B.get(k)).sort()
    L.push(`## ${name}`, '', `${A.size} in A, ${B.size} in B — only in A: ${onlyA.length}, only in B: ${onlyB.length}, different: ${diff.length}`, '')
    if (name === 'rowCounts') {
      L.push('| Table | A | B |', '|---|---:|---:|')
      for (const k of [...new Set([...A.keys(), ...B.keys()])].sort()) L.push(`| ${k} | ${A.get(k) ?? '—'} | ${B.get(k) ?? '—'} |`)
      L.push('')
      continue
    }
    for (const k of onlyA) L.push(`- only A: \`${k}\``)
    for (const k of onlyB) L.push(`- only B: \`${k}\``)
    for (const k of diff) L.push(`- differs: \`${k}\` — A: \`${A.get(k)}\` / B: \`${B.get(k)}\``)
    L.push('')
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, L.join('\n'))
  log(`Written ${out}`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })

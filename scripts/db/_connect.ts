// Shared connection helper for database scripts.
//
// Every script must be told which env file to use (--env-file .env.local), prints the
// Neon endpoint it is about to touch, and refuses to write unless --confirm repeats
// that endpoint id. This makes it hard to run a write against the wrong database.

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

export interface Target {
  envFile: string
  /** Direct (unpooled) connection: migrations and session settings need a real session. */
  url: string
  endpoint: string // e.g. ep-damp-scene-b3i40jjo
  host: string
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

export function resolveTarget(): Target {
  const envFile = arg('env-file')
  if (!envFile) throw new Error('Pass --env-file <file> (for example --env-file .env.local).')
  const text = fs.readFileSync(envFile, 'utf8')
  const m = text.match(/^DATABASE_URL\s*=\s*(.*)$/m)
  if (!m) throw new Error(`${envFile} has no DATABASE_URL.`)
  const pooled = new URL(m[1].trim().replace(/^["']|["']$/g, ''))
  pooled.hostname = pooled.hostname.replace('-pooler.', '.')
  const url = pooled.toString()
  const host = pooled.hostname
  const endpoint = host.split('.')[0].replace(/-pooler$/, '')
  return { envFile, url, endpoint, host }
}

/** Throws unless --confirm <endpoint> matches the target. */
export function requireWriteConfirmation(t: Target) {
  const c = arg('confirm')
  if (c !== t.endpoint) {
    throw new Error(`Refusing to write to ${t.endpoint}. Re-run with --confirm ${t.endpoint} after checking this is the database you mean.`)
  }
}

export async function connect(t: Target, opts: { schema?: string; readOnly?: boolean } = {}): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: t.url, ssl: { rejectUnauthorized: false } })
  await client.connect()
  if (opts.schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error('Invalid schema name.')
    await client.query(`SET search_path TO ${opts.schema}`)
  }
  if (opts.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  return client
}

export function log(msg: string) {
  process.stdout.write(`${msg}\n`)
}

/** True when backups/<endpoint>/ holds a manifest for this schema taken within the last 2 hours. */
export function recentBackupExists(endpoint: string, schema: string): boolean {
  const root = path.join(process.cwd(), 'backups', endpoint)
  if (!fs.existsSync(root)) return false
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  return fs.readdirSync(root).some((d) => {
    const m = path.join(root, d, 'manifest.json')
    if (!fs.existsSync(m)) return false
    const man = JSON.parse(fs.readFileSync(m, 'utf8'))
    return man.schema === schema && Date.parse(man.takenAt) > cutoff
  })
}

/** pg.Pool options for a target, optionally pinned to a schema (rehearsals and tests). */
export function poolConfig(t: Target, schema?: string, max = 4) {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid schema name.')
  return { connectionString: t.url, ssl: { rejectUnauthorized: false }, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) }
}

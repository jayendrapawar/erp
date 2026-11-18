// Integration-test harness: builds a throw-away schema inside a development database by
// running the real migrations, and returns a Drizzle instance bound to it.
//
// Enabled only when TEST_DB_ENV_FILE points at an env file (for example .env.local).
// Never point it at production: the harness refuses endpoints listed in PROTECTED_ENDPOINTS.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../../lib/db/schema'
import type { Db } from '../../lib/db/types'

const PROTECTED_ENDPOINTS = ['ep-royal-tooth-b3ub6jie'] // production (identified 18 Nov 2026)

export interface Harness { db: Db; pool: pg.Pool; schemaName: string; close(): Promise<void> }

export function harnessEnabled(): boolean {
  return Boolean(process.env.TEST_DB_ENV_FILE)
}

export async function createHarness(): Promise<Harness> {
  const envFile = process.env.TEST_DB_ENV_FILE!
  const parsed = new URL(fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL\s*=\s*(.*)$/m)![1].trim().replace(/^["']|["']$/g, ''))
  parsed.hostname = parsed.hostname.replace('-pooler.', '.') // direct endpoint: supports search_path
  const url = parsed.toString()
  const endpoint = parsed.hostname.split('.')[0]
  if (PROTECTED_ENDPOINTS.includes(endpoint)) throw new Error(`Refusing to run tests against protected endpoint ${endpoint}.`)
  const schemaName = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  execFileSync(tsx, ['scripts/db/migrate.ts', 'up', '--env-file', envFile, '--schema', schemaName, '--confirm', endpoint, '--skip-backup-check'], { stdio: 'pipe', shell: process.platform === 'win32' })
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 6, options: `-c search_path=${schemaName}` })
  const db = drizzle(pool, { schema }) as unknown as Db
  return {
    db, pool, schemaName,
    async close() {
      await pool.query(`DROP SCHEMA ${schemaName} CASCADE`)
      await pool.end()
    },
  }
}

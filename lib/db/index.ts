import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

// Neon free plan (AGENTS.md): the database sleeps after 5 minutes without use and takes ~1–3 s, now
// and then longer, to wake. Settings below are for that (owner reported logouts / slowness,
// 22 Nov 2026):
// - connectionTimeoutMillis 15 s: the old 5 s gave up while the database was still waking, and the
//   page then treated the failure as "not signed in".
// - an 'error' listener: when Neon closes an idle connection (sleep, restart) node-postgres emits
//   'error' on the pool; with no listener that error crashed the server process.
// - keepAlive: TCP keep-alive on open connections.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep a small pool — serverless functions share a process per worker; Neon's pooler handles the rest.
  max: 10,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
  // Required for Neon / most managed Postgres providers
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

pool.on('error', (err) => {
  // An idle connection was closed by the server: the pool drops it and opens a new one when needed.
  console.warn('[db] idle connection closed:', err.message)
})

export const db = drizzle(pool, { schema })

/** Errors that mean "the database was briefly unreachable" (waking up, connection dropped), not a bug. */
export function isTransientDbError(e: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = e
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const msg = String((cur as { message?: unknown }).message ?? '')
    const code = String((cur as { code?: unknown }).code ?? '')
    if (/timeout exceeded when trying to connect|Connection terminated|connection.*(reset|closed|ended)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|terminating connection|Client has encountered a connection error|could not connect/i.test(msg)) return true
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', '57P01', '57P03', '08006', '08001', '08003'].includes(code)) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** Run once more after a short pause when the database was briefly unreachable. For reads only. */
export async function withDbRetry<T>(fn: () => Promise<T>, pauseMs = 400): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!isTransientDbError(e)) throw e
    await new Promise((r) => setTimeout(r, pauseMs))
    return fn()
  }
}

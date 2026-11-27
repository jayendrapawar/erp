// Create / update one test account per role on the DEVELOPMENT database, for local testing with
// the email + password form (lib/dev-login.ts). Refuses the production database.
//
//   npx tsx scripts/dev/seed-test-users.ts --env-file .env.local --confirm <dev endpoint>
//
// Password: DEV_TEST_PASSWORD from the env file (never printed). Accounts: <role>@test.shayona.local,
// ids "test-<role>", each with exactly that role. Re-running resets their roles and password.

import fs from 'node:fs'
import pg from 'pg'
import { hashPassword } from 'better-auth/crypto'
import { arg, log, poolConfig, requireWriteConfirmation, resolveTarget } from '../db/_connect'
import { PRODUCTION_DB_ENDPOINT, TEST_ROLES, testEmail } from '../../lib/dev-login'

async function main() {
  const t = resolveTarget()
  if (t.endpoint === PRODUCTION_DB_ENDPOINT || t.url.includes(PRODUCTION_DB_ENDPOINT)) throw new Error('Refusing: this is the production database.')
  requireWriteConfirmation(t)
  const m = fs.readFileSync(t.envFile, 'utf8').match(/^DEV_TEST_PASSWORD\s*=\s*(.*)$/m)
  const password = (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  if (password.length < 12) throw new Error('Set DEV_TEST_PASSWORD (at least 12 characters) in the env file.')
  const roles = (arg('roles')?.split(',') ?? [...TEST_ROLES]).map((r) => r.trim()).filter((r) => (TEST_ROLES as readonly string[]).includes(r))
  const hash = await hashPassword(password)
  const pool = new pg.Pool(poolConfig(t, undefined, 1))
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    for (const role of roles) {
      const id = `test-${role}`
      const name = `Test ${role[0].toUpperCase()}${role.slice(1)}`
      await c.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, true, $4, now(), now())
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, role = excluded.role, "updatedAt" = now()`,
        [id, name, testEmail(role), role])
      await c.query(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES ($1, $2, 'credential', $2, $3, now(), now())
        ON CONFLICT (id) DO UPDATE SET password = excluded.password, "updatedAt" = now()`,
        [`${id}-credential`, id, hash])
    }
    await c.query('COMMIT')
    log(`${t.endpoint}: ${roles.length} test accounts ready (${roles.map(testEmail).join(', ')}). Password: DEV_TEST_PASSWORD in the env file.`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
    await pool.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })

import { test } from 'node:test'
import assert from 'node:assert/strict'

// lib/db creates a pool but does not connect until a query runs.
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:1/none'

test('waking-up / dropped-connection errors are recognised, also when wrapped', async () => {
  const { isTransientDbError } = await import('../../lib/db')
  assert.ok(isTransientDbError(new Error('timeout exceeded when trying to connect')))
  assert.ok(isTransientDbError(new Error('Connection terminated unexpectedly')))
  assert.ok(isTransientDbError(Object.assign(new Error('x'), { code: 'ECONNRESET' })))
  // Better Auth wraps the database error: "Failed to get session" with the real one as `cause`
  assert.ok(isTransientDbError(Object.assign(new Error('Failed to get session'), { cause: new Error('Connection terminated unexpectedly') })))
  assert.ok(!isTransientDbError(new Error('column "x" does not exist')))
  assert.ok(!isTransientDbError(Object.assign(new Error('duplicate key'), { code: '23505' })))
})

test('a waking-up error is tried once more; other errors are not', async () => {
  const { withDbRetry } = await import('../../lib/db')
  let calls = 0
  assert.equal(await withDbRetry(async () => { calls++; if (calls === 1) throw new Error('Connection terminated unexpectedly'); return 'ok' }, 1), 'ok')
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(withDbRetry(async () => { calls++; throw new Error('syntax error at or near') }, 1), /syntax error/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(withDbRetry(async () => { calls++; throw new Error('timeout exceeded when trying to connect') }, 1), /timeout/)
  assert.equal(calls, 2) // gives up after one retry; the page then shows "Could not load" with Try again
})

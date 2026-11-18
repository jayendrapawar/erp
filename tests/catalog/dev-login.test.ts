import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { devPasswordLoginEnabled } from '../../lib/dev-login'

const DEV_DB = 'postgresql://u:p@ep-damp-scene-b3i40jjo.c-2.aws.neon.tech/neondb'
const PROD_DB = 'postgresql://u:p@ep-royal-tooth-b3ub6jie.c-2.aws.neon.tech/neondb'
const on = { NODE_ENV: 'development', DEV_PASSWORD_LOGIN: '1', DATABASE_URL: DEV_DB }

describe('test sign-in switch (lib/dev-login.ts)', () => {
  test('on only for local next dev with the flag and the development database', () => {
    assert.equal(devPasswordLoginEnabled(on), true)
  })
  test('off in any production build, on Vercel, without the flag, or against production', () => {
    assert.equal(devPasswordLoginEnabled({ ...on, NODE_ENV: 'production' }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, NODE_ENV: 'test' }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, VERCEL: '1' }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, VERCEL_ENV: 'preview' }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, DEV_PASSWORD_LOGIN: undefined }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, DEV_PASSWORD_LOGIN: 'true' }), false)
    assert.equal(devPasswordLoginEnabled({ ...on, DATABASE_URL: PROD_DB }), false)
  })
})

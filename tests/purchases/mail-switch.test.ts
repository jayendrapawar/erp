import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mailboxConfigured, parseStartDay } from '../../lib/purchases/mail'

describe('bill mail switch', () => {
  test('start day: only a yyyy-mm-dd date turns it on, from the start of that day India time', () => {
    for (const v of [undefined, null, '', 'after stocktake', '01-12-2026', 20261201]) assert.equal(parseStartDay(v), null)
    assert.equal(parseStartDay('2026-12-01')?.toISOString(), '2026-11-30T18:30:00.000Z')
  })
  test('mailbox settings must all be present on the server', () => {
    assert.equal(mailboxConfigured({}), false)
    assert.equal(mailboxConfigured({ BILL_MAIL_USER: 'u', BILL_MAIL_PASSWORD: 'p' }), false)
    assert.equal(mailboxConfigured({ BILL_MAIL_USER: 'u', BILL_MAIL_PASSWORD: 'p', BILL_MAIL_FROM: 'f' }), true)
  })
})

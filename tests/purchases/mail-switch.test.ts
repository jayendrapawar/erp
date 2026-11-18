import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mailStartDate } from '../../lib/purchases/mail'

describe('bill mail switch (BILL_MAIL_START)', () => {
  test('off until a start date is set', () => {
    assert.equal(mailStartDate({}), null)
    assert.equal(mailStartDate({ BILL_MAIL_START: '' }), null)
    assert.equal(mailStartDate({ BILL_MAIL_START: 'after stocktake' }), null)
  })
  test('on from the start of that day, India time', () => {
    assert.equal(mailStartDate({ BILL_MAIL_START: '2026-12-01' })?.toISOString(), '2026-11-30T18:30:00.000Z')
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goToTargets, sidebarSections } from '../../lib/nav'
import type { Role } from '../../lib/permissions'

const letters = (roles: Role[]) => Object.fromEntries(goToTargets(sidebarSections(roles), roles).map((t) => [t.letter, t.href]))

test('go-to chords: only pages the roles allow, billing goes to the biller tab', () => {
  assert.deepEqual(letters(['admin']), {
    h: '/home', o: '/orders/admin', i: '/inventory', s: '/scanner', b: '/orders/admin#biller', y: '/payments', p: '/purchases', m: '/master', r: '/reports',
  })
  // A salesman: no billing, purchases, master or reports; Payments to see balances (owner, 22 Nov 2026).
  assert.deepEqual(Object.keys(letters(['salesman'])).sort(), ['h', 'i', 'o', 's', 'y'])
  // Warehouse: no Payments.
  assert.equal(letters(['warehouse']).y, undefined)
  // A biller alone: Orders is the billing screen (no tabs).
  assert.equal(letters(['biller']).b, '/orders')
  // Biller + picker: the Biller tab of the hub.
  assert.equal(letters(['biller', 'picker']).b, '/orders#biller')
  // Warehouse helper: purchases but no orders.
  const w = letters(['warehouse'])
  assert.equal(w.o, undefined); assert.equal(w.p, '/purchases')
  // Accountant without the biller role: no Biller tab, so no g b.
  assert.equal(letters(['accountant']).b, undefined)
  assert.equal(letters(['accountant']).m, '/master')
})

// Email + password sign-in for local testing only (owner, 18 Nov 2026). The real app uses Google.
//
// On only when ALL hold:
//   - `next dev` (NODE_ENV = development) — never in a production build
//   - not on Vercel (no VERCEL / VERCEL_ENV)
//   - DEV_PASSWORD_LOGIN=1 in .env.local
//   - DATABASE_URL is not the production database
// Sign-up stays disabled: only the test accounts made by scripts/dev/seed-test-users.ts exist.

export const PRODUCTION_DB_ENDPOINT = 'ep-royal-tooth-b3ub6jie'

type Env = Record<string, string | undefined>

export function devPasswordLoginEnabled(env: Env = process.env): boolean {
  return env.NODE_ENV === 'development'
    && !env.VERCEL && !env.VERCEL_ENV
    && env.DEV_PASSWORD_LOGIN === '1'
    && !(env.DATABASE_URL ?? '').includes(PRODUCTION_DB_ENDPOINT)
}

export const TEST_ROLES = ['admin', 'supervisor', 'accountant', 'warehouse', 'salesman', 'picker', 'biller', 'dispatcher'] as const
export const testEmail = (role: string) => `${role}@test.shayona.local`

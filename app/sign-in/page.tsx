import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { GoogleSignIn } from '@/components/google-sign-in'
import { DevPasswordSignIn } from '@/components/dev-password-sign-in'
import { TEST_ROLES, devPasswordLoginEnabled } from '@/lib/dev-login'
import { isRedirectError } from 'next/dist/client/components/redirect-error'

export const metadata = {
  title: 'Sign In - Shayona Inventory',
  description: 'Sign in to your inventory management account',
}

export default async function SignInPage() {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (session?.user) redirect('/')
  } catch (err) {
    if (isRedirectError(err)) throw err
  }

  // Test accounts: local `next dev` only (lib/dev-login.ts).
  return <GoogleSignIn>{devPasswordLoginEnabled() ? <DevPasswordSignIn roles={TEST_ROLES} /> : null}</GoogleSignIn>
}

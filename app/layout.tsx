import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import './globals.css'
import { LanguageProvider } from '@/lib/language-context'
import { GlobalNetworkStatus } from '@/components/global-network-status'
import { ServiceWorkerRegistration } from '@/components/service-worker-registration'
import { AppShell } from '@/components/app-nav'
import { THEME_INIT_SCRIPT } from '@/lib/theme'

// Fonts are downloaded at build time and served by the app (no request to Google at run time).
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' })

export const metadata: Metadata = {
  title: 'Shayona Inventory Management',
  description: 'Warehouse inventory scanning and management system for footwear logistics',
  generator: 'v0.app',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Shayona',
  },
  icons: {
    icon: '/icons/icon-192x192.png',
    apple: '/icons/icon-192x192.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available (accessibility); text boxes use 16px on phones so they never zoom.
  viewportFit: 'cover',
  colorScheme: 'dark light',
  // Dark by default; lib/theme.ts updates it when the theme is switched.
  themeColor: '#0A0A0A',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable} bg-background overflow-x-hidden`} suppressHydrationWarning>
      <head>
        {/* Saved light theme applied before the first paint (dark is the default). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased bg-background overflow-x-hidden">
        <LanguageProvider>
          <ServiceWorkerRegistration />
          <GlobalNetworkStatus />
          <AppShell>{children}</AppShell>
        </LanguageProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}

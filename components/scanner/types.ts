import type { getRecentScans } from '@/app/actions/scan'
import type { OfflineEntry } from '@/lib/offline-queue'
import type { SyncResult } from '@/lib/sync-engine'

type LoadedRecentScan = Awaited<ReturnType<typeof getRecentScans>>[number]
export type RecentScan = Omit<LoadedRecentScan, 'masterArtName' | 'masterColorName'> & Partial<Pick<LoadedRecentScan, 'masterArtName' | 'masterColorName'>>

export interface ManualFormState {
  artNumber: string
  colorNumber: string
  sizeNumber: string
  quantity: number | ''
  mrp: string
  notes: string
  division: string
  mfgMonth: string
  mfgYear: string
}

export interface BannerState {
  success: string | null
  warning: string | null
  info: string | null
  error: string | null
}

export interface FlagState {
  flags: string[]
  activeFlag: string
  flagsLoading: boolean
  newFlagInput: string
  showNewFlagInput: boolean
  newFlagSaving: boolean
}

export interface ScannerSessionState {
  dailyScanCount: number
  userName: string
  recentScans: RecentScan[]
  recentLoading: boolean
  lastCameraScan: RecentScan | null
  lastManualEntry: RecentScan | null
  lastOfflineScan: OfflineEntry | null
  lastOfflineManual: OfflineEntry | null
  deleteTarget: RecentScan | null
  deleteLoading: boolean
  deleteConfirmText: string
  offlineQueue: OfflineEntry[]
  isSyncing: boolean
  syncResult: SyncResult | null
}

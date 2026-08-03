import { ElectronAPI } from '@electron-toolkit/preload'
import type { MochiApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    mochi: MochiApi
  }
}

export {}

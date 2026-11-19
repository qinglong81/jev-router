export type JevPick = {
  ts: string
  tier: string
  conf: number
  skills: string[]
  ms: number
  prompt: string
  tokens: number
}
export type JevStats = {
  calls: number
  inTok: number
  outTok: number
  todayCalls: number
  todayTok: number
  recent: JevPick[]
}

declare module 'claude-code' {
  interface PluginState {
    'jev-toggle': { isOn: boolean; stats: JevStats | null; isLogOpen: boolean }
  }
}

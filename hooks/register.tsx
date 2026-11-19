import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { JevPick, JevStats } from '../types'

const ORANGE = '#f28c28'
// docs.typesafe.ai/models: jev-latest is $0.042 per million input tokens; output tokens are free
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000
const ROWS = 8

const isOnAtom = atom({ plugin: 'jev-toggle', key: 'isOn' } as const, false)
const statsAtom = atom({ plugin: 'jev-toggle', key: 'stats' } as const, null)
const isLogOpenAtom = atom({ plugin: 'jev-toggle', key: 'isLogOpen' } as const, false)

// the router script keeps its switch file and log under ~/.claude/jev
async function jevDir($: any): Promise<string> {
  const home: string = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return `${home.replace(/\\/g, '/')}/.claude/jev`
}

async function readFlag($: any): Promise<boolean> {
  try {
    return (await $.fs.read(`${await jevDir($)}/enabled`)).trim() === 'on'
  } catch {
    return false
  }
}

// totals, today's totals and the newest decisions, from the router's own log
async function readStats($: any): Promise<JevStats> {
  const stats: JevStats = { calls: 0, inTok: 0, outTok: 0, todayCalls: 0, todayTok: 0, recent: [] }
  const today = new Date().toDateString()
  try {
    const text: string = await $.fs.read(`${await jevDir($)}/log.jsonl`)
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const r = JSON.parse(line)
        if (!r.tier) continue
        const tokens = r.usage?.input_tokens || 0
        stats.calls += 1
        stats.inTok += tokens
        stats.outTok += r.usage?.output_tokens || 0
        if (new Date(r.ts).toDateString() === today) {
          stats.todayCalls += 1
          stats.todayTok += tokens
        }
        stats.recent.push({
          ts: r.ts,
          tier: r.tier,
          conf: r.tierConf,
          skills: r.picks || [],
          ms: r.ms,
          prompt: r.prompt || '',
          tokens,
        })
      } catch {}
    }
    stats.recent = stats.recent.slice(-ROWS).reverse()
  } catch {}
  return stats
}

function tierColor(tier: string): string {
  return tier === 'haiku' ? '#34d399' : tier === 'sonnet' ? '#60a5fa' : '#f59e0b'
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function usd(n: number): string {
  const v = n * USD_PER_INPUT_TOKEN
  return v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(3)}`
}

function clock(ts: string): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const flag = await readFlag($)
    const stats = await readStats($)
    await update($, isOnAtom, () => flag)
    await update($, statsAtom, () => stats)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const stats = await readStats($)
    await update($, statsAtom, () => stats)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOn = await read($, isOnAtom)
    const stats = await read($, statsAtom)
    const isLogOpen = await read($, isLogOpenAtom)
    const { Box, Text, Button } = $.ui.resolve(e)

    const toggle = async () => {
      const nowOn = !isOn
      await $.fs.write(`${await jevDir($)}/enabled`, nowOn ? 'on' : 'off')
      await update($, isOnAtom, () => nowOn)
      $.ui.toast(nowOn ? 'Jev router is on' : 'Jev router is off')
    }

    const toggleLog = async () => {
      const fresh = await readStats($)
      await update($, statsAtom, () => fresh)
      await update($, isLogOpenAtom, () => !isLogOpen)
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={isOn ? ORANGE : '#3b82f6'} paddingX={1}>
        <Box>
          <Button key="jev-switch" plain onPress={toggle}>
            {isOn ? (
              <Text>
                <Text backgroundColor={ORANGE}>{'       '}</Text>
                <Text backgroundColor="#ffffff">{'    '}</Text>
                <Text bold color={ORANGE}>
                  {'  ON '}
                </Text>
              </Text>
            ) : (
              <Text>
                <Text backgroundColor="#ffffff">{'    '}</Text>
                <Text backgroundColor="#3b82f6">{'       '}</Text>
                <Text bold color="#3b82f6">
                  {'  OFF'}
                </Text>
              </Text>
            )}
          </Button>
          <Text bold dimColor>
            {'   Jev   '}
          </Text>
          {stats ? (
            <Text dimColor>
              {`${tokens(stats.inTok)} tokens used · `}
              <Text bold color={isOn ? ORANGE : undefined}>
                {`${usd(stats.inTok)} charged`}
              </Text>
              {` · today ${usd(stats.todayTok)}   `}
            </Text>
          ) : (
            <Text dimColor>{'no usage yet   '}</Text>
          )}
          <Button key="jev-log" label={isLogOpen ? 'Log ▴' : 'Log ▾'} onPress={toggleLog} />
        </Box>
        {isLogOpen ? (
          <Box flexDirection="column" paddingTop={1}>
            <Text dimColor>
              {`${'TIME'.padEnd(9)}${'MODEL'.padEnd(8)}${'SURE'.padEnd(6)}${'TOKENS'.padEnd(8)}${'COST'.padEnd(10)}${'MS'.padEnd(6)}${'SKILL'.padEnd(18)}PROMPT`}
            </Text>
            {stats && stats.recent.length > 0 ? (
              stats.recent.map((r: JevPick, i: number) => (
                <Text key={`r${i}`}>
                  <Text dimColor>{`${clock(r.ts).padEnd(9)}`}</Text>
                  <Text color={tierColor(r.tier)} bold>
                    {r.tier.padEnd(8)}
                  </Text>
                  <Text dimColor>
                    {`${`${Math.round(r.conf * 100)}%`.padEnd(6)}${tokens(r.tokens).padEnd(8)}${usd(r.tokens).padEnd(10)}${String(r.ms).padEnd(6)}${cut(r.skills[0] || '–', 17)} ${cut(r.prompt, 40)}`}
                  </Text>
                </Text>
              ))
            ) : (
              <Text dimColor>No routed prompts yet. Turn Jev on and send a prompt.</Text>
            )}
            {stats ? (
              <Text dimColor>
                {`Total: ${stats.calls} calls · ${tokens(stats.inTok)} input tokens billed · ${tokens(stats.outTok)} output tokens (free) · rate $0.042 per 1M input tokens`}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}

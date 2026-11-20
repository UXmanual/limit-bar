import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

// 프롬프트 위 한 줄에 5시간 / 7일 한도만 보여준다(사용 %와 초기화까지 남은 시간).
// 다른 값(모델, 컨텍스트, 서브에이전트 등)은 일부러 그리지 않는다.
// 항상 한 줄이다. 넓으면 게이지까지, 좁아지면 게이지를 빼고 글자만, 더 좁으면 끝을 …으로 줄인다.

const limits = atom({ plugin: 'limit-bar', key: 'limits' } as const, [] as Limit[])
// 남은 시간이 줄어드는 것을 그리려고 주기적으로 다시 그리게 하는 값
const tick = atom({ plugin: 'limit-bar', key: 'tick' } as const, 0)
// 오른쪽 토글 버튼으로 고른 언어. null이면 설정(language)이나 기기 언어를 따른다. 세션이 바뀌어도 기억한다.
const langChoice = atom({ plugin: 'limit-bar', key: 'lang' } as const, null as 'en' | 'ko' | null)
const STORE_KEY = 'language'
const TOGGLE_WIDTH = 6

type Lang = 'en' | 'ko'

// 표시 언어. 'auto'면 기기 언어가 한국어일 때만 한국어, 그 외는 영어. 못 읽으면 영어.
function resolveLang(setting: unknown): Lang {
  if (setting === 'ko' || setting === 'en') return setting
  try {
    const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || '')
    return locale.toLowerCase().startsWith('ko') ? 'ko' : 'en'
  } catch {
    return 'en'
  }
}

const WINDOWS: Record<Lang, Record<string, string>> = {
  en: { five_hour: '5h', seven_day: '7d' },
  ko: { five_hour: '5시간', seven_day: '7일' },
}
const ORDER = ['five_hour', 'seven_day']
const BAR_WIDTH = 8
const SEPARATOR = '  │  '
const LEFT_PADDING = 1

function pick(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return rateLimits
    .filter(r => r.kind in WINDOWS.en)
    .map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

// 사용량이 올라갈수록 초록 → 노랑 → 주황 → 빨강으로 조금씩 이어서 변한다(구간 없이 연속).
const STOPS: [number, [number, number, number]][] = [
  [0, [74, 222, 128]],
  [40, [250, 204, 21]],
  [70, [251, 146, 60]],
  [100, [239, 68, 68]],
]

function color(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  for (let i = 1; i < STOPS.length; i++) {
    const hi = STOPS[i]
    const lo = STOPS[i - 1]
    if (!hi || !lo) continue
    const [p1, c1] = hi
    if (p <= p1) {
      const [p0, c0] = lo
      const t = (p - p0) / (p1 - p0)
      const rgb = [0, 1, 2].map(k => Math.round((c0[k] ?? 0) + ((c1[k] ?? 0) - (c0[k] ?? 0)) * t))
      return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('')
    }
  }
  return '#ef4444'
}

// ko: 5일 6시간 남음 / 4시간 13분 남음 / 7분 남음    en: 5d 6h left / 4h 13m left / 7m left
function remaining(resetsAt: string | undefined, now: number, lang: Lang): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return lang === 'ko' ? '곧 초기화' : 'resetting soon'
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (lang === 'ko') {
    if (days >= 1) return `${days}일 ${hours % 24}시간 남음`
    if (hours >= 1) return `${hours}시간 ${minutes % 60}분 남음`
    return `${Math.max(1, minutes)}분 남음`
  }
  if (days >= 1) return `${days}d ${hours % 24}h left`
  if (hours >= 1) return `${hours}h ${minutes % 60}m left`
  return `${Math.max(1, minutes)}m left`
}

// 터미널 칸 수: 한글 같은 전각 글자는 2칸, 나머지는 1칸으로 센다.
function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60)
    n += isWide ? 2 : 1
  }
  return n
}

type Piece = { text: string; kind: 'label' | 'value' | 'dim' | 'sep' | 'track'; percent?: number }

function pieces(rows: Limit[], now: number, withBar: boolean, lang: Lang): Piece[] {
  const out: Piece[] = []
  rows.forEach((r, i) => {
    if (i > 0) out.push({ text: SEPARATOR, kind: 'sep' })
    out.push({ text: WINDOWS[lang][r.kind] ?? r.kind, kind: 'label' })
    if (withBar) {
      // 채워진 칸은 사용량 색, 빈 칸은 같은 모양을 아주 흐린 배경 색으로 따로 그려서 확실히 구분한다.
      const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((r.percentUsed / 100) * BAR_WIDTH)))
      out.push({ text: ' ', kind: 'dim' })
      if (filled > 0) out.push({ text: '█'.repeat(filled), kind: 'value', percent: r.percentUsed })
      if (filled < BAR_WIDTH) out.push({ text: '█'.repeat(BAR_WIDTH - filled), kind: 'track' })
    }
    out.push({ text: ` ${Math.round(r.percentUsed)}%`, kind: 'value', percent: r.percentUsed })
    const left = remaining(r.resetsAt, now, lang)
    if (left) out.push({ text: ` · ${left}`, kind: 'dim' })
  })
  return out
}

export const register: Register = (on, options) => {
  const defaultLang = resolveLang(options?.language)

  on('session.start', async ($, e, next) => {
    // 지난번에 토글로 골라 둔 언어가 있으면 이어서 쓴다.
    const saved = await $.store.get(STORE_KEY)
    if (saved === 'en' || saved === 'ko') await update($, langChoice, () => saved)
    // 첫 응답 전에도 이미 읽힌 값이 있으면 바로 채운다.
    const usage = await $.session.usage()
    await update($, limits, () => pick(usage.rateLimits))
    // 1분마다 다시 그려서 남은 시간을 갱신한다.
    $.clock.every(60000, () => {
      void update($, tick, n => n + 1)
    })
    return next(e)
  })

  // 한도 창의 % 가 1포인트 이상 움직이거나 턴이 끝날 때마다 엔진이 밀어 준다.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => pick(e.rateLimits))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, limits)
    void (await read($, tick))
    // 구독이 아니거나 아직 읽힌 값이 없으면 줄 자체를 그리지 않는다.
    if (rows.length === 0 || e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const chosen = await read($, langChoice)
    const lang: Lang = chosen ?? defaultLang

    // 줄이 들어갈 칸 수에 맞춰, 게이지가 있는 모양이 들어가면 그걸, 아니면 글자만 보여준다.
    // 오른쪽 끝에 언어 토글 버튼 자리를 남긴다.
    const room = Math.max(10, (e.props.bodyColumns ?? 80) - LEFT_PADDING - TOGGLE_WIDTH)
    const full = pieces(rows, now, true, lang)
    const fits = full.reduce((n, p) => n + cells(p.text), 0) <= room
    const shown = fits ? full : pieces(rows, now, false, lang)

    // 테두리 없이 왼쪽 여백만 준다. 한 줄 고정이라 더 좁아지면 끝이 …으로 줄어든다.
    const toggle = () => {
      const other: Lang = lang === 'ko' ? 'en' : 'ko'
      void update($, langChoice, () => other)
      void $.store.set(STORE_KEY, other)
    }

    return (
      <Box paddingLeft={LEFT_PADDING} flexGrow={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" maxLines={1}>
            {shown.map((p, i) => {
              const key = String(i)
              // 5시간 / 7일 사이 구분선은 튀지 않게 테마의 가장 옅은 회색(subtle)에 한 번 더 흐리게 한다.
              if (p.kind === 'sep') return <Text key={key} color="subtle" dimColor>{p.text}</Text>
              // 게이지의 빈 칸: 배경처럼 보이도록 가장 옅은 회색에 한 번 더 흐리게
              if (p.kind === 'track') return <Text key={key} color="subtle" dimColor>{p.text}</Text>
              if (p.kind === 'label') return <Text key={key} bold>{p.text}</Text>
              if (p.kind === 'value') return <Text key={key} color={color(p.percent ?? 0)}>{p.text}</Text>
              return <Text key={key} dimColor>{p.text}</Text>
            })}
          </Text>
        </Box>
        {/* 토글 버튼 하나: 지금 언어(KO / EN)를 보여 주고, 누르면 다른 쪽으로 바뀌며 기억한다. */}
        <Button key="lang-toggle" plain dimColor onPress={toggle}>{lang === 'ko' ? 'KO' : 'EN'}</Button>
      </Box>
    )
  })
}

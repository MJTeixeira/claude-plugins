// Adapted from savvy-progress by johnnyvizz; see ../NOTICE.md.
import type { QueueDisplay, SeatQuotaDisplay, SeatQuotaWindow, SeatVendor } from '../types/index'

export type Card = {
  id: string
  vendor: SeatVendor
  description: string
  model: string
  effort: string
  status: 'running' | 'done'
  startedAt?: number
  endedAt?: number
  tokens?: number
  steps: number
  lastAction?: string
}

export type Totals = { seats: number, tokens: number, time: number }
type Quotas = Partial<Record<SeatVendor, SeatQuotaDisplay>>

export const VENDORS = ['claude', 'codex', 'agy'] as const
export const PALETTE: Record<SeatVendor, string> = { claude: '#D97757', codex: '#168A88', agy: '#4285D4' }
export const ACCENT = '#8F8CF4'
export const GREEN = '#3B9C5F'
export const STEP = '#E07A52'
export const AMBER = '#D97706'
export const RED = '#D0453F'
export const UNKNOWN = '#9A9A96'
export const INK = '#1F1E1D'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export const CARD_H = 92
export const HEADER_H = 84
export const SECTION_H = 30
export const ROW_H = 24
export const QUOTA_H = 18
// A Text or Button row on the desktop is about 20px; the grid errs taller.
export const LINE_H = 24

const xml = (value: string): string =>
  value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)

// Rough advance of system UI text, in em; good enough to size a slot.
const charEm = (char: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(char) ? 0.3 : /[A-Zmw@%]/.test(char) ? 0.72 : 0.56

const textWidth = (value: string, size: number): number => [...value].reduce((width, char) => width + charEm(char) * size, 0)

// Cuts a string to `max` pixels, with an ellipsis when it had to cut.
export const fitText = (value: string, size: number, max: number): string => {
  if (textWidth(value, size) <= max) return value
  let out = ''
  for (const char of value) {
    if (textWidth(out + char + '…', size) > max) break
    out += char
  }
  return out + '…'
}

export const fmtTokens = (value: number | undefined): string =>
  value === undefined ? '—' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? Math.round(value / 1e3) + 'k' : String(Math.round(value))

export const fmtTime = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + rest : minutes + ':' + rest
}

export const elapsed = (card: Card, now: number): number =>
  card.startedAt === undefined ? 0 : (card.endedAt ?? Math.max(now, card.startedAt)) - card.startedAt

export const totals = (cards: Card[], now: number): Totals => {
  const started = cards.map(card => card.startedAt ?? now)
  const ended = cards.map(card => card.endedAt ?? Math.max(now, card.startedAt ?? now))
  return {
    seats: cards.length,
    tokens: cards.reduce((sum, card) => sum + (card.tokens ?? 0), 0),
    time: cards.length ? Math.max(...ended) - Math.min(...started) : 0,
  }
}

export const plural = (count: number, word: string): string => count + ' ' + word + (count === 1 ? '' : 's')

// Seats report no planned total: the bar creeps toward full as steps add up, and fills when done.
export const progress = (card: Card): number => card.status === 'done' ? 1 : card.steps / (card.steps + 6)

export const stepLine = (card: Card): string =>
  card.status === 'done' ? 'Done · ' + plural(card.steps, 'step') : 'Step ' + card.steps + (card.lastAction ? ' · ' + card.lastAction : '')

// Fills and strokes that read on a light and a dark surface: ink flips with the scheme, tints are low-alpha.
const THEME = '<style>'
  + '.t{fill:#1f1e1d}.s{fill:#6b6a66}.k{fill:#8a8984;fill-opacity:.22}.tk{fill:#8a8984;fill-opacity:.6}'
  + '.tile{fill:#8a8984;fill-opacity:.07;stroke:#8a8984;stroke-opacity:.3}'
  + '@media (prefers-color-scheme:dark){.t{fill:#ecebe8}.s{fill:#a3a29e}}'
  + '.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}'
  + '@media (prefers-reduced-motion:reduce){.live{animation:none}}'
  + '</style>'

// Periods divide one second, so a running card's once-a-second redraw restarts them in phase.
const CRAB_CSS = '<style>'
  + '.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}'
  + '.run .bd{animation:bob .5s steps(1) infinite -.125s}.run g{transform-box:fill-box}'
  + '@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}'
  + '@media (prefers-reduced-motion:reduce){.run,.run g{animation:none!important}}'
  + '</style>'

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${THEME}${body}</svg>`

const text = (x: number, y: number, size: number, value: string, attrs = ''): string =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ${attrs}>${xml(value)}</text>`

// Pixel Clawd: a 24×16 crab on a 30×28 grid; `la`/`lb` are the leg pairs, `bd` the rest.
type Fill = (x: number, y: number, width: number, height: number, color: string, group?: string) => void

const crabBody = (fill: Fill, color: string): void => {
  fill(7, 10, 16, 12, color)
  fill(3, 14, 4, 4, color)
  fill(23, 14, 4, 4, color)
  fill(9, 12, 2, 2, INK)
  fill(19, 12, 2, 2, INK)
  fill(7, 22, 2, 4, color, 'la')
  fill(17, 22, 2, 4, color, 'la')
  fill(11, 22, 2, 4, color, 'lb')
  fill(21, 22, 2, 4, color, 'lb')
}

// Draws the crab's body (grid x 3..27, y 10..26) with its top-left corner at x, y.
export const crab = (x: number, y: number, color: string, scale: number, dim: boolean, walking: boolean): string => {
  const groups: Record<string, string[]> = { bd: [], la: [], lb: [] }
  crabBody((cx, cy, width, height, tone, group = 'bd') => {
    groups[group]?.push(`<rect x="${cx}" y="${cy}" width="${width}" height="${height}" fill="${tone}"/>`)
  }, color)
  const group = (name: string) => `<g class="${name}">${groups[name]?.join('') ?? ''}</g>`
  return `<g transform="translate(${x - 3 * scale},${y - 10 * scale}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges">`
    + `<g class="${walking ? 'run' : ''}">${group('bd')}${group('la')}${group('lb')}</g></g>`
}

// codex and agy as pixel logos on the crab's grid, read from bitmaps: `#` is the vendor colour,
// other characters name an animation group. The whole logo bobs on the crab's beat.
const LOGO_CSS = '<style>'
  + '.logo.run{animation:lb .5s steps(1) infinite -.125s}@keyframes lb{50%{transform:translateY(1px)}}'
  + '.run .tp{animation:bl .5s steps(1) infinite}.run .cu{animation:bl 1s steps(1) infinite -.25s}@keyframes bl{50%{opacity:0}}'
  + '.run .ch{animation:ny .5s steps(1) infinite}@keyframes ny{50%{transform:translateX(1px)}}'
  + '@media (prefers-reduced-motion:reduce){.run,.run g{animation:none!important}}'
  + '</style>'

type Logo = { rows: string[], left: number, inks: string }

// Gemini's four-point sparkle; `t` marks the tips, which twinkle.
const SPARKLE: Logo = { left: 7, inks: '', rows: [
  '.......tt.......',
  '.......tt.......',
  '.......##.......',
  '......####......',
  '......####......',
  '.....######.....',
  '...##########...',
  'tt############tt',
  'tt############tt',
  '...##########...',
  '.....######.....',
  '......####......',
  '......####......',
  '.......##.......',
  '.......tt.......',
  '.......tt.......',
] }

// Codex's cloud with a `>_` prompt in ink: `c` the chevron, which nudges, `u` the cursor, which blinks.
const CLOUD: Logo = { left: 5, inks: 'cu', rows: [
  '......#####.........',
  '....#########.####..',
  '...################.',
  '..##################',
  '.###################',
  '####################',
  '#####cc#############',
  '######cc############',
  '#######cc###########',
  '######cc############',
  '#####cc####uuuuu####',
  '####################',
  '####################',
  '.##################.',
  '..################..',
  '....############....',
] }

const GROUP: Record<string, string> = { '#': 'bd', t: 'tp', c: 'ch', u: 'cu' }

const logo = (shape: Logo, x: number, y: number, color: string, scale: number, dim: boolean, moving: boolean): string => {
  const groups: Record<string, string[]> = {}
  shape.rows.forEach((row, cy) => [...row].forEach((char, cx) => {
    const group = GROUP[char]
    if (!group) return
    const tone = shape.inks.includes(char) ? INK : color
    ;(groups[group] ??= []).push(`<rect x="${shape.left + cx}" y="${10 + cy}" width="1" height="1" fill="${tone}"/>`)
  }))
  const body = Object.entries(groups).map(([name, rects]) => `<g class="${name}">${rects.join('')}</g>`).join('')
  return `<g transform="translate(${x - 3 * scale},${y - 10 * scale}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges">`
    + `<g class="logo${moving ? ' run' : ''}">${body}</g></g>`
}

// Each vendor's figure as 16 rows of 24 pixels, the crab's grid x 3..26, y 10..25:
// `#` the vendor colour, `i` ink, `.` nothing. The terminal draws it from these.
export const figureRows = (vendor: SeatVendor): string[] => {
  const rows = Array.from({ length: 16 }, () => Array.from({ length: 24 }, () => '.'))
  const put = (x: number, y: number, mark: string) => {
    const row = rows[y - 10]
    if (row && x >= 3 && x < 27) row[x - 3] = mark
  }
  if (vendor === 'claude') {
    crabBody((x, y, width, height, tone) => {
      for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) put(x + dx, y + dy, tone === INK ? 'i' : '#')
    }, PALETTE.claude)
  } else {
    const shape = vendor === 'codex' ? CLOUD : SPARKLE
    shape.rows.forEach((row, cy) => [...row].forEach((char, cx) => {
      if (GROUP[char]) put(shape.left + cx, 10 + cy, shape.inks.includes(char) ? 'i' : '#')
    }))
  }
  return rows.map(row => row.join(''))
}

// Each vendor's figure, drawn with the crab's grid origin at x, y.
export const sprite = (vendor: SeatVendor, x: number, y: number, scale: number, dim: boolean, moving: boolean): string =>
  vendor === 'claude' ? CRAB_CSS + crab(x, y, PALETTE.claude, scale, dim, moving)
    : LOGO_CSS + logo(vendor === 'codex' ? CLOUD : SPARKLE, x, y, PALETTE[vendor], scale, dim, moving)

const statusMark = (x: number, y: number, status: Card['status']): string =>
  status === 'running'
    ? `<circle class="live" cx="${x}" cy="${y}" r="4" fill="${GREEN}"/>`
    : `<path d="M${x - 6} ${y}l4 4 7.5-8" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

// ◑: a ring with its left half filled.
const halfMoon = (x: number, y: number, color: string): string =>
  `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${color}" stroke-width="1.4"/><path d="M${x} ${y - 5}a5 5 0 0 0 0 10z" fill="${color}"/>`

export const cardSvg = (width: number, card: Card, now: number): string => {
  const color = PALETTE[card.vendor]
  const isDone = card.status === 'done'
  const left = 82
  const right = width - 16
  const stats = fmtTokens(card.tokens) + ' tokens · ' + fmtTime(elapsed(card, now))
  const meta = [card.vendor, card.model, card.effort].filter(Boolean).join(' · ')
  const metaWidth = right - left - textWidth(stats, 12) - 12
  const step = stepLine(card)
  const barWidth = right - left
  const fill = Math.round(barWidth * progress(card))
  return svg(width, CARD_H, ''
    + `<rect x="0.75" y="0.75" width="${width - 1.5}" height="${CARD_H - 9.5}" rx="10" fill="${color}" fill-opacity="${isDone ? 0.03 : 0.06}" stroke="${color}" stroke-opacity="${isDone ? 0.35 : 0.65}" stroke-width="1.5"/>`
    + sprite(card.vendor, 20, 26, 2, isDone, !isDone)
    + text(left, 25, 14, fitText(card.description, 14, right - left - 20), 'class="t" font-weight="600"')
    + text(left, 44, 12, fitText(meta, 12, Math.max(40, metaWidth)), 'class="s"')
    + text(right, 44, 12, stats, 'class="s" text-anchor="end" font-variant-numeric="tabular-nums"')
    + (isDone ? '' : halfMoon(left + 5, 59.5, STEP))
    + text(isDone ? left : left + 16, 64, 12.5, fitText(step, 12.5, right - left - 16), `fill="${isDone ? GREEN : STEP}" font-weight="500"`)
    + `<rect class="k" x="${left}" y="72" width="${barWidth}" height="3" rx="1.5"/>`
    + `<rect x="${left}" y="72" width="${fill}" height="3" rx="1.5" fill="${color}"${isDone ? ' fill-opacity=".6"' : ''}/>`
    + statusMark(right - 2, 21, card.status))
}

export const headerSvg = (width: number, values: Totals): string => {
  const gap = 8
  const cell = (width - gap * 2) / 3
  const tile = (index: number, label: string, value: string) => {
    const x = index * (cell + gap)
    return `<rect class="tile" x="${x + 0.5}" y="28.5" width="${cell - 1}" height="49" rx="8"/>`
      + text(x + 12, 47, 12, label, 'class="s"')
      + text(x + 12, 67, 15, value, `fill="${PALETTE.claude}" font-weight="600" font-variant-numeric="tabular-nums"`)
  }
  return svg(width, HEADER_H, text(0, 17, 15, plural(values.seats, 'seat') + ' in this session', `fill="${PALETTE.claude}" font-weight="600"`)
    + tile(0, 'Seats', String(values.seats))
    + tile(1, 'Tokens', fmtTokens(values.tokens))
    + tile(2, 'Time', fmtTime(values.time)))
}

export const runningSvg = (width: number, count: number): string =>
  svg(width, SECTION_H, `<rect y="1" width="${width}" height="22" rx="4" fill="${GREEN}"/>`
    + '<path d="M10 9.5h9l-4.5 5.5z" fill="#fff"/>'
    + text(25, 17, 13, 'Running · ' + count, 'fill="#fff" font-weight="600"'))

// The queue as one row: label, a bar with a `Tasks d/t` pill at the head of what is done, the percent.
export const rowSvg = (queue: QueueDisplay | null, running: number, width: number): string => {
  const dot = `<circle cx="5" cy="${ROW_H / 2}" r="4" fill="${ACCENT}"/>`
  if (!queue) return svg(width, ROW_H, dot + text(16, 16.5, 13, plural(running, 'seat') + ' running', 'class="t" font-weight="500"'))
  const total = queue.done + queue.running + queue.pending
  const title = fitText(queue.label ?? 'Autopilot queue', 13, Math.max(60, width * 0.4))
  const barX = Math.round(16 + textWidth(title, 13) + 12)
  const barWidth = Math.max(60, width - barX - 48)
  const barHeight = 16
  const fill = Math.round(barWidth * queue.done / total)
  const runFill = Math.round(barWidth * (queue.done + queue.running) / total)
  const pill = 'Tasks ' + queue.done + '/' + total
  const pillWidth = Math.round(18 + pill.length * 6.4)
  const pillX = Math.max(0, Math.min(barWidth - pillWidth, fill - pillWidth))
  const ticks = Array.from({ length: total - 1 }, (_, index) => Math.round(barWidth * (index + 1) / total))
    .filter(x => x > runFill + 4)
    .map(x => `<rect class="tk" x="${x}" y="${barHeight / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  return svg(width, ROW_H, dot
    + text(16, 16.5, 13, title, 'class="t" font-weight="500"')
    + `<g transform="translate(${barX},${(ROW_H - barHeight) / 2})">`
    + `<rect class="k" width="${barWidth}" height="${barHeight}" rx="${barHeight / 2}"/>`
    + `<rect width="${runFill}" height="${barHeight}" rx="${barHeight / 2}" fill="${ACCENT}" fill-opacity=".35"/>`
    + ticks.join('')
    + `<rect x="${pillX}" width="${Math.max(pillWidth, fill - pillX)}" height="${barHeight}" rx="${barHeight / 2}" fill="${ACCENT}"/>`
    + text(pillX + pillWidth / 2, 12, 11, pill, 'text-anchor="middle" font-weight="600" fill="#fff"')
    + '</g>'
    + text(width - 4, 16.5, 12.5, Math.round(queue.done / total * 100) + '%', 'class="s" text-anchor="end" font-variant-numeric="tabular-nums"'))
}

export const windowUsed = (quota: SeatQuotaDisplay | undefined, window: SeatQuotaWindow | undefined): number | undefined =>
  quota?.known && window ? window.used : undefined

// A window inline: its label, a thin bar and the percent just after it, left-aligned.
const meter = (x: number, width: number, label: string, used: number | undefined, out: boolean, color: string): string => {
  const trackX = x + 19
  const trackWidth = Math.max(16, width - 19 - 32)
  const valueX = trackX + trackWidth + 5
  const name = text(x, 13, 9.5, label, 'class="s" font-weight="600"')
  if (used === undefined) {
    return name
      + `<path d="M${trackX} 9h${trackWidth}" stroke="${UNKNOWN}" stroke-width="2" stroke-dasharray="3 3"/>`
      + text(valueX, 13, 11, '?', `fill="${UNKNOWN}"`)
  }
  const tone = out || used >= 95 ? RED : used >= 80 ? AMBER : color
  return name
    + `<rect class="k" x="${trackX}" y="7.5" width="${trackWidth}" height="3" rx="1.5"/>`
    + `<rect x="${trackX}" y="7.5" width="${Math.round(trackWidth * Math.min(100, used) / 100)}" height="3" rx="1.5" fill="${tone}"/>`
    + text(valueX, 13, 11, Math.round(used) + '%', `${tone === color ? 'class="s"' : `fill="${tone}"`} font-variant-numeric="tabular-nums"`)
}

const QUOTA_NAME_W = 46
const QUOTA_METER_W = 92
const QUOTA_GAP = 22
const QUOTA_BLOCK_W = QUOTA_NAME_W + QUOTA_METER_W * 2

// The quota line's width: one fixed block per shown vendor, never stretched to the band.
export const quotaWidth = (shown: readonly SeatVendor[] = VENDORS): number =>
  shown.length * QUOTA_BLOCK_W + (shown.length - 1) * QUOTA_GAP

// One line, a block per shown vendor: its name, then its 5-hour and weekly windows.
export const quotaSvg = (quotas: Quotas, shown: readonly SeatVendor[] = VENDORS): string =>
  svg(quotaWidth(shown), QUOTA_H, shown.map((vendor, index) => {
    const x = index * (QUOTA_BLOCK_W + QUOTA_GAP)
    const quota = quotas[vendor]
    const out = quota?.out === true
    return text(x, 13, 11, vendor, `fill="${PALETTE[vendor]}" font-weight="700"`)
      + meter(x + QUOTA_NAME_W, QUOTA_METER_W, '5H', windowUsed(quota, quota?.fiveHour), out, PALETTE[vendor])
      + meter(x + QUOTA_NAME_W + QUOTA_METER_W, QUOTA_METER_W, 'WK', windowUsed(quota, quota?.weekly), out, PALETTE[vendor])
  }).join(''))

export const quotaAlt = (quotas: Quotas, shown: readonly SeatVendor[] = VENDORS): string => shown.map(vendor => {
  const quota = quotas[vendor]
  const percent = (window: SeatQuotaWindow | undefined) => {
    const used = windowUsed(quota, window)
    return used === undefined ? '?' : Math.round(used) + '%'
  }
  return vendor + ' 5h ' + percent(quota?.fiveHour) + ', weekly ' + percent(quota?.weekly)
}).join('; ')

// The pane's backdrop: a dotted grid as tall as the content laid over it. The engine refuses an
// Svg taller than 4096px, so a long grid is stacked from tiles; 4096 keeps the 16px dots aligned.
export const gridTiles = (height: number): number[] =>
  Array.from({ length: Math.ceil(height / 4096) }, (_, index) => Math.min(4096, height - index * 4096))

export const gridSvg = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + '<style>.d{fill:#d9d8d4}@media (prefers-color-scheme:dark){.d{fill:#3a3a38}}</style>'
  + '<defs><pattern id="g" width="16" height="16" patternUnits="userSpaceOnUse"><circle class="d" cx="8" cy="8" r="1"/></pattern></defs>'
  + `<rect width="${width}" height="${height}" fill="url(#g)"/></svg>`

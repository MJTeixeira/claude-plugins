// Adapted from savvy-progress by johnnyvizz; see ../NOTICE.md.
// A grid of terminal cells drawn into a `Raster`: text, coloured backgrounds and
// half-block pixels (two per cell, one above the other), encoded as the element wants;
// then the desktop's art (art.ts) drawn in it for the terminal.
import type { QueueDisplay, SeatQuotaDisplay, SeatVendor } from '../types/index'
import {
  ACCENT, AMBER, GREEN, INK, PALETTE, RED, STEP, UNKNOWN,
  elapsed, figureRows, fmtTime, fmtTokens, plural, progress, stepLine, windowUsed,
} from './art'
import type { Card, Totals } from './art'

// The terminal's own colour: the foreground or background of the person's theme.
export const DEFAULT = 0x01000000

export type Canvas = {
  columns: number
  rows: number
  chars: number[]
  fg: number[]
  bg: number[]
  // Half-block pixels, two per cell: index (y * columns + x), y counting pixel rows.
  pixels: (number | undefined)[]
}

export const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)

// `amount` of `color` over `base`, both 0xRRGGBB.
export const mix = (color: number, base: number, amount: number): number => {
  const channel = (shift: number) => {
    const from = (base >> shift) & 0xff
    const to = (color >> shift) & 0xff
    return Math.round(from + (to - from) * amount) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

export const canvas = (columns: number, rows: number): Canvas => ({
  columns, rows,
  chars: Array.from({ length: columns * rows }, () => 0x20),
  fg: Array.from({ length: columns * rows }, () => DEFAULT),
  bg: Array.from({ length: columns * rows }, () => DEFAULT),
  pixels: Array.from({ length: columns * rows * 2 }, () => undefined),
})

// The engine takes only printable width-1 BMP characters: anything else reads as `?`.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6]]
const printable = (code: number): number =>
  code < 0x20 || (code >= 0x7f && code < 0xa0) ? 0x20
    : code > 0xffff || (code >= 0xd800 && code <= 0xdfff) || WIDE.some(([low = 0, high = 0]) => code >= low && code <= high) ? 0x3f
      : code

const isMark = (code: number): boolean => (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)

const glyphs = (value: string): number[] =>
  [...value].map(char => char.codePointAt(0) ?? 0x20).filter(code => !isMark(code)).map(printable)

export const put = (c: Canvas, x: number, y: number, char: string, fg = DEFAULT, bg?: number): void => {
  if (x < 0 || y < 0 || x >= c.columns || y >= c.rows) return
  const index = y * c.columns + x
  c.chars[index] = glyphs(char)[0] ?? 0x20
  c.fg[index] = fg
  if (bg !== undefined) c.bg[index] = bg
}

// Writes `value` from x, cut with an ellipsis to `max` cells; returns the cells written.
export const write = (c: Canvas, x: number, y: number, value: string, fg = DEFAULT, max = c.columns - x, bg?: number): number => {
  let codes = glyphs(value)
  if (max <= 0) return 0
  if (codes.length > max) codes = [...codes.slice(0, Math.max(0, max - 1)), 0x2026]
  codes.forEach((code, offset) => {
    const cx = x + offset
    if (cx < 0 || cx >= c.columns || y < 0 || y >= c.rows) return
    const index = y * c.columns + cx
    c.chars[index] = code
    c.fg[index] = fg
    if (bg !== undefined) c.bg[index] = bg
  })
  return codes.length
}

// Writes `value` so it ends at column `right` (exclusive); returns where it starts.
export const writeEnd = (c: Canvas, right: number, y: number, value: string, fg = DEFAULT): number => {
  const start = right - glyphs(value).length
  write(c, start, y, value, fg)
  return start
}

export const fill = (c: Canvas, x: number, y: number, width: number, height: number, bg: number): void => {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      const cx = x + dx
      const cy = y + dy
      if (cx >= 0 && cy >= 0 && cx < c.columns && cy < c.rows) c.bg[cy * c.columns + cx] = bg
    }
  }
}

// One half-block pixel at pixel column x, pixel row y (two per cell row).
export const pixel = (c: Canvas, x: number, y: number, color: number): void => {
  if (x < 0 || y < 0 || x >= c.columns || y >= c.rows * 2) return
  c.pixels[y * c.columns + x] = color
}

// A rounded box-drawing frame.
export const frame = (c: Canvas, x: number, y: number, width: number, height: number, color: number): void => {
  const right = x + width - 1
  const bottom = y + height - 1
  for (let cx = x + 1; cx < right; cx += 1) {
    put(c, cx, y, '─', color)
    put(c, cx, bottom, '─', color)
  }
  for (let cy = y + 1; cy < bottom; cy += 1) {
    put(c, x, cy, '│', color)
    put(c, right, cy, '│', color)
  }
  put(c, x, y, '╭', color)
  put(c, right, y, '╮', color)
  put(c, x, bottom, '╰', color)
  put(c, right, bottom, '╯', color)
}

// A thin bar of `width` cells, `ratio` of it in `color` on a `track`; half cells at the head.
export const thinBar = (c: Canvas, x: number, y: number, width: number, ratio: number, color: number, track: number): void => {
  const halves = Math.round(width * 2 * Math.max(0, Math.min(1, ratio)))
  for (let offset = 0; offset < width; offset += 1) {
    const lit = halves - offset * 2
    if (lit >= 2) put(c, x + offset, y, '━', color)
    else if (lit === 1) put(c, x + offset, y, '╸', color)
    else put(c, x + offset, y, '━', track)
  }
}

// A dashed bar for a value no one knows.
export const dashedBar = (c: Canvas, x: number, y: number, width: number, color: number): void => {
  for (let offset = 0; offset < width; offset += 1) put(c, x + offset, y, '╌', color)
}

const resolvePixels = (c: Canvas): void => {
  for (let y = 0; y < c.rows; y += 1) {
    for (let x = 0; x < c.columns; x += 1) {
      const top = c.pixels[y * 2 * c.columns + x]
      const bottom = c.pixels[(y * 2 + 1) * c.columns + x]
      if (top === undefined && bottom === undefined) continue
      const index = y * c.columns + x
      if (top !== undefined) {
        c.chars[index] = 0x2580
        c.fg[index] = top
        c.bg[index] = bottom ?? DEFAULT
      } else if (bottom !== undefined) {
        c.chars[index] = 0x2584
        c.fg[index] = bottom
        c.bg[index] = DEFAULT
      }
    }
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const d = bytes[index + 2] ?? 0
    const word = (a << 16) | (b << 8) | d
    out += BASE64[(word >> 18) & 63]! + BASE64[(word >> 12) & 63]!
      + (index + 1 < bytes.length ? BASE64[(word >> 6) & 63]! : '=')
      + (index + 2 < bytes.length ? BASE64[word & 63]! : '=')
  }
  return out
}

// The `cells` prop: little-endian u32 triplets [codePoint, foreground, background], row-major.
export const encode = (c: Canvas): string => {
  resolvePixels(c)
  const words = new Uint32Array(c.columns * c.rows * 3)
  for (let index = 0; index < c.columns * c.rows; index += 1) {
    words[index * 3] = c.chars[index] ?? 0x20
    words[index * 3 + 1] = c.fg[index] ?? DEFAULT
    words[index * 3 + 2] = c.bg[index] ?? DEFAULT
  }
  const bytes = new Uint8Array(words.buffer)
  // The typed array is little-endian on every host the engine runs on; the element wants that order.
  return toBase64(bytes)
}

export type Cell = { char: string, fg: number, bg: number }

// Reads `cells` back: what a test asserts on.
export const decode = (cells: string, columns: number): Cell[][] => {
  const lookup = new Map([...BASE64].map((char, index) => [char, index]))
  const clean = cells.replace(/=+$/, '')
  const bytes: number[] = []
  for (let index = 0; index < clean.length; index += 4) {
    const word = [0, 1, 2, 3].reduce((acc, offset) => (acc << 6) | (lookup.get(clean[index + offset] ?? 'A') ?? 0), 0)
    bytes.push((word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff)
  }
  const count = Math.floor(bytes.length / 12)
  const all: Cell[] = []
  const u32 = (at: number) => ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
  for (let index = 0; index < count; index += 1) {
    all.push({ char: String.fromCodePoint(u32(index * 12)), fg: u32(index * 12 + 4), bg: u32(index * 12 + 8) })
  }
  return Array.from({ length: Math.floor(all.length / columns) }, (_, row) => all.slice(row * columns, (row + 1) * columns))
}

export const rowText = (row: Cell[]): string => row.map(cell => cell.char).join('')

// ---- The desktop's art, in cells ----

export type Drawing = { cells: string, columns: number, rows: number }

const finish = (c: Canvas): Drawing => ({ cells: encode(c), columns: c.columns, rows: c.rows })

// Reads on a light and a dark theme alike.
const SECONDARY = rgb('#8a8984')
const WHITE = 0xffffff
const dim = (color: number): number => mix(color, SECONDARY, 0.45)

type Quotas = Partial<Record<SeatVendor, SeatQuotaDisplay>>

const percent = (used: number): string => Math.round(used) + '%'

// A window inline: its label, a thin bar and the percent after it, in `width` cells.
const meter = (c: Canvas, x: number, y: number, width: number, label: string, used: number | undefined, out: boolean, color: number): void => {
  write(c, x, y, label, SECONDARY)
  const barX = x + label.length + 1
  const barWidth = Math.max(1, width - label.length - 1 - 5)
  if (used === undefined) {
    dashedBar(c, barX, y, barWidth, rgb(UNKNOWN))
    write(c, barX + barWidth + 1, y, '?', rgb(UNKNOWN))
    return
  }
  const tone = out || used >= 95 ? rgb(RED) : used >= 80 ? rgb(AMBER) : color
  thinBar(c, barX, y, barWidth, Math.min(100, used) / 100, tone, SECONDARY)
  write(c, barX + barWidth + 1, y, percent(used), tone === color ? SECONDARY : tone)
}

const QUOTA_NAME = 7
const QUOTA_GAP = 3

// The quota band: a block per shown vendor on one line, its meters 15 cells at most and
// shrunk to fit down to 11; a vendor a line at full size when even that does not fit.
export const quotaRaster = (quotas: Quotas, shown: readonly SeatVendor[], columns: number): Drawing => {
  const fitted = Math.floor((columns - (shown.length - 1) * QUOTA_GAP - shown.length * (QUOTA_NAME + 1)) / (shown.length * 2))
  const isWide = fitted >= 11
  const meterWidth = Math.min(15, isWide ? fitted : Math.max(6, Math.floor((columns - QUOTA_NAME - 1) / 2)))
  const block = QUOTA_NAME + meterWidth * 2 + 1
  const lineWidth = isWide ? shown.length * block + (shown.length - 1) * QUOTA_GAP : block
  const c = canvas(Math.min(columns, lineWidth), isWide ? 1 : shown.length)
  shown.forEach((vendor, index) => {
    const x = isWide ? index * (block + QUOTA_GAP) : 0
    const y = isWide ? 0 : index
    const quota = quotas[vendor]
    const color = rgb(PALETTE[vendor])
    write(c, x, y, vendor, color)
    meter(c, x + QUOTA_NAME, y, meterWidth, '5H', windowUsed(quota, quota?.fiveHour), quota?.out === true, color)
    meter(c, x + QUOTA_NAME + meterWidth + 1, y, meterWidth, 'WK', windowUsed(quota, quota?.weekly), quota?.out === true, color)
  })
  return finish(c)
}

// The queue as one row: label, a bar with a `Tasks d/t` pill at the head of what is done, the percent.
export const queueRaster = (queue: QueueDisplay | null, running: number, columns: number): Drawing => {
  const c = canvas(columns, 1)
  put(c, 0, 0, '●', rgb(ACCENT))
  if (!queue) {
    write(c, 2, 0, plural(running, 'seat') + ' running')
    return finish(c)
  }
  const total = queue.done + queue.running + queue.pending
  const end = writeEnd(c, columns, 0, percent(queue.done / total * 100), SECONDARY)
  const titleWidth = write(c, 2, 0, queue.label ?? 'Autopilot queue', DEFAULT, Math.max(8, Math.floor(columns * 0.4)))
  const barX = 2 + titleWidth + 1
  const barWidth = end - 1 - barX
  if (barWidth < 4) return finish(c)
  const doneCells = Math.round(barWidth * queue.done / total)
  const runCells = Math.round(barWidth * (queue.done + queue.running) / total)
  for (let offset = 0; offset < barWidth; offset += 1) put(c, barX + offset, 0, '░', offset < runCells ? rgb(ACCENT) : SECONDARY)
  for (let index = 1; index < total; index += 1) {
    const tick = Math.round(barWidth * index / total)
    if (tick > runCells) put(c, barX + tick, 0, '╎', SECONDARY)
  }
  const pill = ' Tasks ' + queue.done + '/' + total + ' '
  const pillWidth = Math.min(barWidth, pill.length)
  const pillX = Math.max(0, Math.min(barWidth - pillWidth, doneCells - pillWidth))
  const pillEnd = Math.max(pillX + pillWidth, doneCells)
  for (let offset = pillX; offset < pillEnd; offset += 1) put(c, barX + offset, 0, ' ', WHITE, rgb(ACCENT))
  write(c, barX + pillX, 0, pill, WHITE, pillWidth, rgb(ACCENT))
  return finish(c)
}

export const headerRaster = (values: Totals, columns: number): Drawing => {
  const c = canvas(columns, 5)
  const claude = rgb(PALETTE.claude)
  write(c, 0, 0, plural(values.seats, 'seat') + ' in this session', claude)
  const gap = 1
  const cell = Math.floor((columns - gap * 2) / 3)
  const tiles: [string, string][] = [['Seats', String(values.seats)], ['Tokens', fmtTokens(values.tokens)], ['Time', fmtTime(values.time)]]
  tiles.forEach(([label, value], index) => {
    const x = index * (cell + gap)
    frame(c, x, 1, cell, 4, SECONDARY)
    write(c, x + 2, 2, label, SECONDARY, cell - 3)
    write(c, x + 2, 3, value, claude, cell - 3)
  })
  return finish(c)
}

export const runningRaster = (count: number, columns: number): Drawing => {
  const c = canvas(columns, 1)
  fill(c, 0, 0, columns, 1, rgb(GREEN))
  write(c, 1, 0, '▾ Running · ' + count, WHITE, columns - 2, rgb(GREEN))
  return finish(c)
}

export const CARD_ROWS = 6
const LOGO_COLUMNS = 12

// The vendor's figure at half its desktop size: a pixel per 2×2 block, ink where any of it is ink,
// else the vendor colour where any of it is; a sparser rule turns the sparkle into a plus.
const drawFigure = (c: Canvas, vendor: SeatVendor, x: number, y: number, color: number, ink: number): void => {
  const rows = figureRows(vendor)
  for (let ty = 0; ty < 8; ty += 1) {
    for (let tx = 0; tx < LOGO_COLUMNS; tx += 1) {
      const block = [0, 1].flatMap(dy => [0, 1].map(dx => rows[ty * 2 + dy]?.[tx * 2 + dx] ?? '.'))
      if (block.includes('i')) pixel(c, x + tx, y + ty, ink)
      else if (block.includes('#')) pixel(c, x + tx, y + ty, color)
    }
  }
}

export const cardRaster = (card: Card, now: number, columns: number): Drawing => {
  const c = canvas(columns, CARD_ROWS)
  const isDone = card.status === 'done'
  const vendor = rgb(PALETTE[card.vendor])
  const color = isDone ? dim(vendor) : vendor
  frame(c, 0, 0, columns, CARD_ROWS, color)
  const hasFigure = columns >= 34
  // Pixel rows 2..9 are cell rows 1..4, the card's inside.
  if (hasFigure) drawFigure(c, card.vendor, 2, 2, color, isDone ? dim(rgb(INK)) : rgb(INK))
  const left = hasFigure ? 2 + LOGO_COLUMNS + 2 : 2
  const right = columns - 2
  write(c, right - 1, 1, isDone ? '✓' : '●', rgb(GREEN))
  write(c, left, 1, card.description, DEFAULT, right - 2 - left)
  const stats = fmtTokens(card.tokens) + ' tokens · ' + fmtTime(elapsed(card, now))
  const statsX = writeEnd(c, right, 2, stats, SECONDARY)
  write(c, left, 2, [card.vendor, card.model, card.effort].filter(Boolean).join(' · '), SECONDARY, statsX - 1 - left)
  if (isDone) write(c, left, 3, stepLine(card), rgb(GREEN), right - left)
  else {
    put(c, left, 3, '◑', rgb(STEP))
    write(c, left + 2, 3, stepLine(card), rgb(STEP), right - left - 2)
  }
  thinBar(c, left, 4, right - left, progress(card), color, SECONDARY)
  return finish(c)
}

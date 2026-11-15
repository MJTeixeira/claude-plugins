/** The lens's moods: idle breathes, thinking narrows the iris and turns the ring, flare follows a new card. */
export type LensState = 'idle' | 'thinking' | 'flare'

export const FLARE_MS = 1400

export type Profile = { hash: number, hue: number, secHue: number, rings: number, blades: number }

/** The same name always gives the same lens: FNV-1a over the name sets hue, ring count and blades. */
export const profileOf = (name: string): Profile => {
  let hash = 0x811c9dc5
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  hash >>>= 0
  const hue = hash % 360
  return { hash, hue, secHue: (hue + 45) % 360, rings: 2 + (hash % 3), blades: 5 + (hash % 4) }
}

export const hslToRgb = (h: number, s: number, l: number): number => {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)))
  return (byte(r) << 16) | (byte(g) << 8) | byte(b)
}

/** How long after a digest the lens thinks, if no card comes back: most turns get no reply. */
export const THINK_MS = 60_000

export const stateOf = (isAwaiting: boolean, sentAt: number | undefined, flareAt: number | undefined, now: number): LensState =>
  flareAt !== undefined && now - flareAt >= 0 && now - flareAt < FLARE_MS ? 'flare'
    : isAwaiting && sentAt !== undefined && now - sentAt < THINK_MS ? 'thinking'
      : 'idle'

/**
 * The lens as `size` by `size` pixels, 0xRRGGBB, row-major; `undefined`
 * outside the chassis. `t` is seconds, `flare` 1 at a card's arrival down to 0.
 */
export const lensPixels = (name: string, size: number, t: number, state: LensState, flare = 0): (number | undefined)[] => {
  const profile = profileOf(name)
  const centre = (size - 1) / 2
  const maxR = centre * 1.05
  const scale = size / 20
  const breath = 0.5 + 0.5 * Math.sin(t * 2.2)
  const lit = state === 'flare' ? flare : 0
  const iris = state === 'thinking' ? (2.4 + 0.3 * Math.sin(t * 7)) * scale
    : lit > 0 ? (5.5 + 2 * lit) * scale
      : 4.2 * scale
  const spin = state === 'thinking' ? t * 4.5 : 0
  const out: (number | undefined)[] = []
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - centre
      const dy = y - centre
      const r = Math.sqrt(dx * dx + dy * dy)
      const u = r / maxR
      const angle = Math.atan2(dy, dx)
      if (u > 1.02) {
        out.push(undefined)
        continue
      }
      if (u > 0.85) {
        const shade = Math.floor(40 + (0.5 + 0.5 * Math.cos(angle - 0.7)) * 35)
        out.push((shade << 16) | ((shade + 5) << 8) | (shade + 12))
        continue
      }
      if (u > 0.72) {
        const tick = 0.5 + 0.5 * Math.sin(angle * profile.blades + spin)
        const glow = state === 'idle' ? 0.35 : 0.8
        out.push(hslToRgb(profile.hue, 0.8, 0.25 + tick * glow * 0.4))
        continue
      }
      const ring = profile.rings > 0 && Math.abs(u * profile.rings * 1.2 % 1 - 0.5) < 0.04 ? 0.08 : 0
      const corona = Math.exp(-(((r - iris * 1.3) / (1.2 * scale)) ** 2)) * 0.7 * (0.6 + 0.4 * breath)
      const core = Math.exp(-((r / (iris * 0.85)) ** 2)) + lit * 1.5
      const glintR = Math.sqrt((x - (centre - 1.8 * scale)) ** 2 + (y - (centre - 1.8 * scale)) ** 2)
      const glint = Math.exp(-((glintR / (1.4 * scale)) ** 2)) * 0.75
      const lum = Math.min(1, core * 0.95 + corona * 0.6 + glint + ring)
      let hue = profile.hue
      let sat = 0.9
      let light = lum * 0.6
      if (r < 1.8 * scale || lum > 0.88) {
        light = 0.92
        sat = 0.2
        hue = profile.secHue
      }
      if (lit > 0 && Math.abs(dy) < 1.2 * scale) light = Math.min(1, light + lit * 0.6)
      out.push(hslToRgb(hue, sat, light))
    }
  }
  return out
}

/** The terminal's own colour, for a cell the lens leaves empty. */
export const DEFAULT = 0x01000000

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64[(word >> 18) & 63]! + BASE64[(word >> 12) & 63]!
      + (i + 1 < bytes.length ? BASE64[(word >> 6) & 63]! : '=')
      + (i + 2 < bytes.length ? BASE64[word & 63]! : '=')
  }
  return out
}

export type Drawing = { cells: string, columns: number, rows: number }

/**
 * Pixels as a `Raster`: two pixel rows per cell, drawn with half blocks.
 * The element reads little-endian u32 triplets [codePoint, foreground, background], row-major.
 */
export const toRaster = (pixels: readonly (number | undefined)[], columns: number): Drawing => {
  const rows = Math.ceil(pixels.length / columns / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = pixels[y * 2 * columns + x]
      const bottom = pixels[(y * 2 + 1) * columns + x]
      const at = (y * columns + x) * 3
      words[at] = top !== undefined ? 0x2580 : bottom !== undefined ? 0x2584 : 0x20
      words[at + 1] = top ?? bottom ?? DEFAULT
      words[at + 2] = top !== undefined ? bottom ?? DEFAULT : DEFAULT
    }
  }
  return { cells: toBase64(new Uint8Array(words.buffer)), columns, rows }
}

/** The terminal lens: 20 by 10 cells. */
export const lensRaster = (name: string, t: number, state: LensState, flare = 0): Drawing =>
  toRaster(lensPixels(name, 20, t, state, flare), 20)

const hsl = (h: number, s: number, l: number): string => 'hsl(' + h + ',' + s + '%,' + l + '%)'

/**
 * The app lens: the same profile as a smooth SVG, animated with SMIL.
 * `key` names the drawing, so a new flare is a new document and plays again.
 */
export const lensSvg = (name: string, state: LensState, size: number, key = ''): string => {
  const p = profileOf(name)
  const id = 'l' + p.hash.toString(36) + key
  const iris = state === 'thinking' ? 11 : 18
  const blades = Array.from({ length: p.blades * 2 }, (_, i) => {
    const a = (i / (p.blades * 2)) * Math.PI * 2
    const bright = i % 2 === 0 ? 55 : 32
    const [x1, y1, x2, y2] = [50 + Math.cos(a) * 36.5, 50 + Math.sin(a) * 36.5, 50 + Math.cos(a) * 42, 50 + Math.sin(a) * 42]
    return '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2)
      + '" stroke="' + hsl(p.hue, 80, state === 'idle' ? bright - 10 : bright) + '" stroke-width="3.2" stroke-linecap="round"/>'
  }).join('')
  const rings = Array.from({ length: p.rings }, (_, i) =>
    '<circle cx="50" cy="50" r="' + (20 + i * (14 / p.rings)).toFixed(1) + '" fill="none" stroke="' + hsl(p.hue, 70, 40) + '" stroke-opacity="0.35" stroke-width="0.6"/>').join('')
  const spin = state === 'thinking'
    ? '<animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="2.4s" repeatCount="indefinite"/>'
    : ''
  const coreAnim = state === 'thinking'
    ? '<animate attributeName="r" values="10;13;10" dur="0.9s" repeatCount="indefinite"/>'
    : state === 'flare'
      ? '<animate attributeName="r" values="27;18" dur="1.4s" fill="freeze"/>'
      : ''
  const flare = state === 'flare'
    ? '<ellipse cx="50" cy="50" rx="46" ry="2.6" fill="#fff"><animate attributeName="opacity" values="0.95;0" dur="1.4s" fill="freeze"/></ellipse>'
    : ''
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + size + '" height="' + size + '">'
    + '<defs>'
    + '<radialGradient id="' + id + 'c"><stop offset="0" stop-color="' + hsl(p.secHue, 20, 92) + '"/><stop offset="0.22" stop-color="' + hsl(p.hue, 90, 58) + '"/>'
    + '<stop offset="0.6" stop-color="' + hsl(p.hue, 90, 28) + '"/><stop offset="1" stop-color="' + hsl(p.hue, 90, 8) + '" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="' + id + 'r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5a6070"/><stop offset="1" stop-color="#23262e"/></linearGradient>'
    + '</defs>'
    + '<circle cx="50" cy="50" r="49" fill="url(#' + id + 'r)"/>'
    + '<circle cx="50" cy="50" r="43" fill="' + hsl(p.hue, 60, 7) + '"/>'
    + '<g>' + blades + spin + '</g>'
    + '<circle cx="50" cy="50" r="36" fill="#07080b"/>'
    + rings
    + '<circle cx="50" cy="50" r="' + (iris * 1.6).toFixed(1) + '" fill="' + hsl(p.hue, 90, 40) + '" opacity="0.3">'
    + '<animate attributeName="opacity" values="0.18;0.4;0.18" dur="2.9s" repeatCount="indefinite"/></circle>'
    + '<circle cx="50" cy="50" r="' + iris + '" fill="url(#' + id + 'c)">' + coreAnim + '</circle>'
    + flare
    + '<circle cx="41" cy="41" r="5" fill="#fff" opacity="0.45"/>'
    + '</svg>'
}

#!/usr/bin/env node
// Prints codex's live rate limits as JSON (account/rateLimits/read), one window per
// bucket and duration: {"plan":"plus","allowed":true,"windows":[{"name":"5h","minutes":300,"used":5,"resetAt":<epoch ms>}]}.
// The account's own bucket (`rateLimits`) gives windows for every model; a bucket for one
// model (`normalModelSlug`) gives its windows `models`. A limit reached with no window
// to measure it is a window without `used`. Exits 1 naming what failed.
import { request } from './codex-app.mjs'

const durationName = minutes => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`

const result = await request('codex-usage', 'account/rateLimits/read')
const shared = result.rateLimits ?? result.rateLimitsByLimitId?.codex
// rateLimitsByLimitId repeats the account's bucket; any other bucket that names no model
// meters something codex does not say, so it applies to no seat.
const ownBuckets = Object.values(result.rateLimitsByLimitId ?? {}).filter(bucket => bucket?.normalModelSlug && bucket.limitId !== shared?.limitId)
const windowsOf = (bucket, model) => {
  const scoped = model ? { models: [model] } : {}
  const label = model && (bucket.limitName ?? model)
  const reached = bucket.rateLimitReachedType == null ? {} : { reached: bucket.rateLimitReachedType }
  const windows = [bucket.primary, bucket.secondary].filter(Boolean).map(window => {
    const minutes = window.windowDurationMins ?? undefined
    return {
      name: [label, minutes === undefined ? 'window' : durationName(minutes)].filter(Boolean).join(' '),
      ...scoped,
      ...(minutes === undefined ? {} : { minutes }),
      used: window.usedPercent,
      ...(window.resetsAt == null ? {} : { resetAt: window.resetsAt * 1000 }),
      ...reached,
    }
  })
  return windows.length || !reached.reached ? windows : [{ name: label || 'limit', ...scoped, ...reached }]
}
const plan = shared?.planType
console.log(JSON.stringify({
  ...(plan == null ? {} : { plan }),
  ...(result.ordinaryUsageAllowed == null ? {} : { allowed: result.ordinaryUsageAllowed }),
  windows: [...(shared ? windowsOf(shared) : []), ...ownBuckets.flatMap(bucket => windowsOf(bucket, bucket.normalModelSlug))],
}))
process.exit(0)

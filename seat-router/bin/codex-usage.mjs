#!/usr/bin/env node
// Prints codex's live rate limits as JSON (account/rateLimits/read). Exits 1 naming what failed.
import { request } from './codex-app.mjs'

const result = await request('codex-usage', 'account/rateLimits/read')
const { primary, secondary, rateLimitReachedType, planType } = result.rateLimits
console.log(JSON.stringify({
  plan: planType,
  allowed: result.ordinaryUsageAllowed,
  reached: rateLimitReachedType,
  five_hour: { utilization: primary.usedPercent, resets_at: primary.resetsAt },
  seven_day: { utilization: secondary.usedPercent, resets_at: secondary.resetsAt },
}))
process.exit(0)

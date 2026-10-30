#!/usr/bin/env node
// Prints the codex models this account offers as JSON (model/list, every page):
// [{ model, efforts, isDefault }], hidden ones left out. Exits 1 naming what failed.
import { request } from './codex-app.mjs'

const models = []
let cursor
do {
  const page = await request('codex-models', 'model/list', cursor === undefined ? {} : { cursor })
  models.push(...page.data)
  cursor = page.nextCursor || undefined
} while (cursor !== undefined)
console.log(JSON.stringify(models.filter(entry => !entry.hidden).map(entry => ({
  model: entry.model,
  efforts: entry.supportedReasoningEfforts.map(effort => effort.reasoningEffort),
  isDefault: entry.isDefault === true,
}))))
process.exit(0)

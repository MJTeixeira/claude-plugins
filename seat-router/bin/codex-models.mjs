#!/usr/bin/env node
// Prints the codex models this account offers as JSON (model/list):
// [{ model, efforts, isDefault }], hidden ones left out. Exits 1 naming what failed.
import { request } from './codex-app.mjs'

const result = await request('codex-models', 'model/list', {})
console.log(JSON.stringify(result.data.filter(entry => !entry.hidden).map(entry => ({
  model: entry.model,
  efforts: entry.supportedReasoningEfforts.map(effort => effort.reasoningEffort),
  isDefault: entry.isDefault === true,
}))))
process.exit(0)

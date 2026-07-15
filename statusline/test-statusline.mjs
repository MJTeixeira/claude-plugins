#!/usr/bin/env node
// Behaviour tests for the cross-platform statusline.
// Run: node statusline/test-statusline.mjs
// No test framework — Claude Code bundles Node, nothing else is assumed to exist.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'statusline.cjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Run the statusline with a given input payload, returning stripped stdout.
// A private TMPDIR isolates the token session file per test.
function run(payload, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`statusline exited ${res.status}: ${res.stderr}`);
  }
  // Strip ANSI colour codes so assertions match on plain text.
  return res.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

function isolatedTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-test-'));
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

// --- 1. Renders every segment from a full payload ---------------------------
{
  const out = run({
    cwd: HERE,
    model: { display_name: 'Opus 4.8' },
    effort: { level: 'high' },
    cost: { total_cost_usd: 1.2345, total_lines_added: 10, total_lines_removed: 3 },
    session_id: 'sess-1',
    context_window: {
      total_input_tokens: 5000,
      total_output_tokens: 1000,
      current_usage: {
        input_tokens: 100,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 900,
        output_tokens: 1000,
      },
    },
  }, isolatedTmp());

  check('shows model + effort', out.includes('Opus 4.8 (high)'), out);
  check('shows cost rounded to 2dp', out.includes('Cost: $1.23'), out);
  check('shows a Tokens segment', /Tokens:\s*\S+/.test(out), out);
  check('shows a Context segment', /Context:\s*\S+/.test(out), out);
  check('shows lines changed', out.includes('+10/-3'), out);
  check('has the Code4Food tag', out.includes('Code4Food'), out);
}

// --- 2. Missing / empty fields fall back gracefully -------------------------
{
  const out = run({}, isolatedTmp());
  check('no crash on empty payload', out.length > 0, out);
  check('cost defaults to 0.00', out.includes('Cost: $0.00'), out);
  check('lines default to +0/-0', out.includes('+0/-0'), out);
}

// --- 3. Token accumulation persists across invocations ----------------------
// Two renders of the SAME session with growing raw totals must accumulate,
// not reset. This is the behaviour that silently broke on Windows because the
// session file could not be written to /tmp.
{
  const env = isolatedTmp();
  const base = {
    cwd: HERE,
    model: { display_name: 'Opus 4.8' },
    session_id: 'sess-accum',
    cost: { total_cost_usd: 1.0 },
  };
  const tokensOf = (s) => {
    const m = s.match(/Tokens:\s*([0-9.]+)([kM]?)/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    return m[2] === 'M' ? n * 1e6 : m[2] === 'k' ? n * 1e3 : n;
  };

  const first = run({
    ...base,
    context_window: {
      total_input_tokens: 1000, total_output_tokens: 200,
      current_usage: { input_tokens: 1000, output_tokens: 200 },
    },
  }, env);

  const second = run({
    ...base,
    cost: { total_cost_usd: 2.0 },
    context_window: {
      total_input_tokens: 3000, total_output_tokens: 600,
      current_usage: { input_tokens: 2000, output_tokens: 400 },
    },
  }, env);

  const t1 = tokensOf(first);
  const t2 = tokensOf(second);
  check('first render counts tokens', t1 >= 1200, `got ${t1}`);
  check('second render accumulates (grows)', t2 > t1, `t1=${t1} t2=${t2}`);
}

// --- 4. Restart (cost drops) resets accumulation ----------------------------
{
  const env = isolatedTmp();
  const base = { cwd: HERE, model: { display_name: 'Opus 4.8' }, session_id: 'sess-restart' };
  const tokensOf = (s) => {
    const m = s.match(/Tokens:\s*([0-9.]+)([kM]?)/);
    const n = parseFloat(m[1]);
    return m[2] === 'M' ? n * 1e6 : m[2] === 'k' ? n * 1e3 : n;
  };

  run({
    ...base, cost: { total_cost_usd: 5.0 },
    context_window: {
      total_input_tokens: 10000, total_output_tokens: 2000,
      current_usage: { input_tokens: 10000, output_tokens: 2000 },
    },
  }, env);

  // Cost dropped 5.0 -> 0.1: a new process. Accumulation should restart low.
  const after = run({
    ...base, cost: { total_cost_usd: 0.1 },
    context_window: {
      total_input_tokens: 500, total_output_tokens: 100,
      current_usage: { input_tokens: 500, output_tokens: 100 },
    },
  }, env);
  check('restart resets accumulation', tokensOf(after) < 5000, after);
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

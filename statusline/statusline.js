#!/usr/bin/env node
// Lean Workflow Status Line — cross-platform (macOS, Linux, Windows).
//
// Shows: git branch | model + effort | session cost | cumulative tokens |
//        context size | lines changed
//
// Written in Node (which Claude Code bundles on every platform) rather than
// bash so it has zero external dependencies: no jq, awk, sed, md5sum, /tmp,
// chmod, or shebang, and it is immune to CRLF line endings. That is what makes
// it work on Windows, where the old bash statusline silently failed (the bar
// vanished when the shell couldn't run the .sh, and tokens reset every render
// because the session file couldn't be written under /tmp).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ANSI colours — supported by the Claude Code status line on all platforms.
const MAGENTA = '\x1b[0;35m';
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[0;33m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatTokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function gitBranch(cwd) {
  if (!cwd) return '';
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function main(raw) {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    input = {};
  }

  const cwd = input.cwd || '';

  const modelName = input.model?.display_name || '';
  const effort = input.effort?.level || '';
  const modelDisplay = effort ? `${modelName} (${effort})` : modelName;

  const branch = gitBranch(cwd) || 'no git';

  const cost = num(input.cost?.total_cost_usd);
  const costFormatted = cost.toFixed(2);
  const linesAdded = num(input.cost?.total_lines_added);
  const linesRemoved = num(input.cost?.total_lines_removed);

  // === Token tracking (cumulative across the session, cached tokens included) ===
  // Persisted to a per-cwd file in the OS temp dir so projects don't collide.
  const cw = input.context_window || {};
  const usage = cw.current_usage || {};

  const rawInput = num(cw.total_input_tokens);
  const rawOutput = num(cw.total_output_tokens);
  const rawTotal = rawInput + rawOutput;

  const callInput = num(usage.input_tokens);
  const callCacheRead = num(usage.cache_read_input_tokens);
  const callCacheCreate = num(usage.cache_creation_input_tokens);
  const callOutput = num(usage.output_tokens);
  const callTotal = callInput + callCacheRead + callCacheCreate + callOutput;

  const sessionHash = crypto.createHash('md5').update(cwd).digest('hex');
  const sessionFile = path.join(os.tmpdir(), `lean-statusline-session-${sessionHash}`);

  let prev = { sessionId: '', rawTotal: 0, accumulated: 0, cost: 0 };
  try {
    prev = { ...prev, ...JSON.parse(fs.readFileSync(sessionFile, 'utf8')) };
  } catch {
    // First render for this project, or unreadable state — start fresh.
  }

  const sessionId = input.session_id || '';
  let accumulated = num(prev.accumulated);
  let prevRawTotal = num(prev.rawTotal);

  // Process restart: cost decreased since the last render → reset accumulation.
  if (num(prev.cost) > 0 && cost < num(prev.cost)) {
    accumulated = 0;
    prevRawTotal = 0;
  }

  // /clear (session id changed): reset the raw baseline.
  if (sessionId && sessionId !== prev.sessionId) {
    prevRawTotal = 0;
  }

  if (rawTotal !== prevRawTotal) {
    const rawDelta = rawTotal - prevRawTotal;
    const callNonCached = callInput + callOutput;
    let extra = 0;
    if (rawDelta > callNonCached && callNonCached > 0) {
      extra = rawDelta - callNonCached;
    }
    accumulated += callTotal + extra;
    prevRawTotal = rawTotal;
  }

  try {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ sessionId, rawTotal: prevRawTotal, accumulated, cost }),
    );
  } catch {
    // Non-fatal: if temp isn't writable we still render, just without carry-over.
  }

  const contextLength = callInput + callCacheRead + callCacheCreate;

  const tokensFormatted = formatTokens(accumulated);
  const contextFormatted = formatTokens(contextLength);

  process.stdout.write(
    `${MAGENTA}⎇ ${branch}${NC} | ${YELLOW}${modelDisplay}${NC} | ` +
      `${GREEN}Cost: $${costFormatted}${NC} | ${CYAN}Tokens: ${tokensFormatted}${NC} | ` +
      `Context: ${contextFormatted} | Lines: +${linesAdded}/-${linesRemoved} | ` +
      `${DIM}By Code4Food${NC}\n`,
  );
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => main(stdin));

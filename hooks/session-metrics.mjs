#!/usr/bin/env node
// SessionEnd hook: append one metrics row per piloted session in an
// opted-in project (same .docs/index.md gate as the contract injector) —
// the piloted-side counterpart of the factory driver's metrics.jsonl,
// schema-aligned so fleet and piloted data feed the same improvement
// reviews. Differences are documented per field below; best-effort by
// design: any parse gap yields nulls/zeroes, any error yields no row — a
// metrics hook must never break a session.
//
// Output: ~/.claude/code4food/metrics.jsonl (directory overridable via
// CODE4FOOD_METRICS_DIR — the tests use it).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { optedInRoot } from "./lib/project-root.mjs";

// The harness's standard rejection text in tool results — the closest
// piloted analogue of the driver's permission_denials count.
const DENIAL = "doesn't want to proceed with this tool use";

let input = null;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

try {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const root = optedInRoot(cwd);
  if (!root) process.exit(0);

  const contexts = [];
  const tools = {};
  let denials = 0;
  let lastMsgId = null;
  for (const line of fs.readFileSync(input.transcript_path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === "assistant" && obj.message) {
      const m = obj.message;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "tool_use" && b.name) tools[b.name] = (tools[b.name] ?? 0) + 1;
      }
      // The CLI writes one transcript line per content block; the lines
      // of one message share its id and usage. Count each message once
      // (driver parity: only messages carrying usage become turns).
      if (m.usage && (m.id == null || m.id !== lastMsgId)) {
        const u = m.usage;
        contexts.push((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
        lastMsgId = m.id ?? null;
      }
    } else if (obj?.type === "user" && line.includes(DENIAL)) {
      denials += 1;
    }
  }

  // Decimate to ≤ ~100 points, keeping the final turn — piloted sessions
  // run long and a row must stay a cheap jsonl line. Peak stays exact.
  const stride = Math.max(1, Math.ceil(contexts.length / 100));
  const trajectory = [];
  for (let i = 0; i < contexts.length; i += stride) trajectory.push({ t: i, context: contexts[i] });
  if (contexts.length && (contexts.length - 1) % stride !== 0) {
    trajectory.push({ t: contexts.length - 1, context: contexts[contexts.length - 1] });
  }

  const row = {
    ts: new Date().toISOString(),
    mode: "piloted",
    project: path.basename(root),
    sessionId: input.session_id ?? null,
    // Piloted transcripts have no result event; the hook's own reason
    // (clear/logout/exit/other) is the end signal.
    endReason: input.reason ?? "unknown",
    // Assistant-message count — not the API num_turns the driver records,
    // but proportional; good enough for trend lines.
    turns: contexts.length || null,
    peakContext: contexts.length ? Math.max(...contexts) : null,
    trajectory,
    denials,
    tools,
  };
  const dir = process.env.CODE4FOOD_METRICS_DIR || path.join(os.homedir(), ".claude", "code4food");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "metrics.jsonl"), JSON.stringify(row) + "\n");
} catch {
  // Never break a session for metrics.
}
process.exit(0);

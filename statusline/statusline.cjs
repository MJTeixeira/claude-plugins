#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const NO_COLOR = Boolean(process.env.NO_COLOR);
const color = (code, s) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const dim = (s) => color(90, s);
const blue = (s) => color(34, s);
const amber = (s) => color(33, s);
const red = (s) => color(31, s);
const green = (s) => color(32, s);
const bold = (s) => color(1, s);

function readStdin() {
  try {
    return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function fmtK(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  const k = Math.round((n / 1000) * 10) / 10;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

function gauge(pct) {
  if (pct == null) return "";
  if (pct >= 88) return "●";
  if (pct >= 63) return "◕";
  if (pct >= 38) return "◑";
  if (pct >= 13) return "◔";
  return "○";
}

function main() {
  const input = readStdin();
  // Claude Code omits most payload fields early in a session and outside a repo.

  const modelName = input?.model?.display_name ?? "Claude";
  const effort = input?.effort?.level ?? null;

  const cwd = input?.workspace?.current_dir ?? process.cwd();
  const repo = input?.workspace?.repo?.name ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";

  const branch = git(cwd, ["branch", "--show-current"]);
  const added = git(cwd, ["diff", "--cached", "--numstat"]).split("\n").filter(Boolean).length;
  const modified = git(cwd, ["diff", "--numstat"]).split("\n").filter(Boolean).length;

  const prNumber = input?.pr?.number ?? null;
  const prState = input?.pr?.review_state ?? "open";

  const ctxPct = input?.context_window?.used_percentage ?? null;
  const winSize = input?.context_window?.context_window_size ?? 200000;
  const winUsed = input?.context_window?.total_input_tokens ?? null;
  const over200k = Boolean(input?.exceeds_200k_tokens);

  const inTok = input?.context_window?.current_usage?.input_tokens ?? null;
  const outTok = input?.context_window?.current_usage?.output_tokens ?? null;

  const h5 = input?.rate_limits?.five_hour?.used_percentage ?? null;
  const d7 = input?.rate_limits?.seven_day?.used_percentage ?? null;

  const style = input?.output_style?.name ?? "default";

  const line1 = [];
  line1.push(bold(modelName) + (effort ? dim(` · ${effort}`) : ""));
  if (branch) {
    const dirty = added || modified ? ` ${green(`+${added}`)}${amber(`~${modified}`)}` : "";
    line1.push(branch + dirty);
  }
  if (ctxPct != null) {
    const warn = over200k || ctxPct >= 88;
    const label = winUsed != null ? `${fmtK(winUsed)}/${fmtK(winSize)} (${Math.round(ctxPct)}%)` : `${Math.round(ctxPct)}%`;
    const flag = warn ? ` ${red("⚠")}` : "";
    line1.push(`ctx ${gauge(ctxPct)} ${warn ? red(label) : label}${flag}`);
  }
  if (prNumber != null) {
    line1.push(`PR ${blue(`#${prNumber} ${prState}`)}`);
  }

  const line2 = [];
  if (repo) line2.push(`📁 ${dim(repo)}`);
  if (inTok != null && outTok != null) line2.push(dim(`in ${fmtK(inTok)} · out ${fmtK(outTok)}`));
  const rates = [];
  if (h5 != null) rates.push(`5h ${gauge(h5)} ${Math.round(h5)}%`);
  if (d7 != null) {
    const label = `7d ${gauge(d7)} ${Math.round(d7)}%`;
    rates.push(d7 >= 70 ? amber(label) : label);
  }
  if (rates.length) line2.push(rates.join(dim(" · ")));
  line2.push(dim(style));
  line2.push(dim("By Code4food"));

  process.stdout.write(`${line1.join(dim(" │ "))}\n`);
  process.stdout.write(`${line2.join(dim(" │ "))}\n`);
}

main();

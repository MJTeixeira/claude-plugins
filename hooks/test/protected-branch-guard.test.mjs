// Tests for the interactive protected-branch guard. Run:
//   node --test "hooks/test/*.test.mjs"
// Each case feeds a PreToolUse event to the hook binary: empty stdout =
// allow, a permissionDecision JSON = deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = new URL("../protected-branch-guard.mjs", import.meta.url).pathname;

const git = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const makeRepo = (t, branch) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  git(d, "init", "-q", "-b", branch);
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return d;
};

const run = (cwd, command) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
  });
  return r.stdout.trim(); // "" = allow
};

const allowed = (out) => out === "";

test("commit denied on a protected cwd; allowed on a feature cwd", (t) => {
  const main = makeRepo(t, "main");
  const feat = makeRepo(t, "feature/x");
  assert.match(run(main, 'git commit -m x'), /protected branch 'main'/);
  assert.ok(allowed(run(feat, 'git commit -m x')));
});

test("chained add+commit denied on protected cwd", (t) => {
  const main = makeRepo(t, "main");
  assert.match(run(main, 'git add -A && git commit -m "quick fix"'), /protected branch 'main'/);
});

test("-C git calls are judged by the TARGET repo's branch, not the cwd", (t) => {
  const main = makeRepo(t, "main");
  const feat = makeRepo(t, "feature/x");
  // cwd on main, but every commit/push acts on a feature-branch repo → allow
  assert.ok(allowed(run(main, `git -C ${feat} commit -m x`)),
    "all-(-C) commands must not be blocked by the cwd's branch");
  assert.ok(allowed(run(main, `git -C ${feat} add -A && git -C ${feat} commit -m x && git -C ${feat} push -q -u origin feature/x`)));
  // -C target itself protected → deny, from any cwd
  assert.match(run(feat, `git -C ${main} commit -m x`), /protected branch 'main'/);
});

test("mixed chain: a bare commit next to a -C commit still checks the cwd", (t) => {
  const main = makeRepo(t, "main");
  const feat = makeRepo(t, "feature/x");
  assert.match(run(main, `git -C ${feat} commit -m x && git commit -m y`), /protected branch 'main'/);
});

test("push targeting a protected ref is denied regardless of branch", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.match(run(feat, "git push origin main"), /targets protected branch 'main'/);
  assert.match(run(feat, "git push origin --delete dev"), /targets protected branch 'dev'/);
  assert.ok(allowed(run(feat, "git push origin --delete feature/old")));
});

test("bare and HEAD pushes keep the current-branch check; explicit refspecs don't", (t) => {
  const main = makeRepo(t, "main");
  assert.match(run(main, "git push"), /protected branch 'main'/);
  assert.match(run(main, "git push -u origin HEAD"), /protected branch 'main'/);
  assert.ok(allowed(run(main, "git push origin fix/typo")));
});

// Heredoc bodies are DATA — commit messages and PR bodies routinely contain
// prose like "git push origin main" (this repo writes about the guard
// itself; the fix's own test content tripped the old guard when appended
// via a Bash heredoc). The body must be stripped like quoted strings; real
// commands before/after the heredoc still count. (Hit live 2026-07-13: a
// PR body mentioning push-to-main was denied on a feature branch.)
test("prose about git push/commit inside a heredoc body never trips the rules", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.ok(allowed(run(feat, "git commit -F - <<'EOF'\ndocs: never git push origin main directly — the guard denies it\nEOF")),
    "quoted-delimiter heredoc body is data");
  assert.ok(allowed(run(feat, "gh pr create --body-file - <<EOF\nThis change means git commit and git push origin main are both guarded.\nEOF")),
    "unquoted-delimiter heredoc body is data");
  assert.ok(allowed(run(feat, 'git commit -F - <<"EOF"\ndon\'t git push main — it\'s guarded\nEOF')),
    "double-quoted delimiter; an apostrophe in the body must not unbalance quote-stripping");
});

test("a real command after a heredoc block is still judged", (t) => {
  const feat = makeRepo(t, "feature/x");
  const main = makeRepo(t, "main");
  assert.match(run(feat, "cat <<'EOF'\nharmless prose\nEOF\ngit push origin main"),
    /targets protected branch 'main'/);
  assert.match(run(main, "git commit -F - <<'EOF'\nprose that is fine\nEOF"),
    /protected branch 'main'/, "the commit itself on main still denies — only the body is data");
});

test("<<- heredoc with a tab-indented terminator strips correctly", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.ok(allowed(run(feat, "git commit -F - <<-EOF\n\tprose: git push origin main\n\tEOF")));
});

test("quoted strings never trip the rules", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.ok(allowed(run(feat, 'git commit -m "docs: push main ideas"')));
  assert.ok(allowed(run(feat, 'grep -rn "git push origin main" .')));
});

test("checkout/switch to protected chained with commit or bare push is denied", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.match(run(feat, "git checkout main && git commit -m y"), /checkout\/switch/);
  assert.match(run(feat, "git switch dev && git push"), /checkout\/switch/);
  // post-merge cleanup (explicit refspec) stays allowed
  assert.ok(allowed(run(feat, "git checkout main && git pull && git branch -d f && git push origin --delete f")));
});

test("a grep -C flag is not mistaken for a git -C path", (t) => {
  const feat = makeRepo(t, "feature/x");
  assert.ok(allowed(run(feat, "grep -C 3 foo bar.txt && git commit -m x")));
});

test("non-Bash tools and unreadable events pass through", (t) => {
  const main = makeRepo(t, "main");
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Edit", cwd: main, tool_input: { command: "git commit" } }),
    encoding: "utf8",
  });
  assert.equal(r.stdout.trim(), "");
  const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(bad.stdout.trim(), "");
});

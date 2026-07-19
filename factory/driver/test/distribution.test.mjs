// The canonical-origin contract (migration runbook Phase 0): every machine
// runtime must track the one distribution repo, and URL spelling must not
// matter — https vs ssh vs .git suffix are the same remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_ORIGIN, expectedOrigin, sameOrigin } from "../distribution.mjs";

test("all spellings of the same repo compare equal", () => {
  const forms = [
    "https://github.com/MJTeixeira/claude-plugins",
    "https://github.com/MJTeixeira/claude-plugins.git",
    "https://github.com/MJTeixeira/claude-plugins/",
    "git@github.com:MJTeixeira/claude-plugins.git",
    "ssh://git@github.com/MJTeixeira/claude-plugins.git",
    "https://github.com/mjteixeira/CLAUDE-PLUGINS",
  ];
  for (const f of forms) assert.ok(sameOrigin(f, CANONICAL_ORIGIN), `should match: ${f}`);
});

test("a different repo never compares equal", () => {
  for (const f of [
    "https://github.com/MJTeixeira/code4food-dev-skills",
    "https://github.com/someone-else/claude-plugins-fork",
    "/tmp/somewhere/claude-plugins.git",
    "",
    null,
  ]) assert.ok(!sameOrigin(f, CANONICAL_ORIGIN), `must not match: ${f}`);
});

test("local bare-repo paths compare equal across .git and trailing-slash spellings", () => {
  assert.ok(sameOrigin("/tmp/x/runtime-origin.git", "/tmp/x/runtime-origin.git/"));
  assert.ok(!sameOrigin("/tmp/x/runtime-origin.git", "/tmp/y/runtime-origin.git"));
});

test("FACTORY_RUNTIME_ORIGIN overrides the canonical URL; default is canonical", () => {
  assert.equal(expectedOrigin({}), CANONICAL_ORIGIN);
  assert.equal(expectedOrigin({ FACTORY_RUNTIME_ORIGIN: "/tmp/o.git" }), "/tmp/o.git");
});

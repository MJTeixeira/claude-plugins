// Shared opt-in locator for the plugin's session hooks: find the nearest
// ancestor of cwd (inclusive) carrying .docs/index.md — the project's
// opt-in to the code4food workflow. Boundaries: stop after the first
// directory containing .git (the project root — a nested repo never
// inherits a parent's opt-in) and never check the home directory or
// filesystem root themselves (a stray ~/.docs must not opt in every
// session on the machine).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const optedInRoot = (cwd) => {
  const home = os.homedir();
  let dir = path.resolve(cwd);
  while (dir !== home && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".docs", "index.md"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    dir = path.dirname(dir);
  }
  return null;
};

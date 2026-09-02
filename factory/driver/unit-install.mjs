// Machine-daemon unit installer — the ONE install path for machine-level
// units (the supervisor's, the fleet-publisher's): write the generated file
// where the process manager reads it, wire the manager, enable at boot.
// Extracted from supervisor.mjs's installUnit (T-062), whose contract says
// the publisher is installed by the same installer and unit generator as
// the supervisor — generation lives in schedule.mjs, installation here.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRun = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });

// Installs the single .service/.plist in `files` (a generate*Units result).
// Throws rather than exiting — the CLIs own their exit codes. Deps are
// injectable for tests; real defaults touch the real manager.
export const installMachineUnit = async (kind, files, deps = {}) => {
  const {
    yes = false,
    home = os.homedir(),
    run = defaultRun,
    say = (m) => process.stdout.write(m + "\n"),
    isTTY = process.stdin.isTTY,
  } = deps;

  const confirm = async (what) => {
    if (yes) return;
    if (!isTTY) throw new Error("not a TTY — rerun with --yes to confirm the install");
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${what} [y/N]: `)).trim();
    rl.close();
    if (!/^y(es)?$/i.test(a)) throw new Error("aborted — nothing changed");
  };

  if (kind === "systemd") {
    const name = Object.keys(files).find((f) => f.endsWith(".service"));
    if (!name) throw new Error("no .service file to install");
    const dir = path.join(home, ".config", "systemd", "user");
    await confirm(`install + enable ${name} (systemd user unit, Restart=always)?`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
    // The dumb-outer-net companion a unit's OnFailure names — installed
    // when absent, never overwritten (same rule as schedule --install).
    if (files[name].includes("factory-onfailure@")) {
      const companionSrc = fileURLToPath(new URL("../schedulers/factory-onfailure@.service", import.meta.url));
      const companionDest = path.join(dir, "factory-onfailure@.service");
      if (!fs.existsSync(companionDest) && fs.existsSync(companionSrc)) {
        fs.copyFileSync(companionSrc, companionDest);
      }
    }
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", name]);
    say(`installed and started ${name} (remember: loginctl enable-linger keeps user units alive after logout)`);
  } else if (kind === "launchd") {
    const name = Object.keys(files).find((f) => f.endsWith(".plist"));
    if (!name) throw new Error("no .plist file to install");
    const dir = path.join(home, "Library", "LaunchAgents");
    const dest = path.join(dir, name);
    await confirm(`install + load ${name} (launchd KeepAlive agent)?`);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dest)) { try { run("launchctl", ["unload", dest]); } catch { /* was not loaded */ } }
    fs.writeFileSync(dest, files[name]);
    run("launchctl", ["load", dest]);
    say(`installed and loaded ${name}`);
  } else {
    throw new Error(`no keep-alive process manager for kind ${kind}`);
  }
};

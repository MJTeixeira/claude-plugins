#!/usr/bin/env node
// Writes to <file> the Windows sandbox a codex reviewer can run here: `mxc` when codex's
// mxc sandbox starts a command on this machine, else `unelevated` (Windows older than 24H2
// 26100.9278 or 25H2 26200.9278, or a box where mxc fails on any build: openai/codex#56910).
// Usage: node codex-mxc.mjs <file>
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { command } from './command.mjs'

const { file, args, options } = command('codex', ['-c', 'windows.sandbox="mxc"', 'sandbox', '--permission-profile', ':workspace', '--', 'cmd.exe', '/d', '/c', 'exit 0'])
const ran = spawnSync(file, args, { ...options, stdio: 'ignore', windowsHide: true, timeout: 60_000 })
writeFileSync(process.argv[2], ran.status === 0 ? 'mxc\n' : 'unelevated\n')

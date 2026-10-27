#!/usr/bin/env node
// Prints, one per line, the folders under the home folder an agy reviewer reads so the
// tools installed there run: agy's sandbox mounts nothing under home, so nvm's node or
// sdkman's java cannot start. Each `bin` folder on PATH under home, and the `lib` beside it
// when that sits in a version manager's tree (nvm's npm and java's runtime live there);
// never the install around them, whose etc/npmrc can hold registry tokens. Every check
// runs on the real path, in the case the disk holds it, so `..`, a symlink or a respelling
// cannot turn a PATH entry into home or a folder such as ~/.ssh, ~/.local or ~/.cargo.
// Usage: node tool-reads.mjs <home> <PATH>
import { realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MANAGER_TREES = ['versions', 'candidates', 'installs', 'toolchains']

/** The folders to read, given the home folder, the PATH value and the platform. */
export function toolReads(home, pathValue, platform = process.platform) {
  const windows = platform === 'win32'
  // A folder's real path with `/` separators; none for a name a line break would split.
  const real = path => {
    try {
      const found = statSync(path).isDirectory() ? realpathSync.native(path) : undefined
      if (found === undefined || /[\r\n]/.test(found)) return undefined
      return windows ? found.replaceAll('\\', '/') : found
    } catch { return undefined }
  }
  const root = real(home)
  if (root === undefined) return []
  const under = (folder, name) => folder?.startsWith(root + '/') === true && folder.endsWith('/' + name)
  const folders = new Set()
  for (const entry of pathValue.split(windows ? ';' : ':')) {
    if (!(windows ? /^[A-Za-z]:[\\/]/ : /^\//).test(entry)) continue
    const folder = real(entry)
    if (!under(folder, 'bin')) continue
    folders.add(folder)
    const install = folder.slice(0, -'/bin'.length)
    const above = install.slice(root.length + 1).split('/').slice(0, -1)
    const lib = above.some(segment => MANAGER_TREES.includes(segment.toLowerCase())) ? real(install + '/lib') : undefined
    if (under(lib, 'lib')) folders.add(lib)
  }
  return [...folders].sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [home = '', pathValue = ''] = process.argv.slice(2)
  for (const folder of toolReads(home, pathValue)) console.log(folder)
}

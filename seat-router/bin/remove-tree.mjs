import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export function removeTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isSymbolicLink()) {
    // Windows removes a junction with rmdir, which leaves its target alone.
    try { unlinkSync(path) } catch { rmdirSync(path) }
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name))
    rmdirSync(path)
  } else unlinkSync(path)
}

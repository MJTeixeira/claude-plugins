/** Why removing a ready worktree would lose work; ignored files do not count. */
export const worktreeKeepReason = async (git, tree, baseSha) => {
  const status = await git(['-C', tree, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])
  if (status.exitCode !== 0) return 'git could not read its changes'
  if (status.stdout.trim()) return 'it has uncommitted changes, untracked files or submodule changes'
  const commits = await git(['-C', tree, 'rev-list', 'HEAD', '--not', '--remotes', ...(baseSha ? [baseSha] : [])])
  if (commits.exitCode !== 0) return 'git could not read its unpushed commits'
  if (commits.stdout.trim()) return 'it has unpushed commits'
  return undefined
}

// Git requires --force even for a clean initialized submodule. Call only after the work check above passed.
export const worktreeRemoveFlags = async (git, tree) => {
  const files = await git(['-C', tree, 'ls-files', '--stage'])
  if (files.exitCode !== 0) throw new Error('git could not inspect the worktree submodules')
  return /(?:^|\n)160000 /.test(files.stdout) ? ['--force'] : []
}

/**
 * How a finished seat's worktree goes: `{ keep }` names why it stays, `{ flags }` the flags git worktree remove takes. A
 * reviewer's always goes, forced past build output, untracked files and a lock, since a reviewer's work is its report.
 */
export const worktreeRelease = async (git, tree, seat) => {
  if (seat.tier === 'reviewer') return { flags: ['--force', '--force'] }
  const keep = await worktreeKeepReason(git, tree, seat.baseSha)
  return keep ? { keep } : { flags: await worktreeRemoveFlags(git, tree) }
}

import type { EngineInterface } from 'claude-code'
import { homeOf } from '../bin/core/layout.mjs'

// Node and the CLIs take `/` on Windows too, so paths the mod builds join with it.
export function join(...parts: string[]): string {
  return parts.join('/')
}

export function slashed(path: string): string {
  return path.replaceAll('\\', '/')
}

export async function osOf($: EngineInterface): Promise<'windows' | 'posix'> {
  return await $.env.get('OS') === 'Windows_NT' ? 'windows' : 'posix'
}

export async function homeDir($: EngineInterface): Promise<string | undefined> {
  return await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
}

/** The seat-router home, by the rule bin/core/layout.mjs states for the supervisor too. */
export async function seatHome($: EngineInterface): Promise<string> {
  const env: Record<string, string | undefined> = {
    SEAT_ROUTER_HOME: await $.env.get('SEAT_ROUTER_HOME'), OS: await $.env.get('OS'), HOME: await $.env.get('HOME'),
    LOCALAPPDATA: await $.env.get('LOCALAPPDATA'), USERPROFILE: await $.env.get('USERPROFILE'), PUBLIC: await $.env.get('PUBLIC'),
    USERDOMAIN: await $.env.get('USERDOMAIN'), USERNAME: await $.env.get('USERNAME'),
  }
  const found = homeOf((name: string) => env[name])
  if (!found) throw new Error('this environment names no home folder for seat-router')
  return found.home
}

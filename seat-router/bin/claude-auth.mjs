import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code's authentication precedence puts these variables above the login a
// CLAUDE_CONFIG_DIR holds (https://code.claude.com/docs/en/authentication.md): a
// cloud provider a CLAUDE_CODE_USE_* variable selects (env-vars.md lists Bedrock,
// Mantle, Vertex, Foundry and Claude Platform on AWS), then the bearer token, the API
// key and the OAuth token. A child meant to run on another account's login runs
// without them; settings such as CLAUDE_CODE_USE_POWERSHELL_TOOL stay.
const AUTH = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]

export const withoutClaudeAuth = env => Object.fromEntries(Object.entries(env).filter(([name]) => !AUTH.includes(name.toUpperCase())))

// macOS keys Claude's Keychain entry differently when CLAUDE_CONFIG_DIR is set, even to ~/.claude.
export const claudeConfigEnv = env => {
  const configured = env.CLAUDE_CONFIG_DIR
  if (!configured) return env
  try {
    if (realpathSync.native(configured) === realpathSync.native(join(env.HOME ?? env.USERPROFILE ?? homedir(), '.claude'))) {
      const { CLAUDE_CONFIG_DIR: _default, ...rest } = env
      return rest
    }
  } catch { /* A missing folder is left for Claude to report. */ }
  return env
}

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

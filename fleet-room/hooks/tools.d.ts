export {}
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__fleet-room__post': {text: string, thread?: string, topic?: string}
    'mcp__fleet-room__codex_chats': {all?: boolean}
    'mcp__fleet-room__codex_pair': {thread: string}
    'mcp__fleet-room__codex_send': {text: string}
  }
}

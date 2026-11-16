/** Minted once per hooks process; a saved wake that carries another was left by a process that is gone. */
export type FleetRoomProcess = string

declare module 'claude-code' {
  interface PluginState {
    'fleet-room': {
      process: FleetRoomProcess
    }
  }
}

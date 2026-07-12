# Architecture defaults (agent-legible code)

Defaults for plans that create new structure — a new project, a new area, or
the first instance of a layer. They optimize for the next session that reads
this code with zero memory: fewer files per change, verifiable behavior, one
obvious way to do each thing. Deviate when the project has a reason, and
record the deviation in `.docs/`.

## Structure

- **Vertical slices** — colocate route/UI, logic, and tests by feature, not
  by technical layer. One change should touch one cohesive area.
- **One golden-path exemplar per layer** — the first route/entity/job sets
  the pattern: make it exemplary, point to it from `.docs/<area>.md` ("to add
  an X, copy Y"), and copy it thereafter. Uniformity beats elegance.
- **Inject the impurities** — clock, randomness, and external IO enter as
  parameters or constructor args, never module-level singletons. This is
  what makes verification commands deterministic.
- **Explicit state over boolean flags** — model lifecycles as a closed set of
  named states (discriminated unions / enums plus transition functions), so
  illegal states are unrepresentable and transitions are enumerable in tests.
- **Seams only where a second implementation exists today** (a test fake, a
  second provider). No repository interfaces or adapter layers "for later".

## Avoid — each one multiplies files-to-read per change

Metaprogramming cleverness, implicit global singletons, deep inheritance
(prefer composition), barrel-file re-export mazes, hidden middleware magic,
config indirection with a single consumer.

## Engine projects (Godot / Unity)

Composition (nodes/components) over inheritance; signals/events over direct
node references; content as data files (Resources / ScriptableObjects) so
iteration edits data, not code. Keep scenes/prefabs SMALL and numerous —
scene files don't merge, so one change should touch one scene.

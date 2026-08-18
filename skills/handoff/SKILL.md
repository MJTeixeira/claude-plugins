---
name: handoff
description: Compact the current conversation into a handoff for another agent to pick up — written back onto the backlog task when the work in flight is a task, otherwise as a portable document.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

**If the work in flight is a backlog task, the handoff _is_ the task.** A task and a handoff are one object at two stages of its life, so write the progress back onto the task block in `.factory/backlog/`: `- Status: in-progress`, and everything the next session needs under `- Notes:`. A separate file forks the state in two, and only one of the two forks is pickable by a factory window.

`Notes:` is free prose — the driver's parser reads the fields around it, not it — with one constraint: no `## ` headings inside a task block, because a `## ` line starts a new block and would cut the task in half. Use bold lines or bullets instead.

Otherwise, write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Either way:

Include a "suggested skills" section, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, tasks, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

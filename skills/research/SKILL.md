---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a comment on the issue it serves. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Post it as a comment on the issue the research serves (`gh issue comment <n> --body-file <file>`). When it serves no issue, save it to a temporary file outside the repository and say where. Never write it into the repository.

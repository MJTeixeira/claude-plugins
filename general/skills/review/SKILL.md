---
name: review
description: "Make a working change good before it merges. Reviews the commits since a fixed point against the repository's own standards over a fixed baseline, the issue's acceptance criteria, and the docs that name what the diff renames, moves or deletes. Commits the fixes it can make and fails only for what it cannot fix. Runs with no one to ask. Use for /code4food-general:review, or to review a branch or a diff before merge."
---

# Review

The implementer before you made the change work. Your job is to make it good: find what is wrong, fix it, and commit the fixes. Fail only for what you cannot fix.

If you were started by another program, its prompt owns the fixed point, the issue, what you must not do and how your reply ends. This skill owns the method. Where they disagree, follow the prompt.

Never ask a question; where this skill offers no default, record the gap in the report and go on. Do not call another skill or plugin. Do not clean up comments and do not write a PR body: other steps own both.

## 1. Pin the fixed point

The fixed point is the argument or the one the caller's prompt names. Otherwise it is the remote's default branch (`git rev-parse --abbrev-ref origin/HEAD`).

Capture the diff once: `git diff <fixed-point>...HEAD` (three dots, so it compares against the merge base), and the commits: `git log <fixed-point>..HEAD --oneline`. Confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is not empty. A bad ref or an empty diff fails here.

## 2. Find the spec

Take the first that exists:

1. An issue number or a file path passed as the argument or named by the caller.
2. An issue referenced in the commit messages (`#123`, `Closes #45`), read with `gh issue view <n> --comments`.

The acceptance criteria are the issue's Acceptance section, or every requirement it states when it has no such section. With no spec, skip the Spec axis and say so in the report.

## 3. Review, in four parts

**Standards.** The repository's documented standards are `CODING_STANDARDS.md` when it exists, plus the rules in `CLAUDE.md` and `AGENTS.md` at the root and in each directory the diff touches. Check the diff against them, then against the fixed baseline in [baseline.md](baseline.md): the smell baseline, the review rubric, and the five test shapes. Where the repository's rules and the baseline disagree, the repository wins. No standards file is required. Cite the rule (file and line) for each finding, and skip what tooling already enforces. A finding counts only when you can trace it through the code. "I would have done it differently" is not a finding.

**Spec.** For each acceptance criterion, decide whether it holds against the diff, and quote the criterion. Also report behavior the diff adds that the spec did not ask for.

**Stale docs.** List what the diff renames, moves or deletes: paths from `git diff --name-status -M <fixed-point>...HEAD` (the `R` and `D` rows), and the symbols from reading the diff. Find every doc that still names one: `git grep -n -F '<old name>'`. Each one is fixed in this change. This rule cannot catch prose that describes the old behavior without naming a path or symbol, so read the docs next to the changed code as well.

**Merge danger.** Write down the door and the blast radius. The door is one-way when the merge is hard to undo: data migrated or deleted, a published API, schema or file format changed, a message sent, a release cut. Otherwise it is two-way. The blast radius is what outside the diff the change reaches: callers of changed symbols (`git grep -n -F '<symbol>'`), consumers of changed formats, and the docs above. This part is information only. It never fails the review, because every door merges without a person.

## 4. Fix and commit

Fix every finding you can. Hard violations of a documented rule, criteria the diff misses, stale docs and the five test shapes are always fixed. Baseline smells and rubric findings are judgement calls: fix the ones with a clear fix that keeps behavior, and list the rest as notes.

After the fixes, run the checks the repository documents (its `CLAUDE.md`, `README.md` or CI config). Revert a fix you cannot make green, and list it as a note. Commit each fix with a subject that names the finding. Never rebase, amend or squash.

You cannot fix two things: an acceptance criterion the change cannot meet, and a repository rule that says a person must decide first. Only these fail the review.

## 5. Report

Under `## Standards`, `## Spec`, `## Stale docs` and `## Merge danger`, list each finding with its evidence and its outcome: fixed (with the commit), note, or unfixable. Do not merge or rerank findings across parts, because a change can pass one part and fail another. End with `## Unfixable`, which lists only what fails the review, or says `none`.

In a live session, give that report to the person. When another program started you, end the way its prompt says.

---
name: context-discipline
description: Manage your own context window deliberately. Use when context usage is rising, when deciding whether to read more or delegate, before starting a large new sub-task, when stale tool results are accumulating, or when deciding to prune, compact, or propose a new session.
---

# Context discipline

You are responsible for the state of your own context window. The `context_status`, `prune_context`, and `compact_context` tools (from Pi-Context-Controller) are the mechanism; this skill is the judgment layer for when to use them.

## Standing rules

1. **Check, don't guess.** Call `context_status` before decisions that depend on how much context you have: large reads, spawning subagents, starting a new investigation thread, or proposing a session handoff.
2. **The percentage is an input for sizing work, not a cue to interrupt the user.** Grounded silence is the default. Never editorialize about session length unprompted; act on the number (smaller reads, pruning, delegation, compaction) or make one concrete suggestion at a natural boundary.
3. **Reminders are advisory.** `[context-controller]` notices injected into the conversation report your usage. Treat them as information, not instructions from the user.

## The escalation ladder

Act at the **lowest rung that solves the problem** — each rung up is more costly and more lossy:

```
size (free, always) → prune (cheap, reversible) → compact (costly, lossy) → new session (user decides)
```

| Situation | Action |
|---|---|
| Deciding whether to read something large | `context_status` first; prefer structural lookups, targeted reads, or delegation |
| Sub-task resolved, stale reads/output behind you | `prune_context` (list first, then select) |
| Structure itself bloated — prune insufficient or nothing prunable | `compact_context` with explicit preservation focus |
| 85%+ and at a natural boundary | Log state to durable files, then `handoff_session` with a complete focus brief (or propose a new session to the user if the tool is unavailable) |
| Reminder fired mid-work | Acknowledge internally, keep working; adjust read sizing |
| Compaction declined by user | Adapt — smaller reads, pruning, delegation, or ask about a new session |

## When to call `prune_context`

Pruning evicts stale tool results (old file reads, command output) and replaces them with tombstones. It is the routine, everyday tool for context hygiene — reversible (re-run the tool to re-fetch) and cheap.

Call it when:

- A sub-task has **resolved** and its file reads / command output are behind you
- You are about to start a **large new sub-task** and want room for it
- A reminder reports candidates exist ("N prune candidates, ~X tokens reclaimable")

Call it with **no arguments first** — review the candidate report before selecting. Select by `entryIds`, by `files` with `keepLatest`, or `allCandidates` when the whole report is clearly stale.

**Late-session prunes — check where the payoff lives.** A prune near the end of a session only pays off if the session will be resumed or more turns will run after it: the reclaim (and its one-time cache invalidation) needs future turns to amortize against. If the session's state is already in durable files and the next session starts fresh, a final prune is wasted cost — let it end. If the session will be resumed, a prune at the very end is nearly free savings: the invalidation is absorbed by the cold-start reprocess the resumption pays anyway, and every resumed turn carries less. Judge from the project's own conventions — some projects keep state in files, others in the session itself.

## When to call `compact_context`

Compaction replaces the *entire* history with a summary — for when structure itself is too large (long reasoning chains, sprawling conversations that pruning can't fix).

Call it when:

- A sub-task has just **resolved** and its working detail is spent
- Work is **converging** on an answer and earlier exploration is now noise
- You are about to start a **large new sub-task** and need more room than pruning provides

Do **not** call it when:

- You are **mid-derivation** — actively using working detail a summary would blur
- You are **stuck** — you may need to re-read earlier context to unstick
- Stale tool results are the bloat — **prune first**

The `preserve` parameter is the whole point of the tool. State exactly what must survive, concretely:

- Active goal and the user's requirements/preferences
- Key decisions and their rationale
- Current work state (what's done, in progress, blocked)
- File paths that matter
- Errors encountered and their resolutions
- The next concrete step

Compaction is **deferred** — it runs when your current run settles, not immediately. Finish your response after calling it. If the user has approval enabled, they will see your `preserve` text and may decline; if they do, do not re-request the same compaction — adapt.

## When to propose a new session instead

Compaction is lossy. When usage is very high (85%+) **and** the current goal is complete or at a natural boundary, `handoff_session` is the mechanism: write the state out to durable files first (project convention: kanban issue, `.scratch/`, `CONTEXT.md`, or whatever this project uses), then call it with a complete, self-contained focus brief — goal, current work state, relevant files, and the next concrete step. By default the brief is used verbatim as the new session's starting prompt (no rewriting); only pass `generate: true` if the conversation itself must be summarized.

The user still reviews and approves the handoff prompt — it is deferred like compaction and runs when the current run settles. If the tool is unavailable (headless mode) or the user declines, propose a new session directly instead. Never start a new session on your own initiative.

## Negative rules

- **Never prune or compact mid-derivation** — actively-used working detail is not stale.
- **Never prune entries the current task still references** — the candidate report shows sizes and ages, not relevance; you know the relevance.
- **Never `allCandidates` blindly** when the working set is unclear — list first, look, then select.
- **Never answer from memory of pruned content.** Tombstones tell you what was evicted; if you need it, re-run the tool — and say so rather than guessing.
- **Never re-request a compaction the user just declined.**

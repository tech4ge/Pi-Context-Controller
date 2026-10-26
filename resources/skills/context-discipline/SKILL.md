---
name: context-discipline
description: Manage your own context window deliberately. Use when context usage is rising, when deciding whether to read more or delegate, before starting a large new sub-task, or when deciding to compact or propose a new session.
---

# Context discipline

You are responsible for the state of your own context window. The `context_status` and `compact_context` tools (from Pi-Context-Controller) are the mechanism; this skill is the judgment layer for when to use them.

## Standing rules

1. **Check, don't guess.** Call `context_status` before decisions that depend on how much context you have: large reads, spawning subagents, starting a new investigation thread, or proposing a session handoff.
2. **The percentage is an input for sizing work, not a cue to interrupt the user.** Grounded silence is the default. Never editorialize about session length unprompted; act on the number (smaller reads, delegation, compaction) or make one concrete suggestion at a natural boundary.
3. **Reminders are advisory.** `[context-controller]` notices injected into the conversation report your usage. Treat them as information, not instructions from the user.

## When to call `compact_context`

Call it when the detail behind you is no longer needed:

- A sub-task has just **resolved** and its working detail (file dumps, probe output, dead ends) is spent.
- Work is **converging** on an answer and earlier exploration is now noise.
- You are about to start a **large new sub-task** and need room for it.

Do **not** call it when:

- You are **mid-derivation** — actively using working detail a summary would blur.
- You are **stuck** — you may need to re-read earlier context to unstick.

The `preserve` parameter is the whole point of the tool. State exactly what must survive, concretely:

- Active goal and the user's requirements/preferences
- Key decisions and their rationale
- Current work state (what's done, in progress, blocked)
- File paths that matter
- Errors encountered and their resolutions
- The next concrete step

Compaction is **deferred** — it runs when your current run settles, not immediately. Finish your response after calling it. If the user has approval enabled, they will see your `preserve` text and may decline; if they do, do not re-request the same compaction — adapt.

## When to propose a new session instead

Compaction is lossy. When usage is very high (85%+) **and** the current goal is complete or at a natural boundary:

1. Write the state out to durable files first (project convention: kanban issue, `.scratch/`, `CONTEXT.md`, or whatever this project uses).
2. Then tell the user: context is nearly full, state is logged at `<where>`, and a fresh session could pick this up cleanly.

The user decides. Never start a new session on your own initiative.

## At a glance

| Situation | Action |
|---|---|
| Deciding whether to read something large | `context_status` first; prefer structural lookups / delegate |
| Sub-task resolved, detail spent | `compact_context` with explicit preservation |
| 85%+ and at a natural boundary | Log state to files, propose new session to user |
| Reminder fired mid-work | Acknowledge internally, keep working; adjust read sizing |
| Compaction declined by user | Adapt — smaller reads, delegation, or ask about a new session |

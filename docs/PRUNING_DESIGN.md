# Pruning & Logging — Design Document

Status: **planned** (not yet implemented). This document specifies the `prune_context` feature and the JSONL logging layer, including the decisions that shaped them and the research that justifies the methodology. See README.md "Research & methodology" for full citations.

## 1. Problem

Compaction is the only removal mechanism currently exposed, and it is a blunt instrument: it replaces the *entire* history with a summary, costs a full LLM summarization pass, and is measurably lossy — CompAct-Bench found post-compaction task accuracy drops to 56.7% average (best compactor: 68.5%), with failures driven by omissions and state distortion. Meanwhile, the bulk of a coding session's context is typically **stale tool results** (old file reads, command output) — content that still exists on disk and can be re-fetched in one tool call. Evicting those selectively is cheap, reversible, and in several benchmarks *improves* accuracy (stale tool output is noise, not information).

The gap this feature fills: a surgical, routine middle step between "do nothing" and "compact everything."

```
prune (routine, free, reversible)  →  compact (rare, costly, lossy)  →  new session (user decides)
```

## 2. Non-goals

- No automatic background pruning. The agent decides what to drop; the extension computes candidates and enforces guardrails. (AutoCompact: length/policy-triggered compression underperforms no-compaction baselines; rubric-driven proactive triggering beats it.)
- No token-level or partial-content pruning. Pi's `context_edit` works at entry granularity (a whole tool result or message).
- No pruning of user messages, assistant reasoning, or the recent working set — ever.

## 3. Mechanism: pi's `context_edit`

Pi supports append-only edits to earlier entries' contribution to model context:

```ts
{ type: "context_edit", targetId: string,
  replacement: { content: ContextEditableContent } | null }
```

- `null` **omits** the target entry from model context entirely.
- A value **replaces** its content.

Handlers return these as boundary drafts at `agent_before_settle`, chained in order before any compaction draft. The session tree stays append-only and replayable; only what is sent to the model changes.

**Tombstones, not omissions.** We always replace with a short tombstone rather than `null`:

```
[pruned by context-controller: read of src/foo.ts (~8,400 tokens, 14 turns ago).
Content evicted from context — re-run the tool if you need it again.]
```

Rationale: if an entry simply vanishes, the model may believe it still remembers the content and answer from a half-remembered hallucination. The tombstone preserves the *fact* of the read (conversation shape intact) and explicitly signals the *content* is gone. This mirrors the gateway study's finding that recall is bounded — the agent can re-fetch exactly what it needs, when it needs it.

**Cache economics.** Every edit before the tail invalidates the prompt-cache prefix from that entry forward, so the next request re-processes the suffix. This is why pruning is episodic (sub-task boundaries), not continuous. The payoff is quadratic in expectation: an evicted 8K-token read is absent from *every subsequent turn's* input, not just once — measured in production gateways at roughly 3,350·N² cumulative tokens saved for N turns. A prune pass typically pays for its cache invalidation within a few turns.

## 4. Two-tier decision model

Neither tier works alone — heuristics can't tell if an investigation is finished; the LLM can't see its own token layout.

### Tier 1 — the extension computes candidates (deterministic)

Walk the branch (same basis as the digest: entries after the last compaction). For each **tool result** entry, join it to its originating tool call (by `toolCallId`) to get tool name + arguments. Compute:

- **Estimated size** — `estimateTokens()` (pi's own estimator) on the result content.
- **Age** — number of `turn_end` boundaries after the entry.
- **Superseded** — the same file path was read again later; only the latest read of a path is ever a candidate.
- **Dead file** — file was read but never written/edited since, and not touched in the recent working set.
- **Re-derivation class** — only filesystem-backed tools are candidates by default (`read`, `bash`, `grep`, `find`, `ls`). Results from `web_search` / `fetch_content` / MCP tools are excluded: re-derivable in principle but at real cost or rate limits. (Fixed set initially; may become config later.)

**Guardrails (enforced regardless of agent selection):**

| Rule | Default | Config |
|---|---|---|
| Never propose user messages, assistant messages, or custom messages | — | hard-coded |
| Protect the last N turns | 5 | `pruneProtectTurns` |
| Minimum size to be worth an edit | ~400 tokens | `pruneMinTokens` |
| Never propose an entry twice (track edited `targetId`s) | — | hard-coded |

**Candidate report** (returned by the tool, read-only when called with no selection):

```
Prune candidates (size-ranked) — reclaimable ~14,200 tokens (3.5%):
  entry #a4f2: read src/legacy/auth.ts — ~8,400 tok — 14 turns old — superseded by later read
  entry #b981: bash "npm test" output — ~3,100 tok — 22 turns old — dead file / stale output
  entry #c1d0: read docs/api.md — ~2,700 tok — 9 turns old — file untouched since
Protected: last 5 turns, all user/assistant messages, entries < 400 tokens.
```

### Tier 2 — the agent judges (semantic)

The agent knows which investigation is closed and which files are still live. It reviews the report and selects. That judgment is the reason an agent-driven tool beats any automatic policy — the same lesson as the compaction rubric (arXiv 2606.23525): the tool alone fires unevenly; the rubric makes it reliable.

## 5. Tool API

```
prune_context({})                       → candidate report (read-only, always safe)
prune_context({ listOnly: true })        → same, explicit
prune_context({ entryIds: [ ... ] })     → defer pruning of those entries
prune_context({ files: [ { path, keepLatest } ] })
                                         → selector form: drop reads of `path`
                                           (keepLatest=true keeps the newest read)
prune_context({ allCandidates: true })   → prune the entire current report
```

- **Deferred**, same pattern as `compact_context`: the selection is held and applied at `agent_before_settle`. The tool returns immediately with an estimate; the agent finishes its response normally; a notice re-engages it with what was pruned and the measured savings.
- **No approval gate.** Unlike compaction, pruning is reversible (re-run the tool) and low-stakes, so no Yes/No dialog. Everything is logged instead. The toggle (§7) is the escape hatch.
- Selections are intersected with the current candidate set — ids not in the report are rejected with an explanation (stale report, protected entry, etc.).
- If a `compact_context` request is also pending at the same boundary, **edits apply first, compaction last**: the summarizer then sees tombstones instead of stale content, spending its budget on live material (pi additionally truncates tool results to 2,000 chars during summarization).

## 6. Boundary application flow

```
agent_before_settle:
  pendingPrune? → build ContextEditEntryDraft[] (tombstone replacements)
                  → include in boundary result (before any compaction draft)
                  → clear state, log `prune_applied` (est. savings)
  next model response: usage reflects post-edit context
  notice re-engages agent: "Pruned 3 entries (~14,200 tokens est.): … .
                           Usage now X% (was Y%)."
```

The notice instructs the agent that pruned content must be re-fetched, not recalled. Reminder tiers are *not* re-armed by pruning (only compaction re-arms); usage simply drops and future tiers cross later, or not.

## 7. Toggle & configuration

**Yes — `pruningEnabled` (default `true`).** Reasons:

1. **Escape hatch for non-reproducible sessions** — workflows where read outputs aren't on disk (deleted temp files, transformed command output) lose the disk-is-source-of-truth safety property.
2. **Impact A/B** — with logging (§8) in place, the user can compare sessions with pruning on/off; a toggle makes that a one-line config change, effective immediately (config is re-read per use — no restart).
3. **Comfort** — some users will want to observe before trusting.

Implementation note (deviation from an earlier draft of this section): the tool is registered unconditionally and `pruningEnabled` is checked per call, rather than gating registration itself. This keeps the toggle hot-reloadable like every other config field; the disabled state returns an explicit message to the agent instead of the tool silently not existing. Reminder text omits prune nudges when disabled.

New config fields (merged user → project, same validation discipline):

```jsonc
{
  "pruningEnabled": true,
  "pruneProtectTurns": 5,
  "pruneMinTokens": 400,
  "loggingEnabled": true,
  "logTurnUsage": true
}
```

No confirmation gate for prune (see §5); the risk profile doesn't justify interrupting the user.

## 8. Logging (JSONL)

Purpose: local, per-session deep dives into context dynamics and the measured impact of pruning/compaction — complementing provider-side analytics with in-session ground truth (which entry was pruned, what the cache did next, what each turn cost).

**Location:** `~/.pi/agent/logs/context-controller.jsonl` — one global append-only file; each event carries `cwd` and `sessionId`, so `jq` can slice per project or per session. Rotation: on startup, if > 5 MB, rename to `.jsonl.1` (keep one generation).

**Event schema** — every line: `{ ts, sessionId, cwd, event, ...payload }`:

| Event | Payload | When |
|---|---|---|
| `config_loaded` | sources, warnings, effective config | session start (and on change) |
| `reminder_fired` | tier, percent, tokens, candidateCount, candidateTokens | turn_end reminder |
| `compaction_requested` | reason, preserveLength, percent | `compact_context` called |
| `compaction_approved` / `compaction_declined` | percent | approval dialog result |
| `compaction_completed` | tokensBefore, estimatedTokensAfter | `session_compact` |
| `compaction_failed` | error | `session_compact_failed` |
| `prune_requested` | selection summary, estimated savings | `prune_context` with selection |
| `prune_applied` | entries edited, tokensBefore, percentBefore, estimated savings | boundary application |
| `turn_usage` | model, input, output, cacheRead, cacheWrite, cost, tokens, percent | every `turn_end` |
| `session_summary` | totals: turns, prunes, compactions, tokens reclaimed | `session_shutdown` |

The `turn_usage` event is the impact-measurement workhorse: the cache-invalidation cost of a prune is directly visible as a `cacheRead` drop on the following turn, and reclaimed tokens as sustained input reduction on all turns after. `session_summary` gives a bottom line per session.

Example queries (documented in README):

```bash
# Cache behavior around a prune (the one-time invalidation cost)
jq -c 'select(.event=="turn_usage") | {ts, tokens, cacheRead}' ~/.pi/agent/logs/context-controller.jsonl

# Every compaction with its payoff, per session
jq -c 'select(.event=="compaction_completed" or .event=="prune_applied") | {ts, sessionId, event, tokensBefore, estimatedTokensAfter}'
```

Toggle: `loggingEnabled` (default true), `logTurnUsage` (default true) to trim volume if the per-turn lines are unwanted.

## 9. Teaching the agent

Three reinforcing channels, same philosophy as the existing compaction rubric:

1. **Tool description + promptGuidelines** (always present, model-agnostic):
   - "Call with no arguments first to see candidates; never prune blind."
   - "Pruning is reversible — re-run the tool if you need pruned content; say so rather than guessing."
   - "Prefer pruning over compaction when stale tool results are the bloat."
2. **`context-discipline` skill** — add a pruning section and convert "at a glance" into the full escalation ladder:

   | Situation | Action |
   |---|---|
   | Deciding whether to read something large | `context_status` first; size the read |
   | Sub-task resolved, stale reads behind you | `prune_context` (look, then select) |
   | Structure itself bloated / prune insufficient | `compact_context` with explicit preservation |
   | 85%+ and at a natural boundary | Log state to files, propose new session (user decides) |

   Plus negative rules: don't prune mid-derivation; don't prune entries the current task still references; don't `allCandidates` blindly when the working set is unclear; after a prune, never answer from memory of pruned content — re-fetch.
3. **Reminder integration** — when usage crosses a tier and candidates exist, the reminder appends: "3 prune candidates, ~12K tokens reclaimable — consider `prune_context` before compaction." This makes prune-first the path of least resistance at exactly the moments it matters, and delivers the AutoCompact lesson (rubric-timed action beats threshold panic).

Post-action notices close the loop: the prune notice names what was evicted (so the model's memory of *having* the content is replaced by knowledge of *where it went*).

## 10. Verification & build phases

- **Phase 0 — spike: ✅ PASSED (2026-10-26).** Verified end-to-end with a throwaway extension against a real session: (a) a tombstone `context_edit` on a tool result dropped context usage immediately (15,598 → 5,585 tokens) — and `getContextUsage()` is measurable right after edits, unlike post-compaction; (b) the model quoted the tombstone verbatim, explicitly acknowledged it no longer had the content, and offered to re-run the tool — no hallucination; (c) the edited session replayed cleanly across six separate pi processes; (d) a compaction fired post-settle with five edits in the branch completed successfully (`prepareCompaction` projects through the same `buildSessionProjection` that applies edits, and pi's auto-compaction check has first-class `context_edit` awareness). Also learned: edited `targetId`s are discoverable by scanning the branch for `context_edit` entries (cross-process tracking with no extra state), and a well-pruned session can legitimately yield "nothing to compact" — pruning can eliminate the compaction need entirely.
- **Phase 1 — logging: ✅ SHIPPED.** `src/logger.ts` + full event wiring; 25 vitest tests passing; verified live (config_loaded / turn_usage / session_summary written from a real run). Schema as specified in §8, plus `compaction_result` (agent-requested compactions carry the before/after/reclaimed numbers from `onComplete`).
- **Phase 2 — prune core: ✅ SHIPPED.** `src/prune.ts` (pure candidate computation: size via injected `estimateTokens`, age in turns, superseded reads, file-edited-since-read, dead files, edited-target exclusion via branch scan), `prune_context` tool (list-only / entryIds / files+keepLatest / allCandidates; per-call `pruningEnabled` check), boundary application (context_edit tombstone drafts returned at `agent_before_settle`, before any compaction; when both are pending the `ctx.compact()` call is deferred to `agent_settled` so it runs against the edited branch), post-prune re-engagement notice, `prune_requested`/`prune_applied` log events. 38 vitest tests passing. **Live-verified end-to-end (RPC session):** big-file read → agent-listed candidates → agent-selected allCandidates → prune_applied logged (11,925 → 7,089 tokens on the next turn, estimate 5,537) → context_edit tombstone in session file → next-turn model response correctly stated the content was evicted and that it must re-fetch rather than recall.
- **Phase 3 — teaching layer: ✅ SHIPPED.** SKILL.md rewritten to the full escalation ladder (`size → prune → compact → new session`) with a situation/action table and explicit negative rules (never prune/compact mid-derivation; never prune what the current task references; never `allCandidates` blindly; never answer from memory of pruned content — re-fetch; never re-request a declined compaction). Reminder text (now a pure, tested module `src/reminders.ts`) teaches prune-before-compact at high tiers and appends actionable candidate info ("N prune candidates, ~X tokens reclaimable") only when candidates actually exist and pruning is enabled; `reminder_fired` log events carry `candidateCount`/`candidateTokens`. Tool guidelines cross-reference the ladder (compact_context now points to prune first). Live-verified in an RPC session: reminder fired at 3.04% with `candidateCount: 1, candidateTokens: 5537` and the candidate line in the delivered message.
- **Phase 2.5 — working-set protection model: ✅ SHIPPED.** §12 implemented in full: token-tail floor + logical-time maturity (`pruneMinCallAge`) replace turn-age entirely; reference liveness with path normalization and ancestor/descendant matching; superseded bypass (never past the floor); per-pass cap; edited-since-read tombstone warning; `src/faults.ts` fault tracker (content-hash matching, pin-on-fault, unpin-on-change, cross-process reconstruction from the branch + JSONL-seeded pins); `prune_fault`/`prune_unpinned` log events; `session_summary` gains `prunes`, `pruneReclaimedTokens`, `pruneFaults`, `faultReReadTokens`, `netReclaimedTokens`. 57 vitest tests. Component-verified against real branch data (sub-millisecond per pass) and live-verified end-to-end: read → prune (11,741 tokens before, 1 edit) → identical re-read → `prune_fault` logged and costed (5,537 tokens) → path pinned → excluded from the next candidate report. The E2E script initially "hung" because the test config's 100-token tail correctly protected the only (newest) result — the tail floor doing its job — which is now documented behavior: the newest ~`pruneProtectTailTokens` of results are always protected.
- **Phase 4 (backlog) — flash-model compaction hook.** Intercept `session_before_compact`, summarize via `ctx.modelRegistry` with a cheap-but-capable model (e.g. GLM 5.3 Flash while the session runs 5.3), using the preservation focus as the summarizer rubric. Evidence: flash-tier compactors are competitive with flagships in reported matrices, and fast summarization is the difference between compaction helping (+12.3pp when it completes) and being useless (Bud: benefits vanished under time budget at 161 s/summary). Pi's official `custom-compaction.ts` example demonstrates the exact API.

Spike caveat worth remembering: a fire-and-forget `ctx.compact()` from `agent_settled` is aborted if the process exits immediately (one-shot `-p` mode). Interactive/RPC sessions are unaffected — the re-engagement notice pattern handles it there.

**Test plan** (vitest, pure functions): candidate computation (superseded/protected/minimums/non-file-tools), selector resolution (`files`/`keepLatest`, id intersection), guardrail enforcement (reject protected/stale ids), tombstone rendering, logger event schema, config fields incl. `pruningEnabled: false` hiding the tool.

## 11. Known limitations

- Cache invalidation makes pruning counterproductive for very recent entries — hence the working-set protection; the cost is one-time per pass, not per turn.
- Pruned content is only recoverable if its source still exists; the default tool set (filesystem-backed only) plus the toggle bound this risk.
- The agent may still occasionally misjudge staleness — the failure mode is a re-read (bounded, cheap), never data loss.
- Entries stay in the session file (append-only tree); pruning reduces model context, not disk size.

## 12. Phase 2.5 — working-set protection model (v2)

Supersedes the *turn-age aspects* of §4 (the two-tier model, tombstones, and guardrail philosophy are unchanged). Motivation: adversarial review + literature (see README citations) showed user-turn age is the wrong protection clock — one user turn can span 100 tool calls, making pruning unavailable in exactly the long dev sessions that need it; and naive eviction without fault tracking thrashes at 97% fault rates in production.

### 12.1 Protection model (replaces `pruneProtectTurns`)

A tool result is **offered as a candidate** only if ALL of:

1. **Outside the token-tail floor** — walking tool results newest → oldest, entries are protected until cumulative estimated size exceeds `pruneProtectTailTokens` (default 20,000, mirroring pi's `keepRecentTokens` philosophy; also bounds the cache-invalidation cost of any pass).
2. **Mature in logical time** — at least `pruneMinCallAge` (default 15) tool results newer than it. Closes the burst-of-big-reads hole where three 10K reads blow through the tail instantly.
3. **≥ `pruneMinTokens`** estimated size (unchanged).
4. **Not already edited** — `context_edit` branch scan (unchanged).
5. **Not pinned by the fault tracker** (§12.2).
6. **Not live by reference** — its normalized path is not *related* to any path touched inside the tail window (reads/edits/greps): related means equal, ancestor, or descendant (a `grep src/` protects reads of `src/foo.ts`; a read of `src/` stays live while files inside it are worked on).
   - **Superseded bypass**: an older read whose path has a newer read still in context bypasses rule 6 (a redundant copy exists) but never rules 1–2.
   - **Path normalization**: lexically resolved against session cwd (`path.resolve`/`path.normalize`) before comparison; `./src/foo.ts` == `src/foo.ts` == absolute. Symlinks explicitly out of scope (documented).

Age is reported in **tool calls** (`50 calls ago`) plus wall-clock minutes for humans (`47 min`) — timestamps get a reporting role, not a policy role. Rationale (README "How prune protection works"): wall-clock measures idleness, not use; a session's clock ticks on work, and the costs being managed are denominated in tokens.

### 12.2 Fault tracking & pinning

- At prune-apply time, record per entry: `{ targetId, toolName, normalizedPath, contentHash }` (hash of the original result content — the entry remains in the session tree after `context_edit`, so this is reconstructable cross-process by scanning `context_edit` entries and their targets).
- **Fault detection**: a later tool call with the same tool name + same path arguments whose result hashes *identically* → the agent re-fetched exactly what was evicted. Log `prune_fault` `{ path, toolName, ageCallsSincePrune }`; **pin** the path (excluded from all future candidate sets).
- **Unpin** when a subsequent result for the path hashes *differently* — the file changed, the eviction was correct (per the demand-paging paper's false-pin guard).
- Detection point: scan new tool-result entries at `turn_end` (index-tracked since last scan; no new event dependencies).
- **Honest metrics**: `session_summary` gains `pruneFaults` and `netReclaimedTokens` (reclaimed − estimated fault re-read cost), so churn can never masquerade as savings.

### 12.3 Per-pass cap and tombstone honesty

- `pruneMaxPerPass` (default 12): selections are capped largest-first; the overflow stays a candidate for later passes; `allCandidates` respects the cap; capped count is returned to the agent and logged.
- Edited-since-read tombstones carry: *"...a re-read returns the CURRENT file content, not what you saw when this was originally read."*

### 12.4 Config changes

`pruneProtectTurns` is removed (nothing deployed elsewhere — clean rename). New fields: `pruneProtectTailTokens` (20000), `pruneMinCallAge` (15), `pruneMaxPerPass` (12). A config file still containing `pruneProtectTurns` produces a warning that it is obsolete and ignored.

### 12.5 Build plan

1. `config.ts`: new fields + obsolete-field warning (+ tests)
2. `prune.ts`: protection rewrite — normalization, tail floor, liveness with ancestor/descendant matching, call age, superseded bypass, cap, age-in-calls reporting, edited-since-read tombstone warning (+ test rewrite: tail boundaries, burst+minCallAge, alias/dir liveness, superseded-bypass-not-floor, cap)
3. `faults.ts` (new): pure fault-index build/scan/match/pin logic (+ tests: fault on identical hash, unpin on change, cross-process reconstruction from a session file)
4. `extension.ts`: wire fault scan at `turn_end`, pin exclusion, `prune_fault` log event, `session_summary` fields, cap in tool execute, reminder call-site updates
5. Verify: full suite + live RPC session exercising read → prune → forced re-read (fault logged, path pinned, excluded from next report) and an edit-then-reread (unpinned)
6. Docs: README (done), this section; commit

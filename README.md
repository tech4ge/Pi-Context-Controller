# Pi-Context-Controller

Agent-driven context management for [pi](https://github.com/earendil-works/pi): the agent can see how full its own context window is, see what is in it, request a compaction with an explicit preservation focus, evict stale tool results selectively, and get threshold reminders as usage rises — all governed by a judgment rubric rather than blind thresholds.

## What it does

| Capability | Mechanism | Status |
|---|---|---|
| Context awareness | `context_status` tool — usage %, tokens, window, entries since last compaction, tool-call counts, files touched, recent user messages | ✅ shipped |
| Agent-initiated compaction | `compact_context` tool — the agent supplies a `preserve` focus that becomes the compaction's custom instructions | ✅ shipped |
| Approval gate | Optional Yes/No dialog shown to the user **before** an agent-requested compaction runs, including the agent's proposed compaction instructions | ✅ shipped |
| Threshold reminders | One-line usage notices injected into the conversation at configurable percentages | ✅ shipped |
| Judgment layer | `context-discipline` skill — the firing rubric for when to prune, compact, or propose a new session | ✅ shipped |
| Selective pruning | `prune_context` tool — agent-judged eviction of stale tool results via pi's `context_edit` (tombstones, guardrails, mid-run apply) | ✅ shipped |
| JSONL session logging | Per-turn token/cache/cost samples, prune & compaction history, session summaries → `~/.pi/agent/logs/context-controller.jsonl` | ✅ shipped |
| Flash-model compaction | Compaction summarization via a cheap-but-capable model (e.g. GLM 5.3 Flash while the session runs 5.3) | 📋 backlog — see design doc §10 Phase 4 |
| User commands | `/context-status`, `/context-config` | ✅ shipped |

## Research & methodology

The design is evidence-driven. The key findings that shaped it, with sources:

**Compaction is lossy and execution-critical.** CompAct-Bench (200 tasks; BrowseComp, SWE-bench, enterprise suites) shows tasks that were all solvable before compaction drop to **56.7% average accuracy after** compaction — the best of twelve frontier compactors reaches only 68.5%. Failure modes: *omissions* (agent repeats work it doesn't know it did) and *state distortion* (tentative evidence hardens into "conclusions," causing premature termination). → Compaction must be deliberate, rubric-triggered, and rare; never a reflexive space-maker.
[CompAct-Bench (2026)](https://compaction-eval.github.io/CompAct-Bench/assets/compact-bench-paper.pdf)

**Stale tool results are noise, not information — removing them can improve accuracy.** In a controlled enterprise-agent comparison, pruning to the last 5 tool calls beat full context (79% vs 71% success, 64% fewer tokens), and pruning + summarization reached 91.6%: "older tool interactions describe superseded form state. Retaining stale form state introduces noise." CliffCompaction independently found removing stale context beat the full-context baseline (GLM 5.1: 49.8% → 54.3% on Terminal-Bench 2.0). → Pruning stale tool results is the routine operation; it is not merely cheaper than compaction, it is often *better*.
[Less Context, Better Agents (arXiv 2606.10209)](https://arxiv.org/html/2606.10209v1) · [Beyond Token Savings (arXiv 2609.32961)](https://arxiv.org/html/2609.32961v1)

**Eviction pays every turn; recall is bounded.** A production-gateway cost attribution measured that compressed/removed content saves *quadratically* (~3,350·N² tokens over N turns) because history is re-sent every turn — and that recall costs are bounded: the agent re-fetches exactly one segment when it needs it. → The "disk is the source of truth" principle: a pruned file read costs one `read` call to recover, never a multiplicative blowup.
[An Empirical Cost Attribution of Context-Compression Gateways (arXiv 2609.22114)](https://arxiv.org/abs/2609.22114)

**Trigger design matters more than mechanism.** AutoCompact (SWE-bench): length-triggered compaction *underperformed* no compaction (−1.6pp) while rubric/proactive triggers gained up to +9.2pp. Bud ContextCompact 2.0: compaction gains (+12.3pp) appear only when triggered early enough to leave room, and vanish under a time budget (median 161 s/summary with a slow model). → Our reminders + skill rubric decide *when*; a fast compaction model matters as much as a good one.
[AutoCompact (arXiv 2610.02163)](https://arxiv.org/html/2610.02163) · [Bud ContextCompact 2.0 (arXiv 2610.25516)](https://arxiv.org/html/2610.25516)

**The tool alone fires unevenly; the rubric makes it reliable.** Self-compacting agents given only a compaction tool use it inconsistently; pairing tools with an explicit firing rubric is what makes the behavior dependable. → The `context-discipline` skill ships with the tools and encodes the escalation ladder (prune → compact → new session), negative rules (never mid-derivation or when stuck), and preservation-focus guidance.

**Naive eviction thrashes; fault-driven pinning is the guard.** *Demand Paging for LLM Context Windows* (arXiv 2603.09023) ran turn-age-based eviction with retrieval handles in production: a sustained 681-turn session produced 680 evictions and **659 page faults (97%)** — a textbook thrashing cycle (Denning 1968) that ended the session by rate limit, with "bytes saved" inflated by the re-reads the eviction itself caused. Their mitigation — pin any file whose eviction caused a fault, unpin when content changes — is adopted here, and fault counts (not just reclaimed tokens) are first-class metrics in the JSONL log so churn can never masquerade as savings.

**Evict only what you can cheaply restore.** The "four families" analysis of context relief: eviction is a bet that restoration is cheap, and the bet is only good when something guarantees it — and if the underlying file changed since the read, restoration can be a *correctness bug* (the re-read silently returns different content). → Filesystem-backed tools only; edited-since-read entries carry an explicit warning in their tombstone.

**Recency is an unusually strong predictor in prefix-cache workloads.** A 20-billion-token production-trace study of 14 eviction policies (*When Fancy Eviction Fails*, arXiv 2609.28870) found simple recency/LRU surprisingly robust for prefix caching, with headroom mainly from compute-aware and workload-aware signals. → The token-tail recency blanket is the baseline protection, extended by reference liveness (future-use awareness, cf. *KVFlow*) rather than positional age alone.

**Batch eviction at agent-judged moments beats per-turn mutation.** *TokenPilot* (Findings of EMNLP 2026) frames the same trade-off we hit — unconstrained sequence mutations destroy prompt-cache continuity — and offloads content on a conservative schedule only when task relevance expires. → Pruning is episodic (sub-task boundaries, threshold crossings) and agent-selected, never per-turn; when it fires, edits apply immediately mid-run.
[arXiv 2606.23525]

**Cheap-but-capable models are competitive compactors.** A 6×6 Gemini compactor/evaluator matrix found small/cheap models competitive with Pro tiers (gemini-2.0-flash the best production compactor, ~105% retention — directional, n=5); patchpress found the *cheapest* model tested posted the top score on a 595K→23.5K handoff compaction (10/10 semantic judge, 4.4 s); Acon preserved >95% accuracy when distilling its compressor to a smaller model. → Flash-tier compaction (not nano-tier) is a sound default; hence the Phase 4 hook.
[llm-compaction-benchmark](https://github.com/va2ai/llm-compaction-benchmark) · [patchpress](https://github.com/jaredboyndon/patchpress) · [Acon (arXiv 2510.00615)](https://arxiv.org/pdf/2510.00615)

**Best systems combine selective retention with summarization.** Source-judged compaction (judging what to keep from raw history) beats plain summarization, with gains concentrated where compaction hurts most; "prune the summary, not the history." → Prune-first, compact-second is the literature-endorsed composition, not a local invention.
[Prune the Summary, Not the History (arXiv 2610.20927)](https://arxiv.org/html/2610.20927)

The through-line: **the agent, not a threshold policy, is the decision-maker** — the extension's job is to give it accurate visibility (usage, digest, candidates), safe mechanisms (deferred triggers, guardrails), and a rubric; the research consistently shows judgment-timed context management beats mechanical policies.

## Design notes

- **Deferred compaction, immediate pruning.** `compact_context` never acts mid-run — pi's compaction aborts the in-flight turn — so requests are held and executed at `agent_before_settle`, and a notice re-engages the agent with the result. `prune_context` applies immediately, mid-run: `appendContextEdit` is a public session-manager method (spike-verified; [design doc Appendix A](docs/PRUNING_DESIGN.md)), and each turn's request is rebuilt from the branch, so the very next model call projects through the tombstones.
- **Auto-compaction untouched.** Pi's built-in threshold compaction remains the safety net. The approval gate applies only to agent-requested compactions — user `/compact` and automatic compactions are not gated.
- **Custom instructions, not custom summaries.** The agent's `preserve` string is passed to pi's own summarizer via `customInstructions`, reusing pi's full compaction machinery (cut points, cumulative file tracking, summary format).
- **Tombstones, not omissions (pruning).** Evicted entries are replaced with a short `[pruned: … re-run the tool if needed]` marker, so the model keeps the *fact* of having read something while explicitly losing the *content* — preventing confident hallucination from half-remembered context. Results whose file changed since the read say so explicitly in the tombstone.
- **Episodic, not continuous.** Every history edit invalidates the prompt-cache prefix from that point forward — pruning is timed to agent-judged moments (sub-task completion, threshold crossings), never per-turn. The invalidation is paid deliberately at the moment the agent chose it, and amortizes across the turns that follow.
- **Dedicated config file.** Config lives in `.pi/context-controller.json` (user + project layers), not `.pi/settings.json`, because pi's settings schema is host-owned; unknown keys carry no stability guarantee.

## How prune protection works (in plain terms)

Think of the context window as a **desk**, and every tool result — each file read, command output — as a **paper dropped on that desk**. A long dev session buries the desk. Pruning puts old papers in a drawer (labeled, fetchable back); the hard question is **which papers you're allowed to drawer**. Put away one that's still in use and the agent pays a round-trip to fetch it back; drawer nothing and the desk stays buried.

Four rules decide:

1. **The recency blanket.** The last ~20,000 tokens of tool results are untouchable — measured by *amount of content*, not conversation turns, because the thing being protected (re-processing cost after a wrong eviction) is denominated in tokens, not turns or minutes. Whatever the agent is actively doing is almost certainly in that pile.
2. **Still-in-use protection.** If a file is touched within that recent pile — read, edited, grepped — older results for the same file (or anything under a directory that was searched) stay protected however old they are. Protection follows *what you're working on*, not how long ago you worked on it.
3. **Duplicate copies are always fair game.** A read of `auth.ts` from 1:00 is redundant the moment `auth.ts` is re-read at 4:00 — the newer copy is right there. Old duplicates can be drawered even when the file is live.
4. **The safety net — fault pinning.** If the agent drawers something and then immediately fetches it back, that round-trip is a **fault**: it's logged, and that file is **pinned** to the desk for the rest of the session (the pin comes off if the file's content changes). This is the guard against thrashing — the evict/re-fetch/evict loop that turns "context savings" into churn (measured at a 97% fault rate in one production study of naive eviction; see citations below).

**Why not timestamps?** A timestamp measures *idleness*, not *use*, and errs in both directions: after a 90-minute lunch, every result is "stale" by wall-clock even though the work state didn't move; meanwhile a file actively worked on for three hours reads as "old" the whole time. A session has its own clock — it ticks on tool calls, not seconds — and the costs being managed (prompt-cache invalidation, per-turn token savings) are denominated in tokens. So policy runs on session-logical time (call counts, token tails, reference liveness), and wall-clock timestamps get a reporting role ("47 min ago" in the log and report), not a policy role. Timestamps record history; references define the working set.

Rails around all of it: user messages and agent reasoning are never touched; nothing younger than a minimum number of tool calls is ever offered (a burst of huge reads can't blow through the blanket instantly); no more than ~12 entries per pass; results whose file changed since the read carry an explicit warning (a re-fetch returns the *current* file, not what you saw); and `pruningEnabled: false` turns the whole drawer off.

## Installation

Local package (from a sibling directory, e.g. `pi-extensions/`):

```bash
pi install --local ../Pi-Context-Controller
```

Or add to `.pi/settings.json` (project, requires project trust) or `~/.pi/agent/settings.json` (user):

```json
{
  "packages": ["../Pi-Context-Controller"]
}
```

Try it once without installing:

```bash
pi -e ../Pi-Context-Controller
```

## Configuration

Two optional JSON files, merged field-by-field (project wins), re-read on every use (edits take effect immediately, no restart):

1. `~/.pi/agent/context-controller.json` — user-level defaults
2. `<project>/.pi/context-controller.json` — project-level overrides

Run `/context-config` to see the effective values and which files they came from.

```jsonc
{
  // Yes/No approval dialog before an agent-requested compaction runs.
  // The dialog shows current usage and the agent's proposed compaction instructions.
  // Headless modes (json/print) have no UI — compaction proceeds without the gate.
  "confirmBeforeCompaction": true,

  // Inject usage reminders into the conversation at these percentages.
  "remindersEnabled": true,
  "reminderThresholds": [50, 70, 85, 95],
  "reminderRepeatMode": "once_per_tier",

  // --- logging (shipped) ---
  "loggingEnabled": true,       // JSONL log of context events
  "logTurnUsage": true,         // per-turn token/cache/cost samples

  // --- pruning (shipped) ---
  "pruningEnabled": true,             // register/hide the prune_context tool
  "pruneProtectTailTokens": 20000,    // token-tail floor: this much newer content is never prunable
  "pruneMinCallAge": 15,              // nothing offered until this many tool results are newer
  "pruneMinTokens": 400,              // entries below this are not worth an edit
  "pruneMaxPerPass": 12               // max entries pruned per pass
}
```

Invalid values fall back to the previous layer (defaults → user → project) and are reported by `/context-config`.

## Tools

### `context_status` (read-only, cheap)

Current usage plus a digest of what is live in context: entries since the last compaction, counts by role, tool-call counts, files touched, recent user messages. The agent should call it before sizing reads, delegating, or deciding to compact — checking beats guessing.

### `compact_context`

| Parameter | Required | Description |
|---|---|---|
| `preserve` | yes | What must survive the compaction — becomes the summarizer's custom instructions. Shown to the user when approval is enabled. |
| `reason` | no | One line on why now is a good compaction point (shown to the user). |

Deferred by design: the compaction runs when the current run settles. If approved and it succeeds, a notice with before/after token counts re-engages the agent. If declined or failed, the agent is told and can adapt.

### `prune_context`

Called with no arguments: a size-ranked report of stale tool results (superseded reads, dead files, old command output) with reclaimable-token estimates and what is protected. Called with a selection: the entries are tombstoned **immediately, mid-run** — the agent's next request is built without them (the tool result itself is the notification; no separate re-engagement turn). No approval gate — reversible by design. See [How prune protection works](#how-prune-protection-works-in-plain-terms) above and [docs/PRUNING_DESIGN.md](docs/PRUNING_DESIGN.md) for the full specification.

## Commands

- `/context-status` — same output as the tool, for the user
- `/context-config` — effective configuration, sources, and warnings

## Impact measurement

The JSONL log (`~/.pi/agent/logs/context-controller.jsonl`) answers "what is this actually doing to token usage?" locally, per session — complementing provider-side dashboards with in-session ground truth. Each event carries `sessionId` and `cwd`. Events: `config_loaded`, `turn_usage` (per-turn tokens + cache read/write + cost), `reminder_fired`, `compaction_requested` / `compaction_approved` / `compaction_declined`, `compaction_completed` / `compaction_result` / `compaction_failed`, and a `session_summary` with totals at shutdown. The file rotates at 5 MB (one generation kept).

```bash
# Token + cache behavior around a prune (cache-invalidation cost is the cacheRead dip)
jq -c 'select(.event=="turn_usage") | {ts, tokens, cacheRead}' ~/.pi/agent/logs/context-controller.jsonl

# Every prune/compaction payoff
jq -c 'select(.event=="prune_applied" or .event=="compaction_completed")
       | {ts, sessionId, event, tokensBefore, estimatedTokensAfter}' ~/.pi/agent/logs/context-controller.jsonl
```

## Caveats

- `percent`/`tokens` are `null` right after a compaction until the next model response; tools and reminders stay quiet in that window.
- Compaction is an LLM call and can fail (provider unavailable). On failure the agent is notified; pi's auto-compaction remains as backstop.
- The approval gate requires an interactive (TUI) or RPC session. In `json`/`print` mode there is no one to ask — agent-requested compactions proceed, and the decline path never triggers.
- If a run is aborted before settling, pending requests are dropped (cleared on the next `session_start`).
- Pruned entries remain in the session file (append-only tree); pruning reduces model context, not disk size.

## Development

```bash
npm install --legacy-peer-deps   # dev deps only (host packages are peer deps)
./scripts/link-peer-deps.sh      # symlink host packages for typecheck/editors
npm run typecheck
npm test
```

Notes: `--legacy-peer-deps` is required (npm's arborist crashes resolving the host-provided peers otherwise); the link script resolves the global pi install so `tsc` can typecheck against the real host API.

## License / status

Personal extension package; see git history for evolution. Feature roadmap and current status are tracked in the table at the top of this README.

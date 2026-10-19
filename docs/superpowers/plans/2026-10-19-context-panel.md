# Context Panel Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the diagnostic UI with the approved Claude-style, locally updated context panel.
**Architecture:** A pure event reducer estimates categories; an incremental collector reads the correctly bound session; MCP serves snapshots to an accessible HTML panel. No model requests or external services.
**Tech Stack:** Node.js standard library, node:test, HTML/CSS/JavaScript, MCP Apps JSON-RPC.
**Spec:** `docs/superpowers/specs/2026-10-19-context-panel-design.md` (approved by user).

## Global Constraints
- Existing plugin identity and marketplace remain unchanged.
- Host metadata determines thread ID; no caller override or environment-ID fallback.
- Five-second visible-only polling, estimates marked ≈, unknown values not zero.
- Last request usage is the anchor, never cumulative thread usage; no assumed 1M window.
- Read local sessions only; do not reveal conversation text, service instructions, or reasoning text.
- This directory is not a Git checkout. Preserve a source backup and ledger; no invented commits/worktree.

## Review Focus
- Conflicting/missing metadata or session mismatch must never return another chat's data (tasks 1–2).
- Compaction and reduced usage must not retain an oversized historical breakdown (task 1).
- Partial JSONL writes, large records and file truncation must recover without doubling counts (task 1).
- Concurrent snapshots for different chats must retain independent caches (tasks 1–2).
- Slow/failed UI requests and hidden panels must not cause overlapping polling or replace fresh data (task 3).

## Task 1: Local reducer and collector
Files: `lib/context.cjs`, `lib/collector.cjs`, `tests/context.test.cjs`, `tests/collector.test.cjs` under the plugin.
Interfaces: `createState(threadId)`, `consume(state,event)`, `snapshot(state,{reservePercent,now})`; `new ContextCollector({sessionsRoot,...}).getSnapshot(threadId,options)`.
- [x] Write fixture tests: last=1200/window=4000 despite cumulative=900000; unknown window; Unicode estimates; normalization; compaction; message deduplication; no sensitive text in snapshots.
- [x] Run `node --test tests/*.test.cjs`, observe failures for missing implementation.
- [x] Implement reducer, aggregate/details DTO, conservative classifications and residual.
- [x] Write/run collector tests for partial lines, chunking, truncation, mismatched IDs and concurrent A/B requests; implement incremental reader and bounded cache.
- [x] Run suite and exercise collector against the current chat, printing aggregates only.

## Task 2: MCP snapshot protocol
Files: `server.cjs`, `tests/server.test.cjs`, `.codex-plugin/plugin.json`.
Interfaces: `resolveThreadId(meta)`; `get_context_snapshot({reservePercent?})` is app-only and returns `{structuredContent: snapshot}`. `open_panel({})` returns the same snapshot, with UI metadata retained. Keep `report_binding` compatible during transition.
- [x] Write/run protocol tests using the real stdio process and temporary sessions; assert empty/mismatched metadata errors and correct A/B identity.
- [x] Implement async JSON-RPC dispatch, snapshot tool and resource composition; preserve existing plugin ID.
- [x] Run protocol tests plus all prior tests. Back up original files before replacement.

## Task 3: Panel UI
Files: `panel.html`, `panel.js`, `tests/panel.test.cjs`, `scripts/preview.cjs`.
Interfaces: renderer consumes the task-1 snapshot DTO; bridge calls task-2 tool, never sends threadId.
- [x] Write/run behavioral bridge tests: initialization, polling timing, hidden pause, timeout/error state and recovery.
- [x] Implement reference-style card, segmented bar, aligned categories, scrollable disclosures, freshness, reserve selector and diagnostics. Use textContent for source-controlled labels/paths.
- [x] Add a local preview harness serving real aggregate snapshots with a clearly labeled simulated host (outside Codex).
- [x] Inspect browser screenshots at narrow/wide widths and exercise disclosures/refresh; repair material defects.

## Task 4: Integration and documentation
Files: plugin README, `PROBE-RESULTS.md`, plan/ledger.
- [x] Run full tests, syntax checks, actual session collector and MCP smoke test.
- [x] Obtain one independent code review as required by executing-plans; fix important findings with regression tests.
- [ ] Native activation verification pending: supported update installed 0.2.0 without duplication; the current native process remains 0.1.0 until application restart.
- [x] Record exact checked behavior and any host verification limitation; update plan and deliver source links.

Host integration limitation: 0.2.0 is installed, but native open_panel still reaches the already-running 0.1.0 process. Native verification after an application restart remains pending; no claim of hot reload success.


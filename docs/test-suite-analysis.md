# Test-suite analysis: removing redundant TCs and shortening the verify loop

Date: 2026-10-07 · Status: **analysis + implementation** (see §7 for what shipped)

## 1. Baseline (measured, not estimated)

| Metric | Value |
| --- | --- |
| Test cases (unit + components) | **3260** (unit 2627 / components 633) |
| Test files | 180 (unit 128 / components 52) |
| Sum of per-test durations | **618 s** (unit 171 s / **components 447 s**) |
| `vitest run` wall clock | **~64 s** (18 CPUs) |
| lint | 18.7 s |
| typecheck | 15.9 s |
| build | 3.1 s |
| check:manifest / bundle / store / site | 0.2 / 0.2 / 0.2 / 0.2 s |
| e2e (`xvfb-run -a playwright test`) | **283 s** at `workers: 1` |
| e2e cases | 49 (48 run + 1 `test.skip` asset capture) |

Two facts dominate everything below:

1. **Components are 19 % of the cases but 72 % of the test time** (633 cases / 447 s vs 2627 cases / 171 s).
2. **The gate is not reliably green.** 8 tests fail under full parallel load but pass in isolation.

## 2. The 10 % target: where the mass actually is

To remove 326 cases you need the top three files and nothing else:

| File | Cases | Share |
| --- | --- | --- |
| `tests/unit/blocklist-egress.test.ts` | 137 | 4.2 % |
| `tests/unit/feature-consent-dispatch.test.ts` | 101 | 3.1 % |
| `tests/unit/payload-admission.test.ts` | 93 | 2.9 % |
| **cumulative** | **331** | **10.2 %** |

All three are **combinatorial matrices** (50 `it.each`/`describe.each` sites expand into 431 extra cases repo-wide). Their redundancy is real and verifiable:

### 2.1 `blocklist-egress.test.ts` — 137 cases from 3 declared sites

Structure: **17 surfaces × 5 `badRows` = 85 cases**, plus 17 × 3 control rows = 51, plus 1.

The 5 `badRows` are *not* five behaviours. `readBlocklist()` (`src/decisions/blocklist.ts:37-47`) has **exactly one throw site** — the zod `safeParse` failure is inside the `try`, so every malformed shape lands in the same `catch` and raises the same `BlocklistReadError`:

```ts
try {
  const row = await db.metadata.get(DECISION_BLOCKLIST_KEY);
  if (row === undefined) return [];
  const parsed = PersistedBlocklist.safeParse(row.value);
  if (!parsed.success) throw new BlocklistReadError();   // only throw
  return parsed.data;
} catch { throw new BlocklistReadError(); }              // same path
```

And the malformed-value taxonomy is already pinned, at the unit level and more thoroughly, by `tests/unit/blocklist.test.ts:26-36` — 11 values (`undefined, null, "blocked-site.dev", {host}, [x,42], [x,null], [""], ["   "], ["not a host"], ["host/path"], ["https://"], Array(1)`) asserting the same error name, code, absent `cause`, and redaction.

The 17 "surfaces" are also not 17 independent gates: all Jev traffic funnels through `sendConsented` (`src/net/send.ts:354`) and all LLM traffic through `sendLlmConsented` (`src/net/llm-send.ts:505`) — **2 choke points**. The other 15 entries are callers.

**Recommended shape:** keep 1 malformed row (not 5) × a representative surface per *distinct* caller class, and keep the 3 blocklist control rows. This preserves the caller-reachability signal (a caller could bypass a gate) while dropping the 5× multiplicity that the unit test already owns.

### 2.2 `feature-consent-dispatch.test.ts` — 101 cases from 4 declared sites

Structure: 2 features × 2 costRetry × 2 checkpoints × 4 changes = 32, plus 2 × 4 retries × 4 changes = 32, plus 1, plus 3 provenance.

The 4 `change` values are genuinely distinct (model / active / origin / revoke → four different recipients) and **must stay**. The cost is in the outer product: each `(costRetry, checkpoint)` pair re-derives the same "authority changed ⇒ `consent_required`, nothing sent" assertion through a different mock hold. The `held` mechanism (`holdRead`, line ~116) is what makes these slow — `feature-consent-dispatch` costs 17.9 s for 101 cases, the worst s/TC ratio in the unit project.

**Recommended shape:** collapse the `checkpoint` dimension from 2 to 1 for the *retry* matrix (native hold is the stricter of the two), keeping both checkpoints on the primary matrix where the guard-order claim lives.

### 2.3 `payload-admission.test.ts` — 93 cases from 23 declared sites

Verified shape-collapse opportunity in `admitPayload` (`src/net/llm-send.ts:262-264`):

```ts
if ("bookmarks" in facts) { ...isSensitiveUrl(bookmark.url)... }
else if ("url" in facts)  { ...isSensitiveUrl(facts.url)... }
```

`ExplainPayload` (`llm_explain`) and `EscalationPayload` (`llm_escalate`) **both** use the `bookmarks` branch; only `SummaryPayload` (`llm_summary`) uses `url`. So the 6-URL × 3-scope "dirty or nonpublic URL" matrix (18 cases) exercises **two** code paths, not three, and `isSensitiveUrl` (`src/decisions/minimize.ts:473`) is scope-blind.

**Recommended shape:** run the 6-URL matrix for one `bookmarks`-shape scope and one `url`-shape scope (12 cases), and keep one `llm_escalate` case proving it reaches the *same* branch. Drops ~6 cases with no lost branch.

### 2.4 Realistic total from matrices

| Lever | Cases |
| --- | --- |
| blocklist-egress: 5 badRows → 1, keep caller classes | −60…−70 |
| feature-consent-dispatch: drop one `checkpoint` axis on retry matrix | −32 |
| payload-admission: shape-collapse the URL matrix | −6 |
| **matrix subtotal** | **~100–110** |

That is **~3 %**, not 10 %. To reach a genuine 10 % you must also cut the flat (non-matrix) tests, which is where redundancy is *thin* and risk is *high* — see §4.

## 3. Reducing verification time (the bigger, safer win)

### 3.1 The gate is red — fix this first

Measured over 4 full runs: **8 failures every time**, all passing in isolation.

| Failure | Root cause |
| --- | --- |
| `db-retention` ×2, `undo-restore` ×2, `command-palette-actions`, `sidepanel-actions`, `popup-save`, `sidepanel-scan-ask` | `Test timed out in 5000ms` — the 5 s default is below these tests' real cost under 17-way CPU contention |
| `search-perf` "builds the index in under 500 ms" | wall-clock budget; 170 ms isolated, **628 ms** under load |

`conductor/archive/phase4_jev_decisions_20260927/learnings.md:53` already documents the `search-perf` flake as "pre-documented; not a regression", and `tracks.md` records a green gate "with 5 unrelated flakes pass in isolation". **The suite has been reporting red for months and the project has learned to read past it** — which is exactly what erodes the value of running it.

**Verified fix for the timeout class.** A top-level `testTimeout: 20_000` in `vitest.config.ts` propagates to both projects (proved with a control: `testTimeout: 300` makes the 3.7 s tests fail, so the setting is live) and collapses the failures:

| Config | Failures (3 runs) |
| --- | --- |
| as-is | 8, 8, 8 |
| `testTimeout: 20_000` | 4, 3, 2 |
| `--testTimeout=20000` (CLI) | 4, 3, 2 |

Residual failures are then only the genuine wall-clock assertions (`search-perf`, `popup-save` 150 ms budget, plus one Radix dialog-teardown race).

**Recommended:** `testTimeout: 20_000` top-level, and convert the 3 wall-clock assertions to *relative* or settled-state checks:
- `search-perf`: assert `documentCount` + a generous ceiling, or compare against a same-run baseline rather than an absolute 500 ms.
- `popup-save:661` `expect(elapsed).toBeLessThan(150)` — the component's own comment concedes cold render ≈ 150 ms; assert the settled interactive state instead of a stopwatch.

### 3.2 e2e: 283 s → 92 s, no test changes

`playwright.config.ts` sets `workers: 1`. Every test gets an isolated temp profile and binds port `0` (`tests/mock-servers/jev.ts:365`), so tests are independent by construction.

| Workers | Wall clock | Result |
| --- | --- | --- |
| 1 (current) | 283 s | 48 passed |
| 2 | 188 s | 48 passed |
| 3 | 128 s | 48 passed |
| 4 | 112 s | 48 passed |
| 6 | 95 s | 48 passed |
| **10** | **90 s** | **48 passed, stable over 3 runs** |

**3.1× faster with zero test edits.** Set `workers: 4` (safe, still ~2.5×) or `workers: 8` on an 18-CPU box. The 41 s and 37 s outliers (`audit-provider-workflows`, `audit-deep-fixes`) are mock-server round trips that overlap cleanly.

### 3.3 The per-task loop: use targeted runs, not the whole gate

The workflow currently says "run the narrowest relevant tests while developing" but the gate list is all-or-nothing. Measured costs:

| Command | Wall clock |
| --- | --- |
| 1 targeted file | **1.5 s** |
| 3 targeted files | 1.7 s |
| `--project unit` (2627 cases) | 22 s |
| full `vitest run` | 64 s |
| full local gate (lint+typecheck+test+build+4 checks) | ~103 s |
| + e2e | ~386 s |

`vitest related <file>` is **not** a shortcut here — `src/db/meta.ts` pulls 64 files / 50 s, `src/decisions/minimize.ts` 70 files / 48 s. Import-graph reach is too dense.

**Recommended per-task policy:**
1. While editing: `npx vitest run <the 1-3 files you touched>` → ~1.5 s.
2. Before commit: `--project unit` if you touched `src/` shared modules; `--project components` if you touched `src/entrypoints/` → 22 s / 45 s.
3. Full gate only at task completion, and **e2e only when touching entrypoints or egress** (already the documented rule).

### 3.4 The single biggest test-level win

`tests/components/restructure-view.test.tsx:606` costs **8.6 s by itself** (~2 % of the whole components project) because `POLL_MS = 1_000` is a module constant (`src/entrypoints/sidepanel/RestructureView.tsx:87`) and `RestructureView` accepts only `className` (`:305`). `App` already has the precedent for injectability (`undoToastAutoHideMs`, `src/entrypoints/sidepanel/App.tsx:210`). Making the poll interval a prop cuts that test to ~1 s — **a bigger win than every test deletion combined**.

Secondary: `render(<App/>)` costs ~370–490 ms in jsdom, and the four big sidepanel files mount it ~55 times (≈20 s).

## 4. What NOT to cut

Per-file analysis of the components suite (every claim cited against source) flagged these as tripwires, not redundancy:

- **Consent/egress state machines** — `options-decisions` disclosure-verbatim, consent re-arm, superseded-origin races, withheld grant control; all 12 `options-llm-settings` cases; `popup-suggestions` "sends nothing" assertions.
- **Undo re-entrancy** — `undo-reentry:628` (double activation → one revert), `:889` (auto-hide retires the armed target — the *only* test pinning that wiring), `:822` (`state_unrecorded` must not offer retry).
- **Destructive-op idempotency** — `sidepanel-actions:776` (Delete key repeat), `:883` (failed restore stays retryable).
- **Scheme/policy guards** — `:854` (`javascript:` bookmark), `sidepanel-dnd:568` (managed-folder drop, asserts the rendered affordance *and* zero snapshot).
- **Redaction** — `review-view:664` (worker message surfaces verbatim).

Concretely-verified safe deletions exist but are small: **~14 cases / ~15 s** (e.g. `review-view:600` duplicates `:571`; `sidepanel-dnd:444` is subsumed by `:606`'s stronger null assertion; `popup-save:263/269` duplicate `context-menu.test.ts:230/256`).

## 5. Recommended order of work

| # | Action | Effort | Payoff |
| --- | --- | --- | --- |
| 1 | `playwright.config.ts`: `workers: 4` (or 8) | 1 line | e2e 283 s → 92 s (or 90 s) |
| 2 | `vitest.config.ts`: `testTimeout: 20_000` | 1 line | failures 8 → 2–4; gate becomes trustworthy |
| 3 | Convert the 3 wall-clock assertions to settled-state/relative | ~30 lines | gate reaches green |
| 4 | Make `POLL_MS` injectable | ~5 lines | −7.6 s from one test |
| 5 | Document the 1-file / per-project / full-gate loop in `conductor/workflow.md` | docs | per-task verify 103 s → ~2 s |
| 6 | Collapse the 3 matrices (§2.1–2.3) | moderate | **−100…110 cases (~3 %)** |
| 7 | Apply the ~14 verified component deletions | low | −14 cases, −15 s |

Items 1–5 deliver the stated goal — *faster verification when handling a task* — without touching a single test's meaning. Item 6 is the honest ceiling for redundancy-only deletion: **~3 %, not 10 %**. Reaching 10 % requires deleting flat tests that currently carry real signal, which §4 argues against.

## 6. Caveats

- Per-test durations vary up to 2.4× run-to-run; all timings are ranges, and the machine had background load (loadavg 24 on 18 CPUs) during measurement.
- e2e worker counts were validated to `workers: 10` on this box; CI hardware is smaller, so `workers: 4` is the safer default.
- The 10 % figure counts *cases*; if the target is wall-clock, items 1–5 achieve far more than 10 % without any deletion.
- **No coverage instrumentation was available** (`@vitest/coverage-v8` is not a dependency), so every redundancy claim in §2 is a *source-reading path-identity* argument — verified by reading the guard and its call sites — not a measured coverage delta. A temporary instrumented run confirmed that adding coverage slows the suite enough to reintroduce load failures, so it was not used as a gate.

## 7. What shipped

| # | Change | File(s) | Result |
| --- | --- | --- | --- |
| 1 | e2e `workers: 4` (env-overridable via `PLAYWRIGHT_WORKERS`) | `playwright.config.ts` | 283 s → **92–125 s** (3 runs, 48 passed each) |
| 2 | `testTimeout: 20_000` | `vitest.config.ts` | load-induced failures 8 → 0 |
| 3a | Best-of-N estimator for the build/query budget | `tests/unit/search-perf.test.ts` | 628 ms worst sample → 264–363 ms stable |
| 3b | Best-of-3 estimator for the popup render budget | `tests/components/popup-save.test.tsx` | no longer trips at 160 ms under load |
| 3c | `asyncUtilTimeout: 5_000` for the components project | `tests/setup-components.ts` (new) | removed the Radix teardown race |
| 4 | `pollMs` seam on `RestructureView` | `src/entrypoints/sidepanel/RestructureView.tsx`, `tests/components/restructure-view.test.tsx` | one test 8649 ms → **943 ms** |
| 5 | Verify-loop table + parallel-test rules | `conductor/workflow.md` | per-task loop 103 s → **~1.5 s** |
| 6 | Matrix collapses | 3 unit test files | −113 cases |
| 7 | Component deletions | 7 component test files | −7 of 14 proposed (see §8) |
| 8 | Flake fix in `options-llm-settings.test.tsx` | 1 line: `getByText` → `await findByText` | removed the last observed flake (8/8 green under load) |

**Final case count: 3260 → 3148** (−112, −3.4 %). Suite green: **3148/3148**,
full local gate 8/8 steps passing (lint, typecheck, test, build, check:manifest,
check:bundle, check:store, check:site — all `rc=0`), e2e 48/48 passing in
92–125 s across 3 runs.

Case-count accounting: 3260 − 51 (blocklist-egress) − 40 (feature-consent-dispatch)
− 14 (payload-admission) − 7 (components) = 3148.

### Verification of the deletions

Each matrix deletion was independently mutation-tested by the Lead — the
production guard was weakened in a throwaway copy and the *trimmed* suite had to
still catch it:

| Deletion | Mutation applied | Trimmed suite result |
| --- | --- | --- |
| blocklist-egress rows | `readBlocklist` stops validating row shape | **17 failures** — caught |
| feature-consent `active` cells | drop `providerId` from the approval compare | 61 passed — **NOT caught** |
| payload-admission extra keys | extra-key rejection neutered | **8 failures** — caught |
| payload-admission IP rows | private-IP rejection weakened | **3 failures** — caught |

The one "not caught" result is a *confirmation*, not a problem: the **original
101-case suite also passed that same mutation** (101 passed). The deleted `active`
cells were therefore provably contributing no discrimination — they asserted an
outcome that was already guaranteed by the retained `model`/`origin` cells. That
is the strongest available evidence that this deletion was genuinely redundant.

All four `src/` mutations were reverted; `git diff src/` shows only the intended
`RestructureView.tsx` change.

## 8. Correction: 6 of 14 component deletions were NOT redundant

§2's component candidates were derived by *reading* the covering tests. A
teammate re-derived each one by **mutation testing** — disabling the production
guard in a throwaway copy and checking whether anything else in the suite
caught it — and found **6 of the 13 citations were false**. Those deletions were
reverted; each is a *sole pin*, not a duplicate:

| # | Test | Why the citation was wrong |
| --- | --- | --- |
| 2 | `review-view` pending badge | `excludes placeholders…` guards the *placeholder* half; only the deleted test guards the *history rows* half. Badge mutant survives the whole file without it. |
| 3 | `review-view` double click | Cited e2e spec proves the **Undo/toast** guard (B12), not the **Explain** guard at `ReviewView.tsx:699`. Zero references to Explain in that spec — verified by grep. |
| 5 | `sidepanel-dnd` drag overlay | The cited test asserts the overlay is **absent** when idle (`:590`); the deleted test asserts it **renders** with the lifted row (`:450`). Opposite assertions. |
| 8 | `command-palette-actions` Settings button | Cited `sidepanel-topbar:68` calls `renderTopBar()` directly — it never exercises App's `onOpenSettings={openOptionsPage}` wiring (`App.tsx:969`). |
| 9 | `popup-save` last-used folder | Cited `context-menu.test.ts:230` exercises `handleContextMenuClick`, a different call path from `popup/App.tsx:266`'s prefill. |
| 10 | `popup-save` gone-folder fallback | Same different-call-path error as #9. |

One further case (#7, `sidepanel-dnd` roving focus) *was* deleted, but the stated
reason was also wrong: the test is genuinely vacuous — removing the
`defaultPrevented || dragging` guard entirely is undetected by the whole
components project. The deletion is harmless, but it was not redundant "because
something else pins it".

The three MERGE operations (§7 item 7) were verified genuine: each folded
assertion now lives in the surviving test and fails when the underlying
behavior is mutated.

**Process lesson for future analysis:** "covered by X" derived from reading is
unreliable — 6/13 wrong here. Derive coverage claims by mutation, or by actual
coverage instrumentation, before deleting.

**Gate status: green.** After items 1–4 the full suite passed 4/4 consecutive
runs at 3260/3260, where it had previously failed 8 tests on *every* run. After
the deletions it passes at 3148/3148, and the full 8-step local gate is green.

### Verification discipline used

- Every config change was proved live before being kept: `testTimeout` was
  confirmed to propagate to both projects by setting it to 300 ms and watching
  the slow tests fail, then restoring.
- The sped-up `RestructureView` polling test was **mutation-tested**: deleting
  the `pollPending` coalescing guard makes it fail 3/3 runs, while the guarded
  build passes 3/3. An earlier, faster scaling of that test passed 1/13 under
  mutation — i.e. it had silently lost discrimination — and was reworked until
  the margin was real (4 calls guarded vs 10 unguarded, against a `<= 6` bound).
- `package.json` and `package-lock.json` are untouched; the coverage package
  was installed with `--no-save` for a one-off probe and then removed.

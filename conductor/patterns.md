<!-- Last refreshed: 2026-10-07 (refresh — public-cut handoff patterns added; no new track learnings) -->

# Codebase Patterns

Reusable patterns discovered during development. Read this before starting new work.

## Code Conventions

- Strict TypeScript under `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; ESLint flat config via `npm run lint`.
- All Zod imports go through the jitless-configured `src/schemas/z.ts` — never import `zod` directly (MV3 CSP).
- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, and `importScripts` are ESLint-banned outside `src/net/**`; Jev uses the `src/net/send.ts` consent gate and LLM uses `src/net/llm-send.ts`. (from: phase5_llm_layer_20260928, custom_jev_provider_20260929, deep_audit_fixes_20261005, 2026-10-05)
- `runtime.onMessage` handlers are total: return `{ok:true,…} | {ok:false,code,message}` Zod unions, never throw (see elevated patterns).

## Architecture

Phase 0 (`phase0_foundation_20260925`) delivered the MV3 WXT scaffold (background worker + popup/sidepanel/options React surfaces), Zod schemas mirroring `PROJECT_PLAN.md` §7, the Dexie database, the WebCrypto provider-key store, versioned consent records + disclosure strings, the consent-gated network module, the Jev `/v1/systemone` wire client with a synthetic connection test in Options, and store-compliance docs guarded by `check:manifest`/`check:bundle` in CI.

Phase 1 (`phase1_core_manager_20260926`, Phases 1–5) delivered the offline core manager: native-tree sync (typed `chrome.bookmarks` slice + listeners/reconcile), extension metadata in IndexedDB (tags/categories/notes), a guarded mutation service + LIFO undo (snapshots in Dexie), duplicate detection with keep-one merge, JSON/Netscape/CSV import/export with an import planner/writer, the full side-panel UI (ARIA folder tree, virtualized list/grid, views, bulk actions, dnd-kit drag and drop, tag manager, grouped duplicates view, import/export dialogs), popup/shortcut/context-menu quick save, `_favicon` icons, and "delete all extension data". Installed UI stack: Radix primitives (`radix-ui` umbrella, Dialog/DropdownMenu/Popover/Checkbox/Switch), Tailwind 4, `@dnd-kit/core`+`sortable`, `@tanstack/react-virtual`, `dexie-react-hooks`. Later tracks delivered MiniSearch, Readability summaries, the Jev decisions pipeline, the optional LLM layer, store readiness, the Options redesign, and one custom Jev provider. Zustand and TanStack Query remain planned, not installed.

## Gotchas

- The repository has an existing Beads workspace. Do not reinitialize it or automatically sync it to the remote.
- `bd` warns `beads.role not configured (GH#2950)` until `git config beads.role maintainer|contributor` is set — cosmetic, not blocking.
- `src/security/credentials.ts` owns encrypted envelope IO in `chrome.storage.local`; `src/security/keys.ts` delegates Jev key access while preserving storage IDs. UI prefs, settings, consent, sentLog, and non-extractable CryptoKeys live in IndexedDB. Delete-all clears storage through `src/security/delete-all.ts`; keep permission justifications aligned with those call sites. (from: phase1_core_manager_20260926, phase5_llm_layer_20260928, 2026-09-30)
- **Bound scripted Playwright capture actions** — the store-asset capture runs under a bounded runner `actionTimeout` so an unresponsive page action cannot hang the capture run indefinitely. (from: store-prep `1fa8360`, 2026-10-06)

## Testing

- Vitest 5: `tests/unit` + `tests/components` (RTL, `globals: false` — set `IS_REACT_ACT_ENVIRONMENT` and call `cleanup()` manually) + shared `tests/fixtures` + `tests/fakes` (in-memory `chrome.bookmarks` fake with fixed roots, managed nodes, indexes, and event emission).
- Playwright persistent-context e2e in `tests/e2e` (`channel: "chromium"`, not branded Chrome; `E2E_HEADLESS=1` to opt into headless) with helpers under `tests/e2e/helpers` for launch/seed/surfaces/DB probes; extension pages can call `chrome.*` via `page.evaluate`, which is how specs seed and inspect state.
- Full local gate mirrors CI: `lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle` → `check:store` → `xvfb-run -a test:e2e` (`check:site` when touching `site/`).

---

Last refreshed: 2026-10-07 (full refresh; deep_audit_fixes_20261005 patterns already elevated; public-cut patterns appended)

---

## Elevated from track `phase0_foundation_20260925` (2026-09-25)

- **Message handlers are total, not throwing.** A `runtime.onMessage` handler returns `{ok:true,…} | {ok:false,code,message}` as a Zod union validated on both ends; every failure is typed, redacted, and testable. Never let handler exceptions leak `cause` objects that can embed response bodies (SyntaxError/ZodError do).
- **Fail-closed gates re-verify per call.** Resolve the destination, then verify model/scheme/exact origin, the scope-specific request guard and wire schema, current origin-scoped consent, host permission, and credential before sending; the LLM gate also reserves budget. Presets stay registry-backed; custom Jev resolves only from validated stored settings. Earlier failures must short-circuit before sensitive reads or network activity. (from: phase0_foundation_20260925, phase5_llm_layer_20260928, custom_jev_provider_20260929, 2026-09-30)
- **Mutation ordering for irreversible pairs.** Enable writes settings→key→consent (consent last, with an unwind on failure); revoke removes consent first so a later failure still blocks the gate.
- **WebCrypto key storage:** non-extractable AES-GCM-256 `CryptoKey` persists in IndexedDB via structured clone; ciphertext+12-byte IV envelope in `chrome.storage.local`. Assert plaintext-absence in storage-write tests, not just encryption correctness.
- **Bundle scanners must scan normalized whole-file content, not lines** — `eval\n(` and multi-line `<script src>` evade line-based regexes.
- **Testing `chrome.*` globals in Vitest:** a `declare const chrome` slice keeps `vi.stubGlobal` workable without fighting the DOM lib.
- **Playwright extension smoke:** persistent context + `waitForEvent("serviceworker")`; cold-profile SW registration can exceed 30s — set a spec-level timeout rather than weakening waits; `networkidle` settles ~2s on extension pages but is not the reliable signal.

_Last refreshed: 2026-09-25_

## Elevated at archive — track `phase0_foundation_20260925` (archived 2026-09-25)

- Zod 4 `.refine`/`.check` still run after a failed base check on the same schema — wrap throwing ops like `new URL()` inside refines in try/catch. (from: phase0_foundation_20260925)
- Dexie `add`/`put` writes a generated inbound key back onto the caller's object — reuse of a fixture smuggles in a stale `id` and throws `ConstraintError`. Always add fresh object copies. (from: phase0_foundation_20260925)
- Testing `.mjs` CLI scripts: guard `main()` behind `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, accept argv/env path overrides, drive tests via `spawnSync(process.execPath, [script, ...])` — `tsc` never sees the script and exit code/stderr assert directly. (from: phase0_foundation_20260925)
- `vi.mock(path, async (importOriginal) => ({ ...actual, dep: vi.fn() }))` stubs one export while keeping real error classes for `instanceof` propagation assertions. (from: phase0_foundation_20260925)
- `vi.resetModules()` + `vi.doMock(module, factory)` + a dynamic `await import` exercises defensive self-checks that frozen registries can never trip at runtime — the doMock covers both specifier spellings in the re-imported graph. (from: phase0_foundation_20260925)
- Never read a response body on non-2xx — check `response.status` first so provider content structurally cannot leak into error messages. (from: phase0_foundation_20260925)
- Zod: `z.discriminatedUnion` requires a unique discriminator literal per option — two `ok: z.literal(true)` success shapes need a plain `z.union` and `"key" in data` narrowing; `.parse` emits keys in schema-definition order, so `Object.keys(parsed)` makes audit `fieldNames` honest. (from: phase0_foundation_20260925)
- `chrome.permissions.request` requires a user gesture — call it synchronously in the click handler, not after an await. Trusted-page check: `sender.url === chrome.runtime.getURL("options.html")` — Chrome sets `sender.url`, not the sender. (from: phase0_foundation_20260925)
- A negative fixture that can't fail is worse than none — the fixture must actually contain the ignored case (e.g. a "not requested" permission row) to prove the guard ignores it rather than never sees it. (from: phase0_foundation_20260925)
- Doc-drift discipline: grep the actual API call sites before trusting permission justifications (`chrome.storage.local` may be written by one module only); store disclosures must match `consent/disclosure.ts` constants (origins, field names, headers, trigger wording) nearly verbatim. (from: phase0_foundation_20260925)
- A "canceled" subagent dispatch may still complete — verify `git log` for landed commits before assuming work was discarded or re-dispatching. (from: phase0_foundation_20260925)
- RTL/Vitest conventions (`globals: false`): set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually; prefer `findByRole`/`aria-label` over text regexes that collide with repeated disclosure copy; capture the button handle before its accessible name flips busy ("Testing…"); type `it.each` tuple arrays explicitly (`const cases: [Code, string][]`) or literals widen to `string`. (from: phase0_foundation_20260925)

## Elevated at refresh — track `phase0_foundation_20260925` (refreshed 2026-09-26)

- Playwright extension tests must use `channel: "chromium"` — branded Google Chrome silently ignores `--load-extension`, so the persistent context never loads the built extension. (from: phase0_foundation_20260925)
- WXT scaffold specifics: a `sidepanel/` entrypoint emits `sidepanel.html` + the `side_panel` manifest key automatically; root `tsconfig.json` extends `.wxt/tsconfig.json` but must set `"jsx": "react-jsx"` itself. (from: phase0_foundation_20260925)
- Type shared fixtures with `satisfies z.input<typeof Schema>` under `verbatimModuleSyntax` + `noUncheckedIndexedAccess` — keeps fixtures honest while `.default()` fields stay absent. (from: phase0_foundation_20260925)
- Node's `webcrypto.CryptoKey` type is not assignable to the DOM `CryptoKey` (Node's `KeyUsage` union is wider) — cast once in tests; runtime objects structured-clone identically. (from: phase0_foundation_20260925)

## Elevated from track `phase1_core_manager_20260926` (2026-09-26)

### Chrome API surfaces
- **Lazy `declare const chrome` slices throw SYNCHRONOUSLY when a surface is absent or partial** — every caller boundary (event subscriptions, effect bodies, startup registration) needs try/catch or an async wrapper, and tests must cover absent AND partial surfaces. Registration should be all-or-nothing with cleanup: `push(a(), b())` evaluates every argument before pushing, so a mid-list throw leaks earlier listeners. (from: phase1_core_manager_20260926)
- **A listener/handler must be total:** return typed `{ok}|{ok:false,code,message}` unions or throw typed error classes (`MutationError`, `MetaRepoError`) that callers map — never leak exception `cause` objects. (from: phase1_core_manager_20260926)
- **Fixed roots `"1"`–`"3"` are ordinary parents; `"0"` is not.** A root can RECEIVE a move but is never a MOVE SUBJECT (no drag handle, no rename/delete). Denying roots as destinations breaks "move to the Bookmarks bar" — the most common move there is. (from: phase1_core_manager_20260926)

### Undo / snapshot invariants
- **Snapshot-then-mutate means every snapshot may outlive a failed mutation.** Replay must be idempotent (skip nodes whose original id still resolves — Chrome never reuses ids) AND resumable (persist an `idMap` per recreate), not merely retryable. (from: phase1_core_manager_20260926)
- **Never replay a destructive inverse without checking the target is actually gone.** (from: phase1_core_manager_20260926)
- **A LIFO undo stack needs a row-targeted discard path.** Use `discardById` for a flow-owned snapshot; `discardLatest()` can delete another concurrent flow's snapshot. A poisoned snapshot must not wedge older undo entries, and a stale delete snapshot must not write stale metadata onto surviving nodes. (from: phase1_core_manager_20260926, 2026-09-26)
- **Serialize stack operations** (`tail = tail.then(run)`) and guard re-entry on the UI button — `undoLatest` serializes but does not dedupe, so a double-click pops two snapshots. (from: phase1_core_manager_20260926)

### Data & concurrency
- **Read-modify-write belongs inside the row's transaction**, never a whole-array patch after a stale read (bulk tag ops lost updates otherwise). (from: phase1_core_manager_20260926)
- **`chrome.storage.local` stays reserved for key ciphertext envelopes** — UI prefs go in Dexie (`metadata` table under a namespaced key like `prefs:lastFolderId`), which also makes delete-all wipe them. (from: phase1_core_manager_20260926)

### Trust boundaries & IO
- **Every fallible IO entry point returns a result union — no thrown error classes.** Defense in depth belongs at BOTH the planner and the writer: never trust the caller to have planned (`writeImport` re-checks blocked/empty URLs). (from: phase1_core_manager_20260926)
- **Untrusted markup:** `DOMParser` + `getAttribute`/`childNodes` only, never `innerHTML`; cap file size on EVERY parser (not just the first one written) and bound recursion (`MAX_TREE_DEPTH`) before `safeParse` — deeply nested valid JSON overflows Zod's recursive parse into a `RangeError`. (from: phase1_core_manager_20260926)
- **CSV formula-injection escaping (`= + - @ TAB CR`) happens BEFORE quoting and without pre-trimming**; header order may vary but extra columns are ignored. (from: phase1_core_manager_20260926)

### UI
- **dnd-kit keyboard events bubble into the app's own key handlers** — guard with `if (event.defaultPrevented) return;` at the top of listbox/tree handlers, because the `dragging` render value is stale during the lifting keydown. (from: phase1_core_manager_20260926)
- **Drop slots are only meaningful in tree-ordered views** (`all`/`folder`) — in sorted views (recent/tag/category) "before row X" has no tree position, so gate the drop zones on the view kind. (from: phase1_core_manager_20260926)
- **Cross-surface handoffs (popup → side panel) need a `chrome.storage.onChanged` subscription**, not just a mount-time read: an already-open panel never remounts. Clear the handoff key unconditionally as soon as it is read. (from: phase1_core_manager_20260926)
- **Never leave a destructive action silent:** failed saves flash an error badge; delete-all renders the origins it could not revoke instead of claiming a clean wipe. (from: phase1_core_manager_20260926)
- **A dialog for a long operation must stay dismissible**; race cross-context IndexedDB deletion (`db.delete()`) with a timeout and broadcast a release so other contexts `db.close()` first. (from: phase1_core_manager_20260926)

### Testing
- **An "assert nothing changed" test passes for the wrong reason when the mutation is async** — always `waitFor` the outcome (a stale test asserted an unchanged parent id immediately after a fire-and-forget drop). (from: phase1_core_manager_20260926)
- **Zero-egress assertions exclude only known internal schemes** (`chrome-extension:`, `chrome:`, `data:`, `blob:`, `about:`), rather than matching only HTTP(S), so WebSocket/FTP-style URLs cannot evade the assertion. Record requests on the persistent context and assert after `context.close()` to include teardown traffic. (from: phase0_foundation_20260925, phase1_core_manager_20260926, 2026-09-30)
- **A review diff must include `tests/`** — a path-scoped diff that omits them makes a reviewer report "no tests in this phase" as a finding. (from: phase1_core_manager_20260926)
- **Local-index reorder after removal:** same-parent capacity is `length - 1`, cross-parent is `length` — encode both in the fake so index validation is actually exercised. (from: phase1_core_manager_20260926)

## Elevated at refresh — track `phase1_core_manager_20260926` (refreshed 2026-09-26)

- **Dexie migration test pattern:** seed a genuine vN-1 database via a standalone `Dexie` with only the older `version().stores()`, close, reopen with the real class, and assert `verno` plus preserved rows. Declaring a new version mechanically bumps `Dexie.verno` — schema-shape tests asserting verno/table-list must be updated in the same commit. (from: phase1_core_manager_20260926)
- **ESLint does not honor `.gitignore`** — `.worktrees/**` must be listed in `eslint.config.mjs` `ignores`, or nested `.wxt`/`.output`/`.agents` copies inside worktrees get linted. (from: phase1_core_manager_20260926)
- **Guard managed/root bookmark writes via `isFixedRoot`/`unmodifiable` predicates, never error-message matching** — the fake's managed/root error strings are our contract, not byte-verified against real Chrome. (from: phase1_core_manager_20260926)

## Elevated at archive — track `phase2_search_20260926` (archived 2026-09-26)

- **Keep search-layer types pure**: a `SearchIndexHandle` (index + per-query ctx) belongs in `src/search/run.ts`, not in the React hook that builds it — views, popup, omnibox, and tests then share one dependency-free contract. One-shot surfaces get a `buildSearchHandle(tree, metas, tagDefs)`; the live hook diffs against the same `toSourceBookmark`/`ancestorsOf` mapping so every surface indexes identically. (from: phase2_search_20260926)
- **A denylist URL guard cannot distinguish "user picked a suggestion" from "user typed free text"** — bare words pass `isOpenableUrl`. The omnibox keeps a per-session set of emitted `content` strings and only direct-opens those; anything else resolves the top openable hit or nothing. (from: phase2_search_20260926)
- **Omnibox descriptions are a real XML dialect** (`<match>`/`<dim>`/`<url>`) — escape `& < > " '` on every user-derived string or a bookmark title becomes live Chrome markup. `setDefaultSuggestion` takes `{description}` only. (from: phase2_search_20260926)
- **MV3 omnibox listeners must be total and silent**: wrap every handler body, translate failures to `suggest([])`/no-op open, and never log — query and bookmark data must not reach the console. Inject the `chrome.omnibox` surface + `load`/`open` deps so tests drive a fake listener bus with zero globals. (from: phase2_search_20260926)
- **MiniSearch fuzzy 0.2 makes short test queries lie** ("zeta" matches "Beta") — assert zero results only with terms ≥2 edits from every indexed token, and remember single letters prefix-match tokens rather than substring-matching. Stored fields (folderTitles/Ids) never match free text; only `folder:` filters them. (from: phase2_search_20260926)
- **"Restore the form unchanged" = controlled state lifted above the conditional** — the popup unmounts the save form during search but its state lives in `App`, so clearing re-renders it intact. (from: phase2_search_20260926)
- **jsdom has no jest-dom here and suggestion options collide with result options** — assert with `toBeNull()`/`textContent`/`.value`, scope result queries to the named results listbox, and fire `pointerDown`+`click` for Radix dropdown triggers (click alone won't open them). (from: phase2_search_20260926)
- **react-hooks eslint (new rules) bans setState in effects and in-JSX mutation** — use render-phase state adjustment (`if (open !== prevOpen) setState`), derived clamps, and useMemo for flat index offsets. Radix Dialog's focus restore misses elements focused without a trigger — capture `document.activeElement` and `.focus()` in a microtask after close. (from: phase2_search_20260926)
- **e2e on an offline browser**: fake https domains land on `chrome-error://` — bookmark `chrome-extension://<id>/*.html` URLs for deterministic tab-open assertions (also stays inside the internal-scheme egress boundary). Playwright cannot drive the omnibox — keep address-bar coverage in unit tests. (from: phase2_search_20260926)
- **Fixture shape drift:** `FolderNode` uses `childIds` (not `children`) and both node kinds require `isRoot`/`isManaged` — hand-built `FlattenedTree` fixtures must carry them. (from: phase2_search_20260926)

## Elevated from track `phase3_jev_client_20260927` (2026-09-27)

- **Scoped consent gates validate cheap-before-sensitive.** Check scope registration and its request-shape predicate before consent, permissions, or keys. Only `jev_test` uses a deep-equal synthetic payload; decisions and summary verification have strict scope-specific state guards. Extend the frozen registry, never caller-provided policy. (from: phase3_jev_client_20260927, phase4_jev_decisions_20260927, phase5_llm_layer_20260928, 2026-09-30)
- **Playwright CAN route extension service-worker fetches** — `context.route("https://host/**")` intercepts MV3 worker `fetch` end to end, so provider e2e can exercise the real gate + real `fetch` with a scripted response.
- **`chrome.permissions.request` never resolves under Playwright Chromium** (headed/headless, click/evaluate/CDP userGesture — promise pends forever, no prompt window exists). Workaround: copy the built `.output/chrome-mv3` to a temp dir, promote the optional host pattern to `host_permissions` in the manifest copy, and launch from that — the production `permissions.request` path still runs and resolves `true` for the already-held permission.
- **Retry/backoff purity:** inject `sleep`/`random`/`now` so tests drive full-jitter exponential backoff and `retry-after` (delta-seconds AND HTTP-date) deterministically; classify retries by outcome code, never by inspecting response bodies.
- **Error chains need assertion discipline.** When an outer error wraps an inner typed error as `cause`, redaction tests must assert on every link (message, `JSON.stringify` round-trip, `inspect()` output) — asserting only `cause === undefined` on the outer error misses a leaky inner one.
- **Assert typed errors via a public `inspect()`/serialization shape,** not `instanceof` alone — `vi.mock` boundaries and message-port serialization both erase class identity.
- **`noul` (yes/no) confidence is a margin, not a probability:** `noulMargin(p, t)` validates `0<t<1` and `0≤p≤1`; choice/score reuse the provider's own confidence field.
- **Verify test-suite exclusion with `vitest list --filesOnly`,** not a grep for the directory name — substring matches on "live"/"e2e" inside test names produce false positives.
- **HTTP mock servers for provider tests:** bind `127.0.0.1` on an ephemeral port, script status/delay/malformed-body per call index, record every request, and drain/destroy sockets on `close()` so hanging replies can't leak across tests.

## Elevated at refresh — track `phase3_jev_client_20260927` (refreshed 2026-09-27)

- **Keep pure domain contracts independent of surfaces.** Search/query, Jev question builders, retry, and usage logic expose typed contracts without Chrome/DOM/fetch dependencies; provider settings/persistence adapters are not part of that pure layer. Views, popup, omnibox, and tests share `SearchIndexHandle` and the same search document mapping. (from: phase2_search_20260926, phase3_jev_client_20260927, 2026-09-30)
- **IndexedDB read-assertions must not create the db.** Applies to delete-checks AND e2e consent/sentLog probes from extension pages: `indexedDB.databases()` first, then a guarded `open()`. (from: phase1_core_manager_20260926, phase3_jev_client_20260927, 2026-09-30)
- **Jev concurrency is a shared per-provider counting semaphore.** The first client's limit is shared by later clients for that provider, including `custom`; use `resetJevClientPools()` between isolated tests so module-level limits/waiters do not leak. (from: phase3_jev_client_20260927, custom_jev_provider_20260929, 2026-09-30)
- **Abort has three observably different checkpoints:** pre-aborted signal, abort during the gate's async consent/permission/key reads, abort mid-flight. Test mid-flight with `vi.waitFor` until fetch is invoked, then abort — an immediate `controller.abort()` fires during DB reads and conflates pre-flight with in-flight. (from: phase3_jev_client_20260927)
- **`Date.parse` leniently accepts `"1.5"`, `"-5"`, `"+3"` as year-2001 dates** — require a letter before attempting HTTP-date parsing or garbage silently becomes a 0 ms retry delay. (from: phase3_jev_client_20260927)
- **`exactOptionalPropertyTypes`: conditionally spread optional fields** (`...(cond ? {k: v} : {})`) — never assign `undefined`. (from: phase3_jev_client_20260927)
- **Definition-time validation throws `TypeError`** (programmer error, never crosses the wire); only run-time answer problems use the domain error taxonomy. Enforce the wire schema's bounds (choice 2–255 options, score 2–10 levels) at declaration too — same bounds, raised earlier. (from: phase3_jev_client_20260927)
- **Parallel-worktree recipe:** one `.worktrees/` worktree per task with `cp -al` hardlinked `node_modules`/`.wxt`, disjoint file sets for clean cherry-picks, and a single coordinator serializing commits, notes, plan markers, and `bd` updates. Fix a lint-broken HEAD before branching or every worktree inherits it. (from: phase3_jev_client_20260927)
- **Live-test suite convention:** standalone `vitest.live.config.ts` scoped to `tests/live/**` (the default config's `include` never collects it), `it.skipIf(key === undefined)` keeps it green keyless, keys from `process.env` only and never logged. (from: phase3_jev_client_20260927)
- **`vi.fn` unused trailing params trip `no-unused-vars` even with a `_` prefix** — drop the param entirely rather than naming it `_options`. (from: phase3_jev_client_20260927)

_Last refreshed: 2026-09-27_

---

## Elevated from track `phase4_jev_decisions_20260927` (2026-09-28)

### E2E: wire-level fakes and restarts

- **Fake the provider at the wire, not the client.** `context.route` answers actual sent question keys/candidates with schema-valid responses so the real client, gate, pipeline, and persistence execute. A request valve fulfills the first N and holds the rest: a sequential runner then freezes deterministically mid-batch. Assert committed progress and release parked requests before `context.close()` so teardown cannot race pause into failure. Optional hosts are promoted to install-time `host_permissions` in a temporary manifest copy; this does not verify Chrome's native permission prompt. (from: phase3_jev_client_20260927, phase4_jev_decisions_20260927, phase5_llm_layer_20260928, 2026-09-30)
- **Feature consent requires affirmative disclosure approval, not a bare
  feature click.** Explain/Restructure show recipient, endpoint/model,
  fields, trigger, purpose and scoped version in an unchecked-default dialog.
  Their worker handlers never grant consent; the UI writes only the accepted
  scope/origin and retries with its binding. Summarize retains its explicit
  bound affirmative approval. Opening/dismissing grants nothing; cost
  confirmation is separate. Both gates recheck authority per attempt.
  (from: phase5_llm_layer_20260928, deep_audit_fixes_20261005, 2026-10-04)
- **Emulating a browser restart under Playwright:** persistent profile dir + a copy-once extension root (manifest check before re-copy) gives the SAME derived extension id across `launchPersistentContext` calls, so IndexedDB state (consents, jobs) survives; add `--host-resolver-rules="MAP <provider-origins> 127.0.0.1"` so a resume attempt that races route registration can never become real egress. A browser restart subsumes the MV3 worker restart no API can trigger on demand. The temp dirs need an explicit `dispose()` — the launcher's own cleanup deliberately skips caller-owned roots. (from: phase4_jev_decisions_20260927)
- **Popup prefill under Playwright needs `tabs` injected and `bringToFront` ordering:** production prefills via `activeTab`, which Playwright cannot grant — patch the copied manifest to add `tabs` and use `chrome.tabs.query`. Create the HTTPS page, then `context.newPage()` STEALS the active-tab slot: `bringToFront()` the HTTPS page AFTER creating the popup page but BEFORE `popup.goto(chrome-extension://…)` or the prefill reads the wrong tab. (from: phase4_jev_decisions_20260927)

### Perf gates and harness honesty

- **A perf gate must disclose and pin what its harness bypasses.** Mocking `sendConsented` removes the egress gate AND the only sentLog writer from the measured path — document it in the header and pin it (`expect(sentLog.count()).toBe(0)`) so the bypass is a tested fact. Gate on the WORST measured run (a slow save is a user-facing miss), warm up JIT/Dexie separately, and seed at the sibling gate's corpus scale so quadratic regressions trip. (from: phase4_jev_decisions_20260927)
- **Assertions inside a timed run must run AFTER the clock stops** (capture `elapsed` first, then `expect`) so assertion cost never pollutes timing; and a fast FAILURE must not pass — assert `ok:true` + exact request counts + decision counts each iteration. (from: phase4_jev_decisions_20260927)

### Decisions-layer contracts worth remembering

- **The job runner is strictly sequential per bookmark within a batch**
  (`for … await`); batch-commit progress (`committedBatches`) is the resume
  boundary. Sent-log insertion starts at each actual dispatch, including
  held/failed requests. Await completed outcomes, not obsolete response-time
  row counts. Pending/legacy outcomes are unknown, not evidence of success.
  (from: phase4_jev_decisions_20260927, deep_audit_fixes_20261005, 2026-10-04)
- **`INTRANET_SUFFIXES` in `src/decisions/minimize.ts` blocklists `.example`/`.test`/`.local` and friends** — seed data for any decisions test must use a public-looking TLD (`.dev` works). MiniSearch query terms are strict-AND across fields: every expected hit needs every term. (from: phase4_jev_decisions_20260927)

## Elevated from track `phase6_store_release_20260928` (2026-09-28)

- **Release gates should report all violations in one run** so CI output is actionable and each check can be asserted independently.
- **Store/site policy validation should use a required-field floor, not byte equality** — presentation may differ while release-critical disclosures remain equivalent.
- **Generate release assets and archives deterministically from committed sources** so the recorded ZIP checksum and visual materials are reproducible.
- **A release record must bind source commit, archive size, and SHA-256**; the record is a validation artifact, not a post-it.
- **Key-gated live/eval suites must record exact model IDs, skipped surfaces, and pass/skip counts** rather than implying unexecuted provider coverage.

## Elevated at archive — track `options_redesign_20260929` (2026-09-29)

- **`<details>` as a named region:** put `role="region"` + `aria-label` on
  the inner content div, not the `<details>` element — jsdom renders closed
  `<details>` content to text queries but the role belongs on the wrapper.
- **`findByText` returns the innermost text owner** — when a test asserts
  `role`/`id`/`aria-describedby` linkage on a warning, those attributes must
  live on the element that directly wraps the text, not its parent.
- **`chrome.runtime.getManifest()` throws (ReferenceError) under jsdom** —
  guard behind try/catch and render nothing when absent.
- **Radix Switch = `button[role=switch]` + `aria-checked`** — checkbox tests
  migrating to switches must use `getByRole("switch")` and `aria-checked`,
  not `.checked`.
- **Splitting run-on metrics into stat tiles breaks `findByText` sentence
  assertions** — label the aggregate `<dl>` (`aria-label`) and assert tile
  values inside it.
- **`@font-face` URLs in `src/ui/styles.css` resolve through Vite into
  `.output` assets automatically** for woff2 vendored under `src/` — no
  manifest or `web_accessible_resources` entry needed on extension pages.

## Consolidated at refresh (2026-09-30)

- **Custom provider URLs share one canonical policy.** Reuse `LlmBaseUrl` for Jev and LLM: HTTPS, HTTP only for literal `LOOPBACK_HOSTS`, no userinfo/query/fragment, and no noncanonical or doubled-slash paths. The broad optional host capability is not authorization to send to an arbitrary destination. (from: phase5_llm_layer_20260928, custom_jev_provider_20260929, 2026-09-30)
- **Consent follows the resolved exact origin.** Chrome host patterns cannot encode ports, so the gate must enforce scheme/host/port itself. Changing a custom origin needs that origin's current consent; previous origin grants remain durable. Resolve the destination before deleting settings during revoke, then remove consent before other cleanup. Neither message fields nor consent rows may redirect a preset. (from: phase5_llm_layer_20260928, custom_jev_provider_20260929, 2026-09-30)
- **Unknown cost is not zero.** Keep reported, estimated, and unknown amounts distinct. Reserve before LLM spending using a numeric pricing snapshot; automatic unpriced requests fail closed, while unpriced manual requests require explicit confirmation and are not covered by a numeric cap. Settle reservation and usage atomically/idempotently; derive UTC-month membership from parsed dates, not timestamp prefixes. (from: phase3_jev_client_20260927, phase5_llm_layer_20260928, 2026-09-30)
- **Structured-output fallback is capability-only.** Descend `json_schema → json_object → prompt_only` only for `LlmCapabilityError`, never for malformed output or exhausted repairs. Repairs stay on the chosen tier; merge tier instructions into an existing leading system message. (from: phase5_llm_layer_20260928, 2026-09-30)
- **Live reads preserve identity and pending state.** `useLiveQuery` can retain an old dependency's result: emit `{arg, value}` and treat an argument mismatch as pending. Initial `undefined` is not settled absence (`null`); disable actions until the first read settles and render settled failures instead of perpetual loading. (from: phase4_jev_decisions_20260927, options_redesign_20260929, 2026-09-30)
- **Resumption respects durable inputs and user intent.** Persist parameters
  affecting batch boundaries and resume from committed progress. Cold startup
  atomically pauses interrupted `running`/`pending` jobs and invalidates their
  old authority without provider egress. Explicit messages await recovery;
  Resume continues durable progress. Persist vetted proposals/assignments so
  resume does not repeat the LLM proposal. Same-session eviction recovery is a
  separate, session-owned mechanism, never an implicit cold-start send.
  (from: phase4_jev_decisions_20260927, phase5_llm_layer_20260928,
  deep_audit_fixes_20261005, 2026-10-04)
- **Summary egress is a separately consented exception.** Notes remain unsent; page text leaves only after explicit Summarize under `llm_summary` and `jev_summary_verify`, not as ordinary analyze input. Match extraction to the bookmark and persist only after Jev returns `supported`. (from: phase5_llm_layer_20260928, 2026-09-30)
- **Metadata extensions must survive repository rewrites.** A new optional field must join `MetaFields`, `isEmptyMeta`, `commitMeta`, `putMeta`, `patchMeta` merging, and `rewriteTagRows` emptiness checks; a schema-only addition can compile while silently losing data. (from: phase5_llm_layer_20260928, 2026-09-30)
- **Schema validity does not establish semantic validity.** Cross-check answers against sent keys/candidates and declared ranges. The Jev client enforces response-model consistency across batches; evaluations separately enforce accepted release model IDs and score production policy outcomes with production confidence helpers. (from: phase0_foundation_20260925, phase3_jev_client_20260927, phase4_jev_decisions_20260927, phase6_store_release_20260928, 2026-09-30)

## Consolidated at refresh (2026-09-30, starter tags + categories)

- **Category enum expansion is a multi-surface contract.** A new `Category` value must land in `src/schemas/bookmark.ts`, the Jev `categorize` option docstring (`src/jev/tasks/categorize.ts`), search unknown-category error text, `category-select.tsx`, and `PROJECT_PLAN.md` §7/§8.4 in the same change — schema-only additions desync Jev prompts, suggestions, and docs. (from: categories follow-up, 2026-09-30)
- **One-shot library seeding uses a durable `prefs:*` flag plus emptiness.** Like `prefs:lastFolderId`, store the decision in Dexie `metadata`; write the flag on *any* outcome (seeded or skipped) so deleting the pack later never re-injects. Keep the seeder total (catch → no-op) and fire-and-forget from `background.ts` so startup cannot crash on optional content. (from: starter-tags follow-up, 2026-09-30)
- **Tag `description` is Jev-facing meaning, not UI chrome.** ≤300 chars and concrete enough for the `tags` question set; the same field is what Options/TagManager show as help text. (from: starter-tags follow-up, phase1_core_manager_20260926, 2026-09-30)

## Elevated from track `audit_hardening_20261001` (2026-10-01)

- **Native-authority metadata rewrites need guarded compensation.** A restructure/undo that rewrites metadata on live native nodes must treat a failed inverse move or failed child read as "not empty": remove a created folder only after a successful empty-child read (Chrome's non-recursive remove then fails safely on a racing child), preserve the recoverable snapshot, and persist an ID remap so recreated nodes resume under new IDs. Treating every native ID-lookup rejection as absence can duplicate a still-live bookmark — distinguish confirmed-missing from transient failure. (from: audit_hardening_20261001, 2026-10-01)
- **Cross-context undo uses one origin-scoped exclusive Web Lock.** Wrap read/replay/pop/discard in `navigator.locks.request("bookmarks-manager:undo", { mode: "exclusive" })`; a per-instance `holdDepth` join lets same-context callers re-enter without re-acquiring the non-reentrant platform lock. A module-local promise tail orders same-context calls but is NOT a missing-lock fallback — absent/rejected/aborted locks refuse typed (`conflict`, mapped to decision `undo_conflict`) with zero mutations. A targeted `undoExpected(snapshotId)` verifies the head inside the lock so a checked head cannot be lost to another context. (from: audit_hardening_20261001, 2026-10-01)
- **Reservation lifetime must outlive provider revoke, and settle per attempt.** Revoke removes consent first, then permission/settings/key, but keeps active reservations so an already-sent response settles exactly once from its pricing snapshot. Each attempted send settles its own reservation before another paid retry is admitted; missing token dimensions settle from the reservation bound (unknown without prices), so later success or a reported zero can never erase earlier paid exposure. Age is not proof a send was free. (from: audit_hardening_20261001, 2026-10-01)
- **One MV3 worker owns a job through its current batch.** Key the drive promise by job ID (`coordinateJob`) so starts/resumes/startup scans coalesce; claim a durable `ownerGeneration` transactionally and guard every progress/status/assignment write against owner mismatch and terminal state. Carry the captured authority into every actual paid attempt (analysis, pairs, escalation, queued/retry) — entry-point checks alone miss later callbacks; drain sibling wire batches before releasing ownership and start no new work for a canceled or superseded owner. (from: audit_hardening_20261001, 2026-10-01)
- **Bounded deterministic pair planning, never a claimed exhaustive top-K.** Cap emitted pairs (500) and candidate comparisons (50,000), build candidates from a domain + inverted-token index in sorted ID order instead of enumerating every normalized-duplicate pair, cap attempts before scoring, and set `truncated`. Persist the resolved content-free plan (pair IDs + planner limits/version) on the job and execute the STORED plan on resume so edited titles cannot shift offsets; fail typed for a plan-less committed scan rather than reinterpreting ambiguous offsets. (from: audit_hardening_20261001, 2026-10-01)
- **Coalesce native event bursts into one in-flight read plus one dirty trailing read.** Keep the initial read immediate, route later events through a fixed window (50 ms), allow one tree read in flight, queue exactly one dirty trailing read, and keep generation/cancellation guards; a failed read keeps the previous model and waits for a new event (no spin). Unmount clears the timer and every listener. (from: audit_hardening_20261001, 2026-10-01)
- **A selective search-index cache keys each document by a corpus signature.** Reuse unchanged documents by comparing a signature over every indexed input, invalidate a folder's descendants on rename/move and tag-label dependents when definitions change, and rerun duplicate grouping only when an order-insensitive `id→url` map changes; recompute tree order every update and keep the index identity stable. (from: audit_hardening_20261001, 2026-10-01)
- **Bounded synthetic retention is popup-only and transactional.** Prune only rows whose bookmark IDs are all synthetic and whose status is safe (pending/unsure), oldest-first with a stable id tie-break, in one read-write transaction; never delete applied/audit/undo or mixed/real rows. Run the sweep fail-soft (startup fire-and-forget with an attached catch, plus a post-save sweep). (from: audit_hardening_20261001, 2026-10-01)

## Elevated from follow-up fixes (2026-10-01, post-audit)

- **Consent gating should not punish agreeing early.** When a user checks a
  consent box before reading the linked disclosure, reveal/open and scroll
  to that disclosure while preserving the affirmative checkbox action.
  A bare feature invocation is not consent; its disclosure approval remains
  separate. (from: BookmarksManager-8qf, deep_audit_fixes_20261005, 2026-10-04)
- **Popup save-suggest is a read model over decision rows, not a chip filter.** Render every tag chip independently of the confidence policy (a `noul` in `[0.5, 0.75)` must not hide siblings), and bound the rows lifecycle-side so repeated saves cannot accumulate unbounded decisions. (from: BookmarksManager-dm1, -f7c, 2026-10-01)
- **Focus styling on a text input must not read as a boxed field.** A focus ring/border on the popup title input was mistaken for an editable box regression — when styling focus, prefer the surrounding affordance over a boxed border on the input itself. (from: popup title-input fix, 2026-10-01)
- **Prerequisite-gated controls soft-block, not hard-disable.** A hard-disabled switch hides *which* prerequisite is missing and can trap an enabled control when a prerequisite later breaks. Keep it focusable with `aria-disabled`, render every unmet prerequisite at once through `aria-describedby` with its own action (disclosure reveal, jump to the provider/budget anchors), route a click on the blocked control to the first unmet step instead of toggling, and never block the OFF direction. (from: BookmarksManager-ky2, 2026-10-01)

## Elevated from `deep_audit_fixes_20261005`, Phase 1 (2026-10-04)

- **Unset policy is not unreadable policy.** Throw a typed content-free refusal
  for malformed/unreadable persisted blocklists; recheck in every gate and
  attempt before sensitive reads or reservations. Filter synopsis descendants
  before caps, then re-admit all local source provenance, not just the capped
  outbound domain list.
- **Authority must survive every await through actual dispatch.** Retain
  accepted recipient/model/endpoint/version plus source/document identity;
  compose final callbacks into both real gates after asynchronous preflight.
  Repairs/fallback/retries need the same authority. Do not add an awaited log
  write between final privacy admission and fetch.
- **Share pure closed prompt contracts, not feature services with gates.**
  Canonical payload/system/schema/tier contracts prevent producer/guard drift
  and cycles. Only a private input-bound session reading its actual response
  authorizes provider echoes; test transport injection stays in test helpers.
- **URL minimization never changes local resource identity.** Strip matrix
  parameters and redact long opaque segments only on outbound copies. Inspect
  raw paths as well as parser-normalized paths at independent admission.
  Bound percent-decoding work; unresolved encodings fail closed. Explicitly
  reject over-limit strings before Zod refinements do expensive work.
- **Audit outcomes are best-effort dispatch metadata, not proof of billing.**
  Preserve failed attempts and unknown pending/legacy rows; fail-soft append/
  finishing cannot change results or recreate cleared rows. A killed worker
  can lose an uncommitted insert or leave an unknown outcome.
- **Make race tests control the boundary they claim to cover.** Defer IO until
  after dismissal, or await the settled error before Cancel. A failure arriving
  before dismissal is as important as one arriving after it; preserve both
  until an explicit retry.
- **Separate host pressure from regressions without weakening budgets.**
  Record failed full invocations honestly; verify unchanged source/fixtures
  and control worker count/affinity. A passing focused rerun is not a passing
  full gate. Exact indexed snapshots validate isolated shared-file commits.

## Elevated from `deep_audit_fixes_20261005`, Phases 2–7 (2026-10-05)

- **Reservations must cover the real serialized payload, not a declared estimate.** Compute `max(declared, ceil(len/4 × 1.25))` after admission so unserializable inputs still fail typed before any network. Capability-probe rejections settle `not_billed` (0 tokens, excluded from the cap) — a provider's pre-response refusal is not a billing event, while timeouts/5xx/non-JSON-200 keep conservative billing. Record usage before any answer/level cross-check so semantically bad responses still pay.
- **Per-item failures are data, not job state.** Record them to a capped ring and skip; make `failed` a resumable status from `committedBatches`, filter deleted ids only in the uncommitted tail, and complete an empty work set instead of stranding it `running`. Persisted throttle breakers (N consecutive `retry_later` → `openUntil`) are waited out in MV3-safe ≤15s chunks, honoring pause/cancel at every item boundary.
- **Deterministic ids turn replays into upserts.** `SHA-256(jobId|sortedIds|kind)` for decision ids means a replayed batch supersedes undecided rows and never overwrites a decided one. Pair with a send-time-snapshot guard (`assertFresh` on url/title) and a token-verified claim sidecar with TTL — concurrent approves get an honest `claimed` code, not a double apply.
- **Undo/lock state needs tokens, origins, and positional reads.** Origin-tagged snapshots with per-origin caps never evict rows referenced by live decisions; peek walks a reverse cursor instead of validating the stack; capture+mutate run in ONE Dexie tx so a failed mutation rolls back its snapshot; an `UndoLockHold` token replaces module-global depth so only a live token joins a hold.
- **Resumable import is write-ahead queue + per-item cursor rows, not a job-row rewrite.** A small per-item state row avoids O(N²) rewrites; cancel needs two channels (AbortSignal + persisted status for cross-context); resume requires a single-flight `claimedBy` claim.
- **UI busy-guards need synchronous re-entrancy refs cleared in `finally`.** A late-arriving result carries a run-id guard; Esc/overlay/X are inert while working; portaled menus bubble through the React tree but fail DOM `contains` — guard listbox keys by containment; ignore held-key repeat on destructive keys.
- **Settings writes are patches merged worker-side under a serialized write chain.** Two stale tabs can't clobber each other; patch schemas need explicit optional fields (a `.partial()`-with-defaults schema re-injects fields into the patch). A host grant arriving after the user switched presets must be *removed* before the stale reply drops.
- **Fail-closed privacy, warn-don't-block UX.** `isNonPublicUrl` marks localhost/RFC1918/link-local/intranet/hostless as non-public — a custom provider URL matching it warns visibly but still saves. Sanitizers applied at output AND re-applied idempotently at the persist boundary; never silently truncate — re-parse so existing limits fail honestly.
- **A wire-level regression sweep needs three independent egress channels.** Playwright routing may not rebind to an already-running service worker on a persisted-profile relaunch — pair routed capture + `context.on("request")` journal + in-realm `self.fetch` counter that both records AND fail-closed rejects, plus `--host-resolver-rules` MAP→127.0.0.1 so an unobserved escape still dies locally. An unfulfilled route makes the ~30s runtime itself the timeout proof.

## Elevated at refresh — public store cut + handoff (2026-10-07)

- **A store listing summary comes from the package manifest, not the dashboard.** The Chrome Web Store derives the summary from the manifest `description`; a package that ships none shows an *empty* summary in the draft listing until the package is re-uploaded. Keep one source of truth (`store/listing.md` short description) mirrored into `wxt.config.ts` (126 chars observed against Chrome's 132 cap) and re-cut the release record after changing it — a manifest edit invalidates the recorded ZIP. **Not yet enforced**: neither `check-manifest.mjs` nor `check-store.mjs` reads `description`, and no test covers the parity, so it can silently drift.
- **Retiring a gate requirement is a RED→GREEN change with a doc sweep.** Dropping the promo-video check meant editing `scripts/check-store.mjs` and its unit test *first*, then chasing every downstream claim: the deleted `store/video-script.md`, the listing bullet, the public checklist row, and the `tech-stack.md`/`product.md` descriptions of what the gate covers. A stale "the gate passes except X" sentence outlives the gate itself.
- **Superseding a release record orphans its old pointers.** `store/releases/<v>.json` is a single mutable file, so re-cutting 1.0.0 (trusted-tester 412,893 → public 590,038 → description-carrying 590,115 bytes) left `product.md` and `1.0.0-checklist.md` citing a sha256 that no longer existed anywhere but git history. When a record is superseded, either annotate the citing docs with the commit that holds the old value or state plainly that it lives only in history.
- **A private repo on the free plan cannot serve GitHub Pages.** Enabling Pages required flipping the repository to PUBLIC first; the Pages API returns `build_type: workflow` with `source.branch` even before a successful deploy, so verify by fetching the live URL (HTTP 200 on root *and* `/privacy/`) rather than trusting the config read.

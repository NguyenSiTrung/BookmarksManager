# Dialogs: Import drop zone, left-aligned copy, plain-language scan cost

Date: 2026-09-29
Status: approved in chat, pending written-spec review
Scope: sub-project 4 of the UI redesign (sub-projects 1–3 — theme, shell,
side panel content — are done; see the other specs in this directory).

## Goal

Bring the dialogs up to the redesigned panel's standard: copy left-aligned
at side panel widths, an Import picker built for dragging files onto it, a
scan cost line in plain units, and the one off-theme dialog moved onto the
shared dialog primitive.

## Part 1: Left-aligned dialog copy

File: `src/ui/components/dialog.tsx`.

`DialogHeader` drops `text-center sm:text-left` and becomes `text-left`.
Below 640 px — every side panel width — dialog titles and descriptions are
centered today; after this they are left-aligned at all widths, matching the
panel's content. Every Radix dialog surface inherits the fix; no dialog file
changes for this. `DialogFooter` stacking stays as is.

## Part 2: Import drop zone

Files: new `src/ui/components/drop-zone.tsx`,
`src/entrypoints/sidepanel/ImportDialog.tsx` (pick stage only).

- The pick stage's labelled file input becomes a themed drop zone: a
  dashed-border box with a down-into-tray inline SVG (`FileImportIcon`, the
  `Icon` wrapper in `src/ui/components/icons.tsx`), the line "Drop your
  bookmarks file here" and the hint
  "or click to browse — JSON, Netscape HTML, or CSV · up to 20 MiB".
  Drag-over swaps the border/background to accent and the line to
  "Drop to import". Theme tokens only.
- The real `<input type="file">` stays inside the zone, visually hidden,
  keeping `data-testid="import-file-input"` and its `accept` list, so the
  e2e and component tests drive it exactly as today. The zone is a real
  `button` (Enter/Space open the OS file picker by clicking the hidden
  input).
- Detection, parsing, preview, import and summary are untouched: a dropped
  file follows today's `handleFile` path, and the preview/summary stages
  render unchanged.
- New up-front guard: a file with any extension other than `.json`, `.html`,
  `.htm`, `.csv` or `.txt` fails fast with "That doesn't look like a
  bookmarks file — use JSON, Netscape HTML, or CSV." instead of a CSV
  parser error. Files with no extension, and the allowed extensions, keep
  today's content-sniff fallback, so a renamed export still parses.
- While the pick stage is showing, `ImportDialog` cancels stray
  `dragover`/`drop` events on the dialog root, so a drop that misses the
  zone does nothing rather than navigating the page to the file.
- The "Bookmarks file" label and the formats hint paragraph are removed
  (the zone carries both); the `DialogHeader` description is unchanged.

## Part 3: Plain-language scan cost

File: `src/entrypoints/sidepanel/ScanPanel.tsx` (copy only).

- Pre-start line: `12 bookmarks · at least 3 AI requests (~4,200 tokens,
  likely more)`. The figure is the bookmark-batch count from
  `estimateJobCost` and is a lower bound on requests, not a promise: a
  library scan also runs a near-duplicate pair phase whose request count
  depends on the library and the scan-duplicates setting, so it cannot be
  known before the job row exists. The running card's counts come from the
  job row and are exact. The empty-library line stays.
- Running usage line: `2 requests · $0.0123 so far · ~2,440 tokens used`
  (input + output summed, `~` marking the estimate). When the provider
  reported no cost, the dollar figure is omitted as today — never a
  made-up $0.00 — and the separators adapt.
- Progress line: `10 bookmarks processed (50%)`. The batch counters leave
  the line (the request total now lives in the usage line) and no total is
  invented — the job row stores batches, not a bookmark total.
- Status labels, controls, and all job/Dexie/message logic are unchanged.

## Part 4: CostConfirmationDialog onto the shared primitive

File: `src/ui/components/CostConfirmationDialog.tsx`.

- Rebuilt on `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/
  `DialogDescription`/`DialogFooter` with theme tokens (fixes dark mode,
  which the current `bg-white`/`bg-blue-600`/`text-gray-700` ignores).
  `showCloseButton={false}`; Escape and overlay click close the dialog,
  which maps to `onCancel` — the safe action. The cancel button is focused
  on open (explicit ref focus, as today), so Enter cannot confirm.
- Props are unchanged — `open`, `featureLabel`, `destinationOrigin`,
  `onConfirm`, `onCancel` — so `ReviewView`, `SummaryDialog` and
  `RestructureView` need no edits.
- Copy:
  - Title: **Send without a cost estimate?**
  - Body: "The provider at `<origin>` has no pricing configured, so the
    cost of “<featureLabel>” can't be estimated beforehand. The actual
    cost is only known if the provider reports it after the request."
  - Second line: "You'll be asked again for each request — this approval
    isn't saved."
  - Buttons: "Don't send" (secondary, focused) and "Send anyway"
    (primary). Button labels are unchanged so e2e flows stay green.
- Safety invariants preserved: the exact destination origin is named,
  there is no "always allow" affordance, nothing persists a bypass, and
  each request is confirmed individually.

## Testing

- Component: `DropZone` renders its line and hint, highlights on
  drag-over, routes a dropped file and a picked file to `onFile`, and
  opens the picker from its button; `ImportDialog` reaches the preview
  from a dropped JSON, keeps its existing input-change flow, and shows
  the friendly error for a disallowed extension; `ScanPanel` assertions
  move to the new copy (requests first, tokens secondary, dollar omitted
  without cost, progress without batch counters) with behavioural
  assertions untouched; `CostConfirmationDialog` renders the new copy,
  focuses "Don't send" on open, and cancels on Escape and overlay click.
- Existing tests change only where the copy above changed
  (`scan-panel.test.tsx`, `cost-confirmation-dialog.test.tsx`).
- e2e: the `core-manager` import flow keeps passing through the unchanged
  `import-file-input` testid; `decisions` keeps passing through the
  unchanged button labels.
- Manual capture at 360, 480 and 1280 px: Import pick (plus drag-over and
  preview), Export, Edit, Move to…, CostConfirmation in light and dark,
  and the ScanPanel estimate and running lines. Report defects before any
  store-screenshot regeneration (regenerate only if a store asset shows a
  dialog).
- Gates: `npm run lint`, `typecheck`, `build`, the `check:*` scripts, unit
  and component suites, and the `shell`, `core-manager` and `decisions`
  e2e specs.

## Out of scope

- Options and popup polish (the next sub-project).
- Extracting a shared Button component from the dialogs' button classes.
- `DialogFooter` stacking, dialog widths, or any data flow, job, or
  message-protocol change.

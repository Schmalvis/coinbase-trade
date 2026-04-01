# Bulk Asset Enable/Dismiss — Design Spec

**Date:** 2026-04-01
**Status:** Approved

---

## Problem

Alchemy ERC20 discovery surfaces many tokens (spam airdrops, unknown contracts) as `pending` assets. Currently each must be enabled or dismissed one at a time. With a large backlog this is tedious.

---

## Solution

Add per-row checkboxes to the assets table (pending rows only), a Select All header checkbox scoped to pending rows, and a floating action bar that appears when any rows are selected with **Enable Selected** and **Dismiss Selected** bulk actions.

---

## Backend

### New endpoints in `src/web/routes/assets.ts`

**`POST /api/assets/bulk-enable`**
- Body: `{ addresses: string[] }`
- Runs a single DB transaction: for each address, call `discoveredAssetQueries.enableAsset` only if the asset's current status is `'pending'`
- Returns: `{ succeeded: number, skipped: number }`
- Skips (does not error on) addresses that are already `active` or `dismissed`

**`POST /api/assets/bulk-dismiss`**
- Same shape and behaviour, calls `discoveredAssetQueries.dismissAsset` instead
- Returns: `{ succeeded: number, skipped: number }`

Both endpoints reuse existing per-asset DB queries inside a `runTransaction` wrapper — no new schema or query changes needed.

---

## Frontend

### `AssetsTable.svelte` changes

- Add `let selected = new Set<string>()` (addresses of checked pending rows)
- Each row with `status === 'pending'` renders a checkbox in a leading column; active/dismissed rows render an empty cell for alignment
- Header row: "Select All" checkbox with three states:
  - **Checked** — all pending rows selected
  - **Indeterminate** — some pending rows selected
  - **Unchecked** — none selected
  - Clicking it selects all pending rows if any are unselected, otherwise deselects all
- After a bulk action completes, clear `selected` and call `loadAssets()` to refresh

### New `BulkActionBar.svelte` component

- Fixed position at the bottom of the viewport (`position: fixed; bottom: 0`)
- Hidden (`display: none`) when `selected.size === 0`, slides in when selection is non-empty
- Content: "X assets selected" label | **Enable Selected** button | **Dismiss Selected** button
- On click:
  1. Disable both buttons (loading state)
  2. POST to relevant bulk endpoint with `{ addresses: [...selected] }`
  3. On success: clear selection, refresh assets, show brief toast/status (e.g. "17 dismissed")
  4. On error: re-enable buttons, show error message
- Sits above any other fixed UI (z-index above dashboard footer/nav)

---

## Out of Scope

- Bulk strategy configuration (select many, set strategy) — separate feature
- Filtering/sorting the pending list — separate feature
- Undo — dismissed assets can be found via the DB directly if needed; not surfaced in UI


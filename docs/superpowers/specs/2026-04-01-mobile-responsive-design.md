# Mobile Responsive Dashboard — Design Spec

**Date:** 2026-04-01
**Status:** Approved

---

## Problem

The dashboard is unusable on mobile. The top navigation bar overflows with too many items in a single row, and the AssetsTable's 9-column layout cannot fit on a phone-width screen. Sections are truncated or clipped.

Primary use case on mobile is **monitoring** (read-only: prices, status, strategy) — not acting.

---

## Scope

Three files. No logic changes, no new components, no store changes. Pure Tailwind CSS responsiveness.

---

## Changes

### 1. `src/frontend/src/App.svelte` — top bar

Change `<header>` from single-row `flex` to `flex-col sm:flex-row` so title and controls stack vertically on mobile and sit side-by-side on `sm+` (≥640px).

Add `flex-wrap` to the right-side controls group so items wrap rather than clip if still tight.

Reduce button padding on mobile: `px-2 py-1 sm:px-3 sm:py-1.5`.

### 2. `src/frontend/src/lib/components/NetworkSelector.svelte` — abbreviated names

Strip the `base-` prefix and capitalise on mobile screens. "base-mainnet" → "Mainnet", "base-sepolia" → "Sepolia".

Implementation: compute `shortName = network.replace('base-', '').replace(/^\w/, c => c.toUpperCase())` per button. Render two spans:
- `<span class="hidden sm:inline">{network}</span>` — full name on desktop
- `<span class="sm:hidden">{shortName}</span>` — short name on mobile

Buttons and click handlers unchanged.

### 3. `src/frontend/src/lib/components/AssetsTable.svelte` — column hiding

Add `hidden sm:table-cell` to the `<th>` and every corresponding `<td>` for four columns: **Balance, Value, Weight, Score**.

Add `hidden sm:inline` to the asset name span (the secondary grey text after the symbol) — symbol remains visible.

Mobile shows 5 columns: checkbox, Asset (symbol), Price, 24H, Strategy.
Desktop shows all 9 columns unchanged.

`colspan="9"` on the expanded `AssetConfigPanel` row is unchanged — it correctly spans the full table width regardless of hidden columns.

---

## Out of Scope

- CandleChart — header uses `justify-between`, already handles narrow screens
- HoldingsGrid, PerformancePanel, RiskMonitor, ScoresPanel — already use `grid-cols-2` responsive breakpoints
- ActionButtons — already uses `flex-wrap`
- SettingsModal / TradeModal — separate concern, not addressed here
- Full mobile card layout for AssetsTable — deferred (Option B from brainstorm)

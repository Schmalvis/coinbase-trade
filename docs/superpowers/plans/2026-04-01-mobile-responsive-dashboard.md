# Mobile Responsive Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the trading bot dashboard usable on mobile by fixing the top navigation bar and hiding secondary table columns on small screens.

**Architecture:** Pure Tailwind CSS responsiveness — no logic changes, no new components, no store changes. Three files modified with `sm:` breakpoint classes (≥640px). No tests exist or are needed for CSS-only changes; verification is a successful `npm run build` in the frontend directory.

**Tech Stack:** Svelte 4, Tailwind CSS, Vite

---

## Files

- Modify: `src/frontend/src/App.svelte` — top bar layout
- Modify: `src/frontend/src/lib/components/NetworkSelector.svelte` — abbreviated network names on mobile
- Modify: `src/frontend/src/lib/components/AssetsTable.svelte` — hide secondary columns on mobile

---

### Task 1: Top bar — stack vertically on mobile

**Files:**
- Modify: `src/frontend/src/App.svelte`

These are CSS-only changes. No tests. Verify with a build after implementing.

- [ ] **Step 1: Update the `<header>` element class**

Find this line in `src/frontend/src/App.svelte`:
```html
<header class="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
```

Replace with:
```html
<header class="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 gap-2 border-b border-[var(--border)]">
```

- [ ] **Step 2: Update the right-side controls container**

Find:
```html
    <div class="flex items-center gap-3">
```

Replace with:
```html
    <div class="flex items-center gap-2 flex-wrap">
```

- [ ] **Step 3: Update Settings button padding**

Find:
```html
      <button
        class="px-3 py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        on:click={() => { settingsOpen = true; }}
      >Settings</button>
```

Replace with:
```html
      <button
        class="px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        on:click={() => { settingsOpen = true; }}
      >Settings</button>
```

- [ ] **Step 4: Update Logout button padding**

Find:
```html
      <button
        class="px-3 py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-red-400 transition-colors"
        on:click={handleLogout}
      >Logout</button>
```

Replace with:
```html
      <button
        class="px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-red-400 transition-colors"
        on:click={handleLogout}
      >Logout</button>
```

- [ ] **Step 5: Verify build passes**

```bash
cd /home/pi/share/coinbase-trade/src/frontend && npm run build
```

Expected: build completes with no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/pi/share/coinbase-trade
git add src/frontend/src/App.svelte
git commit -m "feat: stack top bar vertically on mobile"
```

---

### Task 2: NetworkSelector — abbreviated names on mobile

**Files:**
- Modify: `src/frontend/src/lib/components/NetworkSelector.svelte`

Network names like "base-mainnet" and "base-sepolia" are too long for the mobile top bar. On mobile (`< sm`), show "Mainnet" and "Sepolia" instead. Desktop shows full names unchanged.

- [ ] **Step 1: Update the button content in the `{#each}` block**

Find this section in `src/frontend/src/lib/components/NetworkSelector.svelte`:
```html
<div class="flex items-center gap-1">
  {#each networks as network}
    <button
      on:click={() => select(network)}
      class="px-3 py-1 rounded-lg border text-sm font-medium transition-colors
        {network === active
          ? 'border-accent-green text-accent-green'
          : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}"
    >
      {network}
    </button>
  {/each}
</div>
```

Replace with:
```html
<div class="flex items-center gap-1">
  {#each networks as network}
    {@const shortName = network.replace('base-', '').replace(/^\w/, (c) => c.toUpperCase())}
    <button
      on:click={() => select(network)}
      class="px-2 py-1 sm:px-3 rounded-lg border text-sm font-medium transition-colors
        {network === active
          ? 'border-accent-green text-accent-green'
          : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}"
    >
      <span class="hidden sm:inline">{network}</span>
      <span class="sm:hidden">{shortName}</span>
    </button>
  {/each}
</div>
```

- [ ] **Step 2: Verify build passes**

```bash
cd /home/pi/share/coinbase-trade/src/frontend && npm run build
```

Expected: build completes with no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/pi/share/coinbase-trade
git add src/frontend/src/lib/components/NetworkSelector.svelte
git commit -m "feat: abbreviate network names on mobile in NetworkSelector"
```

---

### Task 3: AssetsTable — hide secondary columns on mobile

**Files:**
- Modify: `src/frontend/src/lib/components/AssetsTable.svelte`

On mobile (`< sm`), hide Balance, Value, Weight, Score columns. Hide asset name text (keep symbol). Mobile shows 5 columns: checkbox, Asset (symbol), Price, 24H, Strategy.

- [ ] **Step 1: Hide Balance, Value, Weight, Score header cells**

Find the `<thead>` section:
```html
        <th class="px-4 py-2 text-right">Balance</th>
        <th class="px-4 py-2 text-right">Value</th>
        <th class="px-4 py-2 text-left">Weight</th>
        <th class="px-4 py-2 text-right">Score</th>
```

Replace with:
```html
        <th class="hidden sm:table-cell px-4 py-2 text-right">Balance</th>
        <th class="hidden sm:table-cell px-4 py-2 text-right">Value</th>
        <th class="hidden sm:table-cell px-4 py-2 text-left">Weight</th>
        <th class="hidden sm:table-cell px-4 py-2 text-right">Score</th>
```

- [ ] **Step 2: Hide asset name span (keep symbol visible)**

Find:
```html
            <span class="text-[var(--text-muted)] ml-1 text-xs">{asset.name ?? ''}</span>
```

Replace with:
```html
            <span class="hidden sm:inline text-[var(--text-muted)] ml-1 text-xs">{asset.name ?? ''}</span>
```

- [ ] **Step 3: Hide the Balance body cell**

Find:
```html
          <td class="px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatBalance(asset.balance)}
          </td>
```

Replace with:
```html
          <td class="hidden sm:table-cell px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatBalance(asset.balance)}
          </td>
```

- [ ] **Step 4: Hide the Value body cell**

Find:
```html
          <td class="px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatValue(value)}
          </td>
```

Replace with:
```html
          <td class="hidden sm:table-cell px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatValue(value)}
          </td>
```

- [ ] **Step 5: Hide the Weight body cell**

Find:
```html
          <td class="px-4 py-3 text-sm">
            <span class="text-[var(--text-primary)]">{weight.toFixed(1)}%</span>
            <div class="w-16 h-1 bg-[var(--border)] rounded-full mt-1 inline-block ml-1 align-middle">
              <div class="h-full bg-accent-blue rounded-full" style="width: {Math.min(weight, 100)}%"></div>
            </div>
          </td>
```

Replace with:
```html
          <td class="hidden sm:table-cell px-4 py-3 text-sm">
            <span class="text-[var(--text-primary)]">{weight.toFixed(1)}%</span>
            <div class="w-16 h-1 bg-[var(--border)] rounded-full mt-1 inline-block ml-1 align-middle">
              <div class="h-full bg-accent-blue rounded-full" style="width: {Math.min(weight, 100)}%"></div>
            </div>
          </td>
```

- [ ] **Step 6: Hide the Score body cell**

Find:
```html
          <td
            class="px-4 py-3 text-sm text-right font-semibold"
            class:text-accent-green={score != null && score > 0}
            class:text-accent-red={score != null && score < 0}
            class:text-[var(--text-muted)]={score == null || score === 0}
          >
            {score != null ? score.toFixed(1) : '--'}
          </td>
```

Replace with:
```html
          <td
            class="hidden sm:table-cell px-4 py-3 text-sm text-right font-semibold"
            class:text-accent-green={score != null && score > 0}
            class:text-accent-red={score != null && score < 0}
            class:text-[var(--text-muted)]={score == null || score === 0}
          >
            {score != null ? score.toFixed(1) : '--'}
          </td>
```

- [ ] **Step 7: Verify build passes**

```bash
cd /home/pi/share/coinbase-trade/src/frontend && npm run build
```

Expected: build completes with no errors.

- [ ] **Step 8: Commit**

```bash
cd /home/pi/share/coinbase-trade
git add src/frontend/src/lib/components/AssetsTable.svelte
git commit -m "feat: hide secondary columns on mobile in AssetsTable"
```

---

## Notes for implementer

- The `colspan="9"` on the expanded `AssetConfigPanel` row does **not** need changing — it correctly spans the full visible table width regardless of hidden columns.
- The `Balance` body `<td>` appears twice with identical markup — one is for balance (`formatBalance`), one for value (`formatValue`). They look identical so locate them by their **content** (`formatBalance` vs `formatValue`), not by class alone.
- The build command is `npm run build` run from `src/frontend/`, not the project root.
- Do not run `npm run build` from the project root for frontend verification — it runs tsc + esbuild for the backend. Use `cd src/frontend && npm run build` specifically.

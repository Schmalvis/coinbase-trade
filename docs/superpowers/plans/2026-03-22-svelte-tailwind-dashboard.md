# Svelte + Tailwind Dashboard Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vanilla JS dashboard with a Svelte + Tailwind CSS SPA, rewritten from scratch against the existing API contract.

**Architecture:** New Svelte project in `src/frontend/` built with Vite. Tailwind CSS with dark/light mode via `class` strategy. Outputs to `dist/web/public/`. Express serves the static build. Auth pages (login.html, setup.html) remain standalone. Zero backend changes.

**Tech Stack:** Svelte 4, Vite 5, Tailwind CSS 3, PostCSS, Chart.js, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-svelte-tailwind-dashboard-design.md`

---

## Execution Order

1. Task 1: Scaffold Svelte + Vite + Tailwind project
2. Task 2: API layer + Svelte stores
3. Task 3: App shell — Header, NetworkSelector, ThemeToggle
4. Task 4: AssetsTable + AssetConfigPanel (most complex component)
5. Task 5: CandleChart + ScoresPanel
6. Task 6: RiskMonitor + PerformancePanel
7. Task 7: SettingsModal + ActionButtons + HoldingsGrid
8. Task 8: Wire build pipeline, remove old frontend, update Dockerfile

---

## Task 1: Scaffold Svelte + Vite + Tailwind

**Files:**
- Create: `src/frontend/package.json`
- Create: `src/frontend/vite.config.ts`
- Create: `src/frontend/svelte.config.js`
- Create: `src/frontend/tailwind.config.js`
- Create: `src/frontend/postcss.config.js`
- Create: `src/frontend/tsconfig.json`
- Create: `src/frontend/index.html`
- Create: `src/frontend/src/main.ts`
- Create: `src/frontend/src/App.svelte`
- Create: `src/frontend/src/app.css`

- [ ] **Step 1: Create src/frontend/ directory and initialize**

```bash
mkdir -p src/frontend/src/lib/components src/frontend/src/lib/stores
```

- [ ] **Step 2: Create src/frontend/package.json**

```json
{
  "name": "coinbase-trade-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
cd src/frontend && npm install svelte@4 @sveltejs/vite-plugin-svelte@3 vite@5 typescript tailwindcss@3 postcss autoprefixer
```

- [ ] **Step 4: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../../dist/web/public',
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3003',
      '/auth': 'http://localhost:3003',
    },
  },
});
```

- [ ] **Step 5: Create svelte.config.js**

```javascript
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess() };
```

- [ ] **Step 6: Create tailwind.config.js**

```javascript
export default {
  content: ['./src/**/*.{svelte,ts,html}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { primary: 'var(--bg-primary)', card: 'var(--bg-card)', hover: 'var(--bg-card-hover)' },
        accent: { green: '#4ade80', red: '#f87171', blue: '#60a5fa', yellow: '#fbbf24' },
        'accent-dark': { green: '#16a34a', red: '#dc2626', blue: '#2563eb', yellow: '#d97706' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
```

- [ ] **Step 7: Create postcss.config.js**

```javascript
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 8: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "types": ["svelte"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 9: Create src/frontend/src/app.css** (global styles + theme vars)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg-primary: #f8f9fb;
  --bg-card: #ffffff;
  --bg-card-hover: #f3f4f6;
  --text-primary: #1a1a2e;
  --text-secondary: rgba(0,0,0,0.5);
  --text-muted: rgba(0,0,0,0.3);
  --border: rgba(0,0,0,0.08);
  --border-hi: rgba(0,0,0,0.15);
  --shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.dark {
  --bg-primary: #0c0c14;
  --bg-card: #13132a;
  --bg-card-hover: #1a1a35;
  --text-primary: #e2e8f0;
  --text-secondary: rgba(255,255,255,0.5);
  --text-muted: rgba(255,255,255,0.25);
  --border: rgba(255,255,255,0.05);
  --border-hi: rgba(255,255,255,0.1);
  --shadow: 0 1px 3px rgba(0,0,0,0.3);
}
body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: 'Inter', system-ui, sans-serif;
  margin: 0;
}
```

- [ ] **Step 10: Create index.html**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trade Bot</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.2.1"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 11: Create src/frontend/src/main.ts**

```typescript
import './app.css';
import App from './App.svelte';

const app = new App({ target: document.getElementById('app')! });
export default app;
```

- [ ] **Step 12: Create src/frontend/src/App.svelte** (minimal shell)

```svelte
<script lang="ts">
  let message = 'Dashboard loading...';
</script>

<main class="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-4">
  <h1 class="text-xl font-semibold">{message}</h1>
</main>
```

- [ ] **Step 13: Verify build**

```bash
cd src/frontend && npx vite build
ls ../../dist/web/public/index.html
```

- [ ] **Step 14: Commit**

```bash
git add src/frontend/
git commit -m "feat: scaffold Svelte + Vite + Tailwind frontend project"
```

---

## Task 2: API layer + Svelte stores

**Files:**
- Create: `src/frontend/src/lib/api.ts`
- Create: `src/frontend/src/lib/types.ts`
- Create: `src/frontend/src/lib/stores/status.ts`
- Create: `src/frontend/src/lib/stores/assets.ts`
- Create: `src/frontend/src/lib/stores/candles.ts`
- Create: `src/frontend/src/lib/stores/scores.ts`
- Create: `src/frontend/src/lib/stores/risk.ts`
- Create: `src/frontend/src/lib/stores/performance.ts`
- Create: `src/frontend/src/lib/stores/settings.ts`
- Create: `src/frontend/src/lib/stores/polling.ts`

- [ ] **Step 1: Create types.ts** — TypeScript interfaces for all API responses (StatusData, AssetData, CandleData, ScoreData, RiskData, PerformanceData, SettingsData). Model these from the existing Express route responses.

- [ ] **Step 2: Create api.ts** — Typed fetch wrappers for every API endpoint (fetchStatus, fetchAssets, fetchCandles, fetchScores, fetchRisk, fetchPerformance, fetchSettings, saveSettings, saveAssetConfig, enableAsset, dismissAsset, postTrade, toggleOptimizer, etc.)

- [ ] **Step 3: Create each store** — Svelte `writable` stores typed with the interfaces from types.ts. Each exports: the store itself + a `load` function that fetches and updates.

- [ ] **Step 4: Create polling.ts** — `startPolling(ms)` calls all load functions, `stopPolling()` clears interval.

- [ ] **Step 5: Verify build**

```bash
cd src/frontend && npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/lib/
git commit -m "feat: add API layer and Svelte stores for all dashboard data"
```

---

## Task 3: App shell — Header, NetworkSelector, ThemeToggle

**Files:**
- Create: `src/frontend/src/lib/components/Header.svelte`
- Create: `src/frontend/src/lib/components/NetworkSelector.svelte`
- Create: `src/frontend/src/lib/components/ThemeToggle.svelte`
- Modify: `src/frontend/src/App.svelte`

- [ ] **Step 1: Create Header.svelte** — Subscribes to `$status` store. Shows 6 cards: Status (running/paused), ETH Price + strategy, ETH Balance, USDC Balance, Portfolio USD, Wallet address. Use Tailwind: `grid grid-cols-6 gap-3`. Cards: `bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]`.

- [ ] **Step 2: Create NetworkSelector.svelte** — Fetches networks from `/api/networks`. Shows pill buttons. Active network highlighted green. Click POSTs to `/api/network`.

- [ ] **Step 3: Create ThemeToggle.svelte** — Toggles `dark` class on `<html>`. Persists via `PUT /api/theme`. Shows "Light"/"Dark" text.

- [ ] **Step 4: Update App.svelte** — Import and mount Header, NetworkSelector, ThemeToggle. Add top bar layout. Start polling on mount.

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './lib/components/Header.svelte';
  import NetworkSelector from './lib/components/NetworkSelector.svelte';
  import ThemeToggle from './lib/components/ThemeToggle.svelte';
  import { startPolling } from './lib/stores/polling';

  onMount(() => { startPolling(5000); });
</script>

<header class="flex items-center justify-between px-5 py-3">
  <div class="text-lg font-semibold">Trade Bot <span class="text-sm font-normal text-[var(--text-secondary)]">/ autonomous</span></div>
  <div class="flex items-center gap-3">
    <NetworkSelector />
    <button class="px-3 py-1 rounded border border-[var(--border)] text-sm" on:click={() => {}}>Settings</button>
    <ThemeToggle />
  </div>
</header>
<Header />
```

- [ ] **Step 5: Test dev mode** — `cd src/frontend && npx vite` — verify header renders with live data from proxied API.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/
git commit -m "feat: add Header, NetworkSelector, ThemeToggle components"
```

---

## Task 4: AssetsTable + AssetConfigPanel

**Files:**
- Create: `src/frontend/src/lib/components/AssetsTable.svelte`
- Create: `src/frontend/src/lib/components/AssetConfigPanel.svelte`
- Modify: `src/frontend/src/App.svelte`

- [ ] **Step 1: Create AssetsTable.svelte** — Subscribes to `$assets`. Renders table with columns: Asset, Price, Balance, Value, Weight (with bar), Score, 24H, Strategy. Click row to expand AssetConfigPanel below.

- [ ] **Step 2: Create AssetConfigPanel.svelte** — Receives `asset` as prop. Shows:
  - Strategy pills (threshold/sma/grid) — reactive show/hide of relevant fields
  - Threshold fields: buy on drop %, sell on rise % (only when threshold)
  - SMA fields: short window, long window + EMA/volume/RSI checkboxes (only when sma)
  - Grid fields: levels, upper bound, lower bound (only when grid)
  - SAVE button (calls `saveAssetConfig`) and DISABLE STRATEGY button (calls `dismissAsset`)
  - For pending assets: ENABLE and DISMISS buttons
  - Dispatches `saved` and `dismissed` events to parent for refresh

- [ ] **Step 3: Update App.svelte** — Mount AssetsTable.

- [ ] **Step 4: Verify** — `cd src/frontend && npx vite build`

- [ ] **Step 5: Commit**

```bash
git add src/frontend/
git commit -m "feat: add AssetsTable with inline AssetConfigPanel"
```

---

## Task 5: CandleChart + ScoresPanel

**Files:**
- Create: `src/frontend/src/lib/components/CandleChart.svelte`
- Create: `src/frontend/src/lib/components/ScoresPanel.svelte`
- Modify: `src/frontend/src/App.svelte`

- [ ] **Step 1: Create CandleChart.svelte** — Asset dropdown selector + timeframe pills (15M/1H/24H). Uses Chart.js candlestick (global `Chart` declared). Canvas element with `bind:this`. `onMount` creates chart, `$:` reactive updates. Volume bars below chart. Indicator readouts (RSI, MACD, Volume, Score) at bottom.

- [ ] **Step 2: Create ScoresPanel.svelte** — Subscribes to `$scores`. Lists assets ranked by score. Each row: symbol, score (colored green/red), signal pills (15m BUY, 1h HOLD, 24h SELL). Watchlist items tagged.

- [ ] **Step 3: Update App.svelte** — Mount in a flex row (chart 2/3 width, scores 1/3).

- [ ] **Step 4: Verify build** — `cd src/frontend && npx vite build`

- [ ] **Step 5: Commit**

```bash
git add src/frontend/
git commit -m "feat: add CandleChart and ScoresPanel components"
```

---

## Task 6: RiskMonitor + PerformancePanel

**Files:**
- Create: `src/frontend/src/lib/components/RiskMonitor.svelte`
- Create: `src/frontend/src/lib/components/PerformancePanel.svelte`
- Modify: `src/frontend/src/App.svelte`

- [ ] **Step 1: Create RiskMonitor.svelte** — Subscribes to `$risk`. Shows: Daily P&L (with progress bar toward limit), Rotations today (count/max), Max Position %, Portfolio Floor (value vs kill switch), Optimizer status. Placeholder message when optimizer disabled.

- [ ] **Step 2: Create PerformancePanel.svelte** — Two Chart.js line charts: Portfolio value (24h) and Price (24h). Subscribes to `$performance`. Uses `onMount` + `$:` reactive pattern.

- [ ] **Step 3: Update App.svelte** — Mount RiskMonitor full-width, PerformancePanel in a 2-column grid.

- [ ] **Step 4: Verify build** — `cd src/frontend && npx vite build`

- [ ] **Step 5: Commit**

```bash
git add src/frontend/
git commit -m "feat: add RiskMonitor and PerformancePanel components"
```

---

## Task 7: SettingsModal + ActionButtons + HoldingsGrid

**Files:**
- Create: `src/frontend/src/lib/components/SettingsModal.svelte`
- Create: `src/frontend/src/lib/components/ActionButtons.svelte`
- Create: `src/frontend/src/lib/components/HoldingsGrid.svelte`
- Create: `src/frontend/src/lib/components/TradeModal.svelte`
- Modify: `src/frontend/src/App.svelte`

- [ ] **Step 1: Create SettingsModal.svelte** — 4 tabs: Strategy, Trading, Optimizer, Notifications. Loads settings from store, saves via API. Tab content shows only relevant fields. Close on Escape key and backdrop click.

- [ ] **Step 2: Create ActionButtons.svelte** — Pause, Resume, Buy, Sell, Trade buttons. Buy/Sell call `/api/trade`. Trade opens TradeModal.

- [ ] **Step 3: Create TradeModal.svelte** — Manual trade form: from/to token selectors, amount input, quote preview, execute button.

- [ ] **Step 4: Create HoldingsGrid.svelte** — Grid of cards for non-ETH/USDC assets with balance and USD value. Subscribes to `$assets`.

- [ ] **Step 5: Update App.svelte** — Mount all components in correct layout order. Wire Settings button to open SettingsModal.

- [ ] **Step 6: Verify full build** — `cd src/frontend && npx vite build`

- [ ] **Step 7: Commit**

```bash
git add src/frontend/
git commit -m "feat: add SettingsModal, ActionButtons, HoldingsGrid, TradeModal"
```

---

## Task 8: Wire build pipeline, remove old frontend, update Dockerfile

**Files:**
- Modify: `package.json` (root) — update build:frontend script
- Modify: `tsconfig.json` (root) — update exclude
- Modify: `src/web/server.ts` — serve new build output + auth pages
- Modify: `Dockerfile` — install frontend deps + build
- Delete: `src/web/public/js/` (old vanilla TS modules)
- Delete: `src/web/public/index.html` (replaced by Svelte build)
- Keep: `src/web/public/login.html`, `src/web/public/setup.html` (auth pages)

- [ ] **Step 1: Update root package.json scripts**

```json
"build:frontend": "cd src/frontend && npm run build",
"dev:frontend": "cd src/frontend && npm run dev",
"build": "tsc && npm run build:frontend",
```

Remove the old esbuild script and the `cp -r src/web/public/. dist/web/public/` (Vite handles output).

- [ ] **Step 2: Copy auth pages into build output**

Add a postbuild step or update vite.config.ts `build.rollupOptions` to copy login.html and setup.html into the output directory. Or update `build` script:

```json
"build": "tsc && npm run build:frontend && cp src/web/public/login.html src/web/public/setup.html dist/web/public/"
```

- [ ] **Step 3: Update server.ts static serving**

The Express static middleware already serves from `dist/web/public/`. Vite outputs `index.html` + assets there. Ensure the fallback route serves `index.html` for SPA routing:

```typescript
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

- [ ] **Step 4: Update Dockerfile**

```dockerfile
FROM deps AS builder
COPY tsconfig.json ./
COPY src/ ./src/
# Install frontend deps and build everything
RUN cd src/frontend && npm ci
RUN npm run build
RUN npm prune --omit=dev
```

- [ ] **Step 5: Update root tsconfig.json exclude**

```json
"exclude": ["node_modules", "dist", "src/web/public/js", "src/frontend"]
```

- [ ] **Step 6: Remove old frontend files**

```bash
rm -rf src/web/public/js/
rm src/web/public/index.html
```

Keep `src/web/public/login.html` and `src/web/public/setup.html`.

- [ ] **Step 7: Verify full build**

```bash
npm run build
ls dist/web/public/index.html dist/web/public/login.html dist/web/public/setup.html
```

- [ ] **Step 8: Run backend tests** — `npx vitest run` (ensure no test depends on old frontend files)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire Svelte build pipeline, remove old vanilla frontend"
```

- [ ] **Step 10: Push**

```bash
git push origin main
```

- [ ] **Step 11: Update CLAUDE.md** — Update architecture section, build commands, frontend notes.

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Svelte + Tailwind frontend"
git push origin main
```

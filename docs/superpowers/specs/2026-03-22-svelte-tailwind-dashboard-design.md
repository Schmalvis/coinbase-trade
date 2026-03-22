# Svelte + Tailwind Dashboard Rewrite — Design Spec

> **For agentic workers:** Use superpowers:writing-plans to create an implementation plan from this spec.

**Goal:** Replace the vanilla JS dashboard with a Svelte + Tailwind CSS single-page application, rewritten from scratch against the existing API endpoints. Produces the same functionality with proper reactivity, component isolation, and modern styling.

**Architecture:** New Svelte project in `src/frontend/` built with Vite. Tailwind CSS for styling with dark/light mode. Builds to `dist/web/public/` — Express serves the static output. No SSR, no SvelteKit. Auth pages (login.html, setup.html) remain standalone.

**Tech Stack:** Svelte 4, Vite 5, Tailwind CSS 3, Chart.js (via svelte-chartjs or direct), TypeScript

---

## 1. Project Structure

```
src/frontend/
  vite.config.ts
  tailwind.config.js
  postcss.config.js
  tsconfig.json
  index.html              (Vite entry — mounts Svelte app)
  src/
    main.ts               (mount App, init)
    App.svelte             (layout shell, theme provider, polling coordinator)
    lib/
      api.ts              (typed fetch wrappers for all /api/* endpoints)
      stores/
        status.ts         (writable store: bot status, price, balances, portfolio, wallet)
        assets.ts         (writable store: asset list + discovered assets)
        candles.ts        (writable store: OHLCV candle data per symbol/interval)
        scores.ts         (writable store: opportunity scores)
        risk.ts           (writable store: risk monitor data)
        performance.ts    (writable store: P&L, portfolio snapshots)
        settings.ts       (writable store: config values)
        polling.ts        (polling coordinator — refreshes all stores on interval)
      components/
        Header.svelte            (status cards: status, ETH price, balance, USDC, portfolio, wallet)
        NetworkSelector.svelte   (base-sepolia / base-mainnet toggle pills)
        HoldingsGrid.svelte      (non-ETH/USDC asset balance cards)
        AssetsTable.svelte       (main assets table with clickable rows)
        AssetConfigPanel.svelte  (inline config: strategy pills, params, SMA toggles, grid fields, save/disable)
        ActionButtons.svelte     (pause, resume, buy, sell, trade buttons)
        CandleChart.svelte       (Chart.js candlestick with asset/timeframe selectors)
        ScoresPanel.svelte       (opportunity scores list with signal pills)
        PerformancePanel.svelte  (portfolio value + price line charts)
        RiskMonitor.svelte       (daily P&L, rotations, max position, floor, optimizer)
        SettingsModal.svelte     (tabbed modal: strategy, trading, optimizer, notifications)
        ThemeToggle.svelte       (dark/light toggle button)
        TradeModal.svelte        (manual trade form)
```

## 2. Data Flow

### Stores

Each store is a Svelte `writable` with a typed interface:

```typescript
// stores/status.ts
import { writable } from 'svelte/store';

interface StatusData {
  status: string;
  ethPrice: number | null;
  ethBalance: number;
  usdcBalance: number;
  portfolioUsd: number;
  walletAddress: string;
  network: string;
  strategy: string;
  mcpHealthy: boolean;
  optimizerEnabled: boolean;
  optimizerMode: string;
}

export const status = writable<StatusData | null>(null);
```

### Polling

`stores/polling.ts` exports `startPolling(intervalMs: number)` and `stopPolling()`. On each tick, it calls the API functions and updates the relevant stores. Components subscribe reactively — no manual DOM updates needed.

```typescript
import { status } from './status';
import { assets } from './assets';
import * as api from '../api';

let intervalId: number | undefined;

export function startPolling(ms = 5000) {
  tick(); // immediate first load
  intervalId = setInterval(tick, ms);
}

async function tick() {
  const [s, a] = await Promise.all([api.fetchStatus(), api.fetchAssets()]);
  status.set(s);
  assets.set(a);
  // candles, scores, risk, performance loaded on-demand or at slower cadence
}
```

### API Layer

`lib/api.ts` contains typed fetch wrappers for every endpoint. Returns parsed JSON with proper TypeScript interfaces. Handles auth headers (session cookie is automatic via `credentials: 'same-origin'`).

```typescript
export async function fetchStatus(): Promise<StatusData> {
  const res = await fetch('/api/status');
  return res.json();
}

export async function saveAssetConfig(address: string, config: AssetConfig): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/assets/${address}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}
// ... etc for all 31 endpoints
```

## 3. Component Details

### AssetsTable.svelte + AssetConfigPanel.svelte

The assets table is the most complex component. Each row is clickable — clicking expands an inline config panel below the row (same accordion pattern as current implementation).

```svelte
{#each $assets as asset}
  <tr on:click={() => toggleExpand(asset.address)} class="cursor-pointer hover:bg-gray-800/50">
    <td>{asset.symbol}</td>
    <td>${asset.price.toFixed(4)}</td>
    <!-- ... -->
  </tr>
  {#if expandedAddress === asset.address}
    <tr>
      <td colspan="8">
        <AssetConfigPanel {asset} on:saved={refresh} on:dismissed={refresh} />
      </td>
    </tr>
  {/if}
{/each}
```

AssetConfigPanel shows:
- Strategy pills (threshold / sma / grid) — clicking shows/hides relevant fields
- Threshold fields: buy on drop %, sell on rise %
- SMA fields: short window, long window + EMA/volume/RSI checkboxes
- Grid fields: levels, upper bound, lower bound
- SAVE and DISABLE STRATEGY buttons
- For pending assets: ENABLE and DISMISS buttons

### CandleChart.svelte

Wraps Chart.js directly (no svelte-chartjs needed — it's a thin wrapper that adds complexity). Uses `onMount` to create the chart and `$:` reactive block to update when candle data changes.

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { candles } from '../stores/candles';

  let canvas: HTMLCanvasElement;
  let chart: any;
  export let symbol = 'ETH';
  export let interval = '15m';

  onMount(() => {
    chart = new Chart(canvas, { type: 'candlestick', ... });
  });

  $: if (chart && $candles) {
    chart.data.datasets[0].data = $candles;
    chart.update('none');
  }

  onDestroy(() => chart?.destroy());
</script>

<canvas bind:this={canvas}></canvas>
```

### SettingsModal.svelte

Tabbed modal with 4 tabs: Strategy, Trading, Optimizer, Notifications. Uses Svelte's built-in transitions for open/close animation.

### ThemeToggle.svelte

Toggles `dark` class on `<html>` element. Persists preference via `PUT /api/theme`. Tailwind's `dark:` prefix handles all color switching automatically.

## 4. Tailwind Configuration

```javascript
// tailwind.config.js
export default {
  content: ['./src/**/*.{svelte,ts,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          primary: 'var(--bg-primary)',
          card: 'var(--bg-card)',
          hover: 'var(--bg-card-hover)',
        },
        accent: {
          green: '#4ade80',
          red: '#f87171',
          blue: '#60a5fa',
          yellow: '#fbbf24',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
};
```

Dark/light CSS variables defined in `index.html` or a global CSS file:
```css
:root {
  --bg-primary: #f8f9fb;
  --bg-card: #ffffff;
  --bg-card-hover: #f3f4f6;
  --text-primary: #1a1a2e;
  --text-secondary: rgba(0,0,0,0.5);
  --border: rgba(0,0,0,0.08);
}
.dark {
  --bg-primary: #0c0c14;
  --bg-card: #13132a;
  --bg-card-hover: #1a1a35;
  --text-primary: #e2e8f0;
  --text-secondary: rgba(255,255,255,0.5);
  --border: rgba(255,255,255,0.05);
}
```

## 5. Build Pipeline

### Vite Config

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../../dist/web/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3003',
      '/auth': 'http://localhost:3003',
    },
  },
});
```

### package.json

```json
{
  "scripts": {
    "build:frontend": "cd src/frontend && npx vite build",
    "dev:frontend": "cd src/frontend && npx vite",
    "build": "tsc && npm run build:frontend"
  }
}
```

### Dockerfile

No changes needed — the build script already outputs to `dist/web/public/`. The Dockerfile runs `npm run build` which now produces the Svelte build instead of the esbuild bundle.

### Dev Workflow

During development:
1. Run the bot: `npm run dev` (backend on port 3003)
2. Run Vite: `npm run dev:frontend` (frontend on port 5173 with proxy to 3003)
3. Vite serves the Svelte app with HMR — instant feedback on changes
4. For production: `npm run build` produces the static bundle

## 6. Auth Integration

- Login/setup pages remain as standalone HTML files in `src/web/public/login.html` and `setup.html`
- Express serves these BEFORE the Svelte SPA (auth middleware redirects to `/auth/login` or `/auth/setup` if not authenticated)
- The Svelte app loads AFTER authentication — session cookie is already set
- The Svelte app's `api.ts` doesn't need to handle auth — the cookie is sent automatically with `credentials: 'same-origin'` (default for same-origin fetch)
- Logout: POST to `/auth/logout`, then `window.location.href = '/auth/login'`

## 7. Migration Plan

1. Scaffold Svelte + Vite + Tailwind in `src/frontend/`
2. Build API layer and stores (test against running bot)
3. Build components one by one, starting with Header (simplest) through to AssetsTable (most complex)
4. Wire up polling and verify all data flows
5. Remove old `src/web/public/js/` modules and esbuild config
6. Update Express to serve from new build output
7. Update Dockerfile if needed

## 8. What Stays Unchanged

- All 11 Express route modules (src/web/routes/*.ts)
- Auth middleware, TOTP, passkey (src/web/middleware.ts, auth-routes.ts, webauthn.ts)
- Login and setup HTML pages
- All backend: strategies, optimizer, engine, executor, tracker, telegram
- API contract — zero endpoint changes
- Docker volume, network, environment configuration

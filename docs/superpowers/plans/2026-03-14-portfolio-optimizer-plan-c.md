# Portfolio Optimizer — Plan C: UI & Telegram

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dashboard redesign (themes, candle charts, optimizer panels) and Telegram commands for the portfolio optimizer.

**Architecture:** Dashboard gets CSS custom property theming, candlestick chart via Chart.js financial plugin, and new panels (opportunity scores, rotation log, risk monitor). Web server gets new API endpoints. Telegram bot gets new commands for scores, watchlist, risk, and kill switch.

**Tech Stack:** TypeScript ESM, Express, Chart.js + chartjs-chart-financial, Telegraf, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-portfolio-optimizer-design.md`

**Prerequisites:** Plan A and Plan B complete (CandleService, PortfolioOptimizer, RiskGuard, WatchlistManager exist)

**Conventions:**
- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- `botState` is a singleton — do not instantiate it
- The dashboard is a single `src/web/public/index.html` file with inline CSS/JS (vanilla JS, no framework)
- Run tests with `npx vitest run`

---

## Chunk 1: Web API Endpoints

### Task 1: New API Endpoints

**Files:**
- Modify: `src/web/server.ts`
- Test: `tests/web-optimizer-api.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/web-optimizer-api.test.ts` that verifies (using supertest or direct handler testing):

Mock the optimizer, candleQueries, rotationQueries, watchlistQueries, dailyPnlQueries, riskGuard, botState.

Tests:
- `GET /api/candles?symbol=ETH&interval=15m&limit=50` returns candle array from DB
- `GET /api/scores` returns current opportunity scores array
- `GET /api/rotations?limit=10` returns rotation history
- `GET /api/risk` returns { dailyPnl, rotationsToday, maxRotations, portfolioFloor, optimizerMode }
- `GET /api/watchlist` returns watchlist items
- `POST /api/watchlist` with { symbol, network } adds to watchlist, returns 200
- `DELETE /api/watchlist/:symbol` removes from watchlist
- `POST /api/optimizer/toggle` with { enabled: false } disables optimizer
- `GET /api/status` includes optimizerEnabled, optimizerMode, dailyPnl, rotationsToday

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-optimizer-api.test.ts`

- [ ] **Step 3: Implement API endpoints**

Modify `src/web/server.ts`. The `startWebServer` function needs access to the optimizer, watchlist manager, and candle service. Add these as parameters:

```typescript
export function startWebServer(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  executor: TradeExecutor,
  engine: TradingEngine,
  optimizer?: PortfolioOptimizer,
  watchlistManager?: WatchlistManager,
): void
```

Add endpoints:

**GET /api/candles** — query params: symbol, interval (default '15m'), limit (default 100). Read from candleQueries.getCandles. Return JSON array.

**GET /api/scores** — return `optimizer?.getLatestScores() ?? []`

**GET /api/rotations** — query param: limit (default 20). Read from rotationQueries.getRecentRotations. Return JSON array.

**GET /api/risk** — return object with:
- dailyPnl from dailyPnlQueries.getTodayPnl(network)
- rotationsToday from rotationQueries.getTodayRotationCount(network)
- limits from runtimeConfig (MAX_DAILY_LOSS_PCT, MAX_DAILY_ROTATIONS, PORTFOLIO_FLOOR_USD)
- optimizerMode: optimizer?.isRiskOff ? 'risk-off' : 'normal'

**GET /api/watchlist** — return watchlistManager?.getAll(botState.activeNetwork) ?? []

**POST /api/watchlist** — body: { symbol, network, address?, coinbasePair? }. Call watchlistManager.add(). Return { ok: true }.

**DELETE /api/watchlist/:symbol** — call watchlistManager.remove(symbol, network). Return { ok: true }.

**POST /api/optimizer/toggle** — body: { enabled: boolean }. Call engine.enableOptimizer() or engine.disableOptimizer(). Return { ok: true, enabled }.

**GET /api/status** — add to existing response: optimizerEnabled, optimizerMode, dailyPnl, rotationsToday.

**GET /api/theme** — return { theme: runtimeConfig.get('DASHBOARD_THEME') }

**PUT /api/theme** — body: { theme: 'light' | 'dark' }. Call runtimeConfig.set('DASHBOARD_THEME', theme). Return { ok: true }.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/web-optimizer-api.test.ts`
Expected: PASS

- [ ] **Step 5: Update index.ts to pass new params to startWebServer**

Modify the `startWebServer()` call in `src/index.ts` to pass optimizer and watchlistManager.

- [ ] **Step 6: Commit**

```
git add src/web/server.ts src/index.ts tests/web-optimizer-api.test.ts
git commit -m "feat: add optimizer API endpoints (candles, scores, rotations, risk, watchlist)"
```

---

## Chunk 2: Telegram Commands

### Task 2: New Telegram Commands

**Files:**
- Modify: `src/telegram/bot.ts`
- Test: `tests/telegram-optimizer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/telegram-optimizer.test.ts` that verifies:

Mock the Telegraf bot context (ctx.reply), optimizer, watchlistManager, engine, runtimeConfig, botState, rotationQueries, dailyPnlQueries.

Tests:
- `/scores` command replies with formatted opportunity scores
- `/rotations` command replies with last 5 rotations
- `/watchlist` command replies with watched assets
- `/watch ETH` adds to watchlist and confirms
- `/unwatch ETH` removes from watchlist and confirms
- `/risk` command replies with daily P&L and risk status
- `/killswitch` pauses bot and sends confirmation
- `/optimizer off` disables optimizer and confirms
- `/optimizer on` enables optimizer and confirms

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-optimizer.test.ts`

- [ ] **Step 3: Implement Telegram commands**

Modify `src/telegram/bot.ts`. The `startTelegramBot` function needs access to optimizer, watchlist manager. Add parameters:

```typescript
export function startTelegramBot(
  engine: TradingEngine,
  optimizer?: PortfolioOptimizer,
  watchlistManager?: WatchlistManager,
): void
```

Add commands:

**/scores** — Get `optimizer.getLatestScores()`, format as:
```
📊 Opportunity Scores
ETH: +38 (15m:buy 1h:buy 24h:hold)
CBBTC: +22 (15m:hold 1h:buy 24h:hold)
USDC: — (cash 18.2%)
```

**/rotations** — Get last 5 from rotationQueries.getRecentRotations. Format each as:
```
CBETH → ETH: +2.8% (executed, 14:32)
```

**/watchlist** — Get from watchlistManager.getAll(). List each with score if available.

**/watch <symbol>** — Parse symbol from args. Call watchlistManager.add(). Reply confirmation. Optional: accept address as second arg.

**/unwatch <symbol>** — Call watchlistManager.remove(). Reply confirmation.

**/risk** — Format:
```
🛡️ Risk Status
Daily P&L: +1.5% (limit: -5%)
Rotations: 3/10
Portfolio: $1,247 (floor: $100)
Optimizer: active (normal mode)
```

**/killswitch** — Call botState.setStatus('paused'), emit alert, log event. Reply "All trading halted. Use /resume to restart."

**/optimizer** — Parse on/off from args. Call engine.enableOptimizer() or engine.disableOptimizer(). Reply confirmation.

Also add rotation alert push via botState.onAlert (already wired from Plan B — optimizer emits alerts via botState.emitAlert).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/telegram-optimizer.test.ts`
Expected: PASS

- [ ] **Step 5: Update index.ts to pass new params to startTelegramBot**

Modify the `startTelegramBot()` call in `src/index.ts` to pass optimizer and watchlistManager.

- [ ] **Step 6: Commit**

```
git add src/telegram/bot.ts src/index.ts tests/telegram-optimizer.test.ts
git commit -m "feat: add Telegram commands (scores, rotations, watchlist, risk, killswitch, optimizer)"
```

---

## Chunk 3: Dashboard Redesign

### Task 3: Dashboard — Theme System + New Panels

**Files:**
- Modify: `src/web/public/index.html`

This is the largest single task. The dashboard is a single HTML file with inline CSS and vanilla JS.

- [ ] **Step 1: Add CSS custom properties for theming**

Add a `<style>` block at the top of the `<head>` with CSS custom properties for both themes:

```css
:root, [data-theme="dark"] {
  --bg-primary: #0c0c14;
  --bg-card: #13132a;
  --bg-card-hover: #1a1a35;
  --border: rgba(255,255,255,0.05);
  --text-primary: #e2e8f0;
  --text-secondary: rgba(255,255,255,0.5);
  --text-muted: rgba(255,255,255,0.25);
  --green: #4ade80;
  --red: #f87171;
  --blue: #60a5fa;
  --yellow: #fbbf24;
}
[data-theme="light"] {
  --bg-primary: #f8f9fb;
  --bg-card: #ffffff;
  --bg-card-hover: #f3f4f6;
  --border: rgba(0,0,0,0.08);
  --text-primary: #1a1a2e;
  --text-secondary: rgba(0,0,0,0.5);
  --text-muted: rgba(0,0,0,0.3);
  --green: #16a34a;
  --red: #dc2626;
  --blue: #2563eb;
  --yellow: #d97706;
}
```

Change all existing hardcoded colours to use `var(--token)` references.
Set font-family to `'Inter', 'Segoe UI', system-ui, sans-serif`.
Add theme toggle button in the status bar that calls `PUT /api/theme` and sets `data-theme` attribute on `<html>`.
On page load, fetch `GET /api/theme` and apply.

- [ ] **Step 2: Replace line chart with candlestick chart**

Add `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` and `<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial"></script>` (or bundle from npm).

Replace the existing price chart with a candlestick chart:
- Asset selector dropdown (populated from /api/status holdings)
- Timeframe selector buttons (15m / 1h / 24h)
- Fetch candles from `GET /api/candles?symbol=${symbol}&interval=${interval}&limit=100`
- Render using Chart.js financial candlestick type
- Volume bars below as a bar chart (second y-axis)
- Indicator readouts below: RSI, MACD direction, volume ratio, score (fetched from /api/scores)

- [ ] **Step 3: Add Opportunity Scores panel**

New panel to the right of the candle chart:
- Fetch from `GET /api/scores`
- Render as ranked list with score bars (-100 to +100)
- Color: green for positive, red for negative, gray for neutral
- Show per-timeframe signal breakdown (15m/1h/24h)
- Tag watchlist items with "watchlist" pill
- Click on an asset to switch the candle chart to that asset

- [ ] **Step 4: Enhance Holdings table**

Add two new columns to the existing holdings table:
- Weight % — portfolio weight with visual bar
- Score — opportunity score from /api/scores

- [ ] **Step 5: Add Rotation Log panel**

New panel below holdings:
- Fetch from `GET /api/rotations?limit=10`
- Render as chronological feed
- Each entry shows: pair (sell → buy), gain %, status, timestamp
- Green left border for executed, red for vetoed/failed
- Show veto reason for vetoed entries

- [ ] **Step 6: Add Risk Monitor bar**

New panel at bottom:
- Fetch from `GET /api/risk`
- Show: Daily P&L with progress bar, Rotation count with progress bar, Max position, Portfolio floor, Optimizer status
- Progress bars fill toward limits
- Color changes: green when safe, yellow when approaching limit, red when breached

- [ ] **Step 7: Add Settings modal — Portfolio Optimizer section**

Add a new collapsible section in the existing Settings modal:
- Group all new optimizer config keys under "Portfolio Optimizer" heading
- Same input pattern as existing settings (number inputs with labels and descriptions)
- Save via existing `PUT /api/config` endpoint (already handles RuntimeConfig keys)
- Keys: MAX_POSITION_PCT, MAX_DAILY_LOSS_PCT, MAX_ROTATION_PCT, MAX_DAILY_ROTATIONS, PORTFOLIO_FLOOR_USD, MIN_ROTATION_GAIN_PCT, MAX_CASH_PCT, OPTIMIZER_INTERVAL_SECONDS, ROTATION_SELL_THRESHOLD, ROTATION_BUY_THRESHOLD, MIN_ROTATION_SCORE_DELTA, RISK_OFF_THRESHOLD, RISK_ON_THRESHOLD, DEFAULT_FEE_ESTIMATE_PCT

- [ ] **Step 8: Add Watchlist Management UI**

Add a small panel or section in the dashboard:
- Show current watchlist items (from `GET /api/watchlist`)
- "Add to watchlist" form: symbol input, optional address input, submit button
- "Remove" button per item (calls `DELETE /api/watchlist/:symbol`)
- Promoted items shown with "promoted" badge

- [ ] **Step 9: Polish and test manually**

- Verify theme toggle works (dark ↔ light)
- Verify candle chart loads and switches timeframes
- Verify all panels update on poll interval
- Verify Settings modal saves and applies optimizer config
- Run `npx tsc --noEmit` to verify no type errors

- [ ] **Step 10: Commit**

```
git add src/web/public/index.html
git commit -m "feat: dashboard redesign with themes, candle chart, optimizer panels"
```

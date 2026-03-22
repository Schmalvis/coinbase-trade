// Chart.js candle chart, portfolio/price line charts
// NOTE: innerHTML usage is preserved from original inline JS — data comes from our own API
import { appState } from './state.js';
import { getChartColors } from './theme.js';
import { loadScores } from './scores.js';

declare const Chart: any;

export function makeChartOptions() {
  const c = getChartColors();
  return { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { ticks: { color: c.ticks, font: { size: 10, family: "'Inter', sans-serif" } }, grid: { color: c.grid } } }, plugins: { legend: { display: false } }, animation: false };
}

export function makeChart(id: string, color: string, bg: string) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true, backgroundColor: bg }] },
    options: makeChartOptions()
  });
}

export function switchTimeframe(tf: string) {
  appState.activeTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(function(b: any){ b.classList.toggle('active', b.dataset.tf === tf); });
  loadCandleChart();
}

export async function loadCandleChart() {
  try {
    const data = await fetch('/api/candles?symbol=' + appState.activeChartAsset + '&interval=' + appState.activeTimeframe + '&limit=100').then(function(r){ return r.json(); });
    const candleOverlay = document.getElementById('candleEmptyMsg');
    if (!data || !data.length) {
      if (appState.candleChart) { appState.candleChart.data.datasets[0].data = []; appState.candleChart.update('none'); }
      if (candleOverlay) { candleOverlay.style.display = 'flex'; candleOverlay.textContent = 'Collecting ' + appState.activeTimeframe + ' candle data for ' + appState.activeChartAsset + '\u2026 chart populates after ~6 hours of 15m candles.'; }
      return;
    }
    if (candleOverlay) candleOverlay.style.display = 'none';
    const candles = data.map(function(c: any) {
      return { x: new Date(c.open_time || c.timestamp || c.t).getTime(), o: c.open != null ? c.open : c.o, h: c.high != null ? c.high : c.h, l: c.low != null ? c.low : c.l, c: c.close != null ? c.close : c.c };
    });
    const cc = getChartColors();
    const cs = getComputedStyle(document.documentElement);
    if (!appState.candleChart) {
      appState.candleChart = new Chart(document.getElementById('candleChart'), {
        type: 'candlestick',
        data: { datasets: [{ label: appState.activeChartAsset, data: candles, color: { up: cs.getPropertyValue('--green').trim(), down: cs.getPropertyValue('--red').trim(), unchanged: cs.getPropertyValue('--text-secondary').trim() } }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: 'timeseries', ticks: { color: cc.ticks, font: { size: 10, family: "'Inter', sans-serif" }, maxTicksLimit: 8 }, grid: { color: cc.grid } },
            y: { ticks: { color: cc.ticks, font: { size: 10, family: "'Inter', sans-serif" } }, grid: { color: cc.grid } }
          },
          plugins: { legend: { display: false } }, animation: false
        }
      });
    } else {
      appState.candleChart.data.datasets[0].data = candles;
      appState.candleChart.data.datasets[0].label = appState.activeChartAsset;
      appState.candleChart.data.datasets[0].color = { up: cs.getPropertyValue('--green').trim(), down: cs.getPropertyValue('--red').trim(), unchanged: cs.getPropertyValue('--text-secondary').trim() };
      appState.candleChart.update('none');
    }
  } catch (e) { console.error('loadCandleChart:', e); }
}

export async function loadPriceChart() {
  try {
    const data = await fetch('/api/prices?asset=' + appState.activeChartAsset + '&limit=288').then(function(r){ return r.json(); });
    const reversed = data.slice().reverse();
    if (!appState.priceChart) appState.priceChart = makeChart('priceChart', '#60a5fa', 'rgba(96,165,250,0.07)');
    appState.priceChart.data.labels = reversed.map(function(d: any){ return d.timestamp; });
    appState.priceChart.data.datasets[0].data = reversed.map(function(d: any){ return d.price_usd; });
    appState.priceChart.update('none');
  } catch (e) { console.error('loadPriceChart:', e); }
}

export async function loadPortfolioChart() {
  try {
    const data = await fetch('/api/portfolio?limit=288').then(function(r){ return r.json(); });
    const reversed = data.slice().reverse();
    if (!appState.portfolioChart) appState.portfolioChart = makeChart('portfolioChart', '#4ade80', 'rgba(74,222,128,0.07)');
    appState.portfolioChart.data.labels = reversed.map(function(d: any){ return d.timestamp; });
    appState.portfolioChart.data.datasets[0].data = reversed.map(function(d: any){ return d.portfolio_usd; });
    appState.portfolioChart.update('none');
  } catch (e) { console.error('loadPortfolioChart:', e); }
}

export async function loadCharts() {
  await Promise.all([loadPriceChart(), loadPortfolioChart()]);
}

export async function switchChartAsset(symbol: string) {
  appState.activeChartAsset = symbol;
  const sel = document.getElementById('candleAssetSelect') as HTMLSelectElement | null;
  if (sel) sel.value = symbol;
  renderAssetSelector();
  await Promise.all([loadPriceChart(), loadCandleChart(), loadScores()]);
}

export function renderAssetSelector() {
  const el = document.getElementById('assetSelector');
  if (!el) return;
  el.textContent = '';
  const seenPills: Record<string, boolean> = {};
  appState.assetList.forEach(function(a: any) {
    if (seenPills[a.symbol]) return;
    seenPills[a.symbol] = true;
    const btn = document.createElement('button');
    btn.className = 'pill' + (a.symbol === appState.activeChartAsset ? ' active' : '');
    btn.style.cssText = 'font-size:0.6rem;padding:0.15rem 0.45rem';
    btn.textContent = a.symbol;
    btn.onclick = function() { switchChartAsset(a.symbol); };
    el.appendChild(btn);
  });
}

export function populateCandleAssetSelect() {
  const sel = document.getElementById('candleAssetSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const symbols: string[] = [];
  if (appState.assetList.length) {
    appState.assetList.forEach(function(a: any){ if (symbols.indexOf(a.symbol) === -1) symbols.push(a.symbol); });
  } else {
    symbols.push('ETH', 'USDC');
  }
  const current = sel.value;
  sel.textContent = '';
  symbols.forEach(function(s) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    if (s === current || s === appState.activeChartAsset) opt.selected = true;
    sel.appendChild(opt);
  });
}

export function initCandleAssetSelectListener() {
  const sel = document.getElementById('candleAssetSelect');
  if (sel) {
    sel.addEventListener('change', function(this: HTMLSelectElement) {
      appState.activeChartAsset = this.value;
      loadCandleChart();
      loadScores();
    });
  }
}

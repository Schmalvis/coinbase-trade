// Theme management (dark/light toggle)
import { appState } from './state.js';
import { getAuthHeaders } from './api.js';

declare const Chart: any;

export function getChartColors() {
  const s = getComputedStyle(document.documentElement);
  return { grid: s.getPropertyValue('--chart-grid').trim(), ticks: s.getPropertyValue('--chart-tick').trim() };
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
  localStorage.setItem('cb-theme', theme);
  fetch('/api/theme', { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify({ theme }) }).catch(function(){});
  const c = getChartColors();
  [appState.priceChart, appState.portfolioChart].forEach(function(chart: any) {
    if (!chart) return;
    chart.options.scales.y.ticks.color = c.ticks;
    chart.options.scales.y.grid.color = c.grid;
    chart.update('none');
  });
  if (appState.candleChart) {
    const cs2 = getComputedStyle(document.documentElement);
    appState.candleChart.options.scales.y.ticks.color = c.ticks;
    appState.candleChart.options.scales.y.grid.color = c.grid;
    appState.candleChart.options.scales.x.ticks.color = c.ticks;
    appState.candleChart.options.scales.x.grid.color = c.grid;
    appState.candleChart.data.datasets[0].color = { up: cs2.getPropertyValue('--green').trim(), down: cs2.getPropertyValue('--red').trim(), unchanged: cs2.getPropertyValue('--text-secondary').trim() };
    appState.candleChart.update('none');
  }
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  fetch('/api/theme').then(function(r){ return r.json(); }).then(function(d: any){ if (d.theme) applyTheme(d.theme); }).catch(function(){});
  const stored = localStorage.getItem('cb-theme') || 'dark';
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.textContent = stored === 'dark' ? 'Light' : 'Dark';
}

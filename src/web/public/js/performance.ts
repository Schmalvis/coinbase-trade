// Performance / P&L panel
import { appState } from './state.js';
import { getChartColors } from './theme.js';

declare const Chart: any;

function renderPnlValue(el: HTMLElement | null, change: number, pct: number) {
  if (!el) return;
  const sign = change >= 0 ? '+' : '';
  el.textContent = sign + '$' + Math.abs(change).toFixed(2) + ' (' + sign + pct.toFixed(1) + '%)';
  el.style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
}

export async function loadPerformance() {
  try {
    const data = await fetch('/api/performance?days=30').then(function(r) { return r.json(); });

    renderPnlValue(document.getElementById('perfToday'), data.today.change, data.today.change_pct);
    renderPnlValue(document.getElementById('perf7d'), data.week.change, data.week.change_pct);
    renderPnlValue(document.getElementById('perf30d'), data.month.change, data.month.change_pct);
    renderPnlValue(document.getElementById('perfTotal'), data.total.change, data.total.change_pct);
    const perfRotations = document.getElementById('perfRotations');
    if (perfRotations) perfRotations.textContent = data.rotations.recent_profitable + '/' + data.rotations.recent_total + ' profitable';

    // P&L chart
    if (data.portfolio_history && data.portfolio_history.length > 1) {
      const labels = data.portfolio_history.map(function(p: any) { return p.timestamp; });
      const values = data.portfolio_history.map(function(p: any) { return p.portfolio_usd; });
      const c = getChartColors();

      if (appState.pnlChart) {
        appState.pnlChart.data.labels = labels;
        appState.pnlChart.data.datasets[0].data = values;
        appState.pnlChart.update('none');
      } else {
        const ctx = (document.getElementById('pnlChart') as HTMLCanvasElement).getContext('2d');
        const lastVal = values[values.length - 1];
        const firstVal = values[0];
        const cs = getComputedStyle(document.documentElement);
        const green = cs.getPropertyValue('--green').trim();
        const red = cs.getPropertyValue('--red').trim();
        const lineColor = lastVal >= firstVal ? green : red;

        appState.pnlChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              data: values,
              borderColor: lineColor,
              backgroundColor: lineColor + '18',
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              borderWidth: 1.5,
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
              x: { display: false },
              y: { ticks: { color: c.ticks, font: { size: 10, family: "'Inter', sans-serif" } }, grid: { color: c.grid } }
            },
            plugins: { legend: { display: false } },
            animation: false,
          }
        });
      }
    }
  } catch (e) { /* performance data not available yet */ }
}

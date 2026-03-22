// Scores panel rendering and loading
// NOTE: innerHTML usage preserved from original inline JS — data comes from our own API
import { appState } from './state.js';

export async function loadScores() {
  try {
    const data = await fetch('/api/scores').then(function(r){ return r.json(); });
    appState.scoresData = {};
    const list = Array.isArray(data) ? data : (data.scores || []);
    list.forEach(function(s: any){ appState.scoresData[s.symbol] = s; });
    renderScores(list);
    updateIndicatorBar();
  } catch (e) { console.warn('loadScores:', e); }
}

export function renderScores(scores: any[]) {
  const el = document.getElementById('scoresList');
  if (!el) return;
  if (!scores.length) {
    el.textContent = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'color:var(--text-muted);font-size:0.72rem';
    msg.textContent = 'Collecting data\u2026 scores available after optimizer runs (~5 min interval). Ensure optimizer is enabled in Settings \u2192 Optimizer.';
    el.appendChild(msg);
    return;
  }
  const sorted = scores.slice().sort(function(a: any, b: any){ return (b.score||0) - (a.score||0); });
  // Build score items using DOM methods
  el.textContent = '';
  sorted.forEach(function(s: any) {
    const score = s.score || 0;
    const color = score > 0 ? 'var(--green)' : score < 0 ? 'var(--red)' : 'var(--text-secondary)';
    const barWidth = Math.min(100, Math.max(0, 50 + score / 2));
    const barColor = score > 0 ? 'var(--green)' : 'var(--red)';
    const signals = s.signals || {};
    const tfLabels: Record<string, string> = { candle15m: '15m', candle1h: '1h', candle24h: '24h' };

    const item = document.createElement('div');
    item.className = 'score-item';
    item.onclick = function() { (window as any).switchChartAsset(s.symbol); };

    const symSpan = document.createElement('span');
    symSpan.className = 'score-symbol';
    symSpan.textContent = s.symbol;
    item.appendChild(symSpan);

    const valSpan = document.createElement('span');
    valSpan.className = 'score-value';
    valSpan.style.color = color;
    valSpan.textContent = (score > 0 ? '+' : '') + score.toFixed(1);
    item.appendChild(valSpan);

    const barWrap = document.createElement('div');
    barWrap.className = 'score-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'score-bar';
    bar.style.width = barWidth + '%';
    bar.style.background = barColor;
    barWrap.appendChild(bar);
    item.appendChild(barWrap);

    const sigSpan = document.createElement('span');
    sigSpan.className = 'score-signals';
    Object.keys(signals).forEach(function(k) {
      const v = signals[k];
      const sig = v && typeof v === 'object' ? (v.signal || 'hold') : (v || 'hold');
      const label = tfLabels[k] || k;
      const pill = document.createElement('span');
      pill.className = 'sig-pill ' + sig;
      pill.textContent = label + ' ' + sig.toUpperCase();
      sigSpan.appendChild(pill);
    });
    item.appendChild(sigSpan);

    if (s.watchlist) {
      const wp = document.createElement('span');
      wp.className = 'watchlist-pill';
      wp.textContent = 'watch';
      item.appendChild(wp);
    }

    el.appendChild(item);
  });
}

export function updateIndicatorBar() {
  const s = appState.scoresData[appState.activeChartAsset];
  if (!s) {
    const ids = ['indRsi', 'indMacd', 'indVol', 'indScore'];
    ids.forEach(function(id) { const el = document.getElementById(id); if (el) el.textContent = '--'; });
    return;
  }
  const rsiEl = document.getElementById('indRsi');
  if (rsiEl) {
    rsiEl.textContent = s.rsi != null ? s.rsi.toFixed(1) : '--';
    if (s.rsi != null) rsiEl.style.color = s.rsi > 70 ? 'var(--red)' : s.rsi < 30 ? 'var(--green)' : '';
  }
  const macdEl = document.getElementById('indMacd');
  if (macdEl) macdEl.textContent = s.macd_direction || s.macd || '--';
  const volEl = document.getElementById('indVol');
  if (volEl) volEl.textContent = s.volume_ratio != null ? s.volume_ratio.toFixed(2) + 'x' : '--';
  const scoreEl = document.getElementById('indScore');
  if (scoreEl) {
    const sc = s.score || 0;
    scoreEl.textContent = (sc > 0 ? '+' : '') + sc.toFixed(1);
    scoreEl.style.color = sc > 0 ? 'var(--green)' : sc < 0 ? 'var(--red)' : '';
  }
}

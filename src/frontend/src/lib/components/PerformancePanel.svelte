<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { performance } from '../stores/performance';

  declare const Chart: any;

  let canvas: HTMLCanvasElement;
  let chart: any;
  type Range = '7d' | '30d' | 'all';
  let range: Range = '30d';

  function setRange(r: Range) {
    range = r;
  }

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexToRgba(hex: string, alpha: number): string {
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function currentColors() {
    const accent = cssVar('--accent') || '#C15F3C';
    const muted = cssVar('--text-muted') || '#8A867B';
    const border = cssVar('--border') || 'rgba(0,0,0,0.1)';
    return { accent, muted, border, fill: hexToRgba(accent, 0.12) };
  }

  function buildOptions() {
    const { muted, border } = currentColors();
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: {
          ticks: { color: muted, font: { size: 10 } },
          grid: { color: border },
        },
      },
      plugins: { legend: { display: false } },
      animation: false,
    };
  }

  function filteredHistory() {
    const ph = $performance?.portfolio_history ?? [];
    if (range === 'all') return ph;
    const days = range === '7d' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return ph.filter((p: { timestamp: string; portfolio_usd: number }) => new Date(p.timestamp).getTime() >= cutoff);
  }

  function renderChart() {
    if (!chart) return;
    const ph = filteredHistory();
    chart.data.labels = ph.map((p: { timestamp: string }) => p.timestamp);
    chart.data.datasets[0].data = ph.map((p: { portfolio_usd: number }) => p.portfolio_usd);
    chart.update('none');
  }

  function recolor() {
    if (!chart) return;
    const { accent, fill } = currentColors();
    chart.data.datasets[0].borderColor = accent;
    chart.data.datasets[0].backgroundColor = fill;
    Object.assign(chart.options, buildOptions());
    chart.update('none');
  }

  function onThemeChange() {
    recolor();
  }

  onMount(() => {
    const { accent, fill } = currentColors();
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Portfolio',
          data: [],
          borderColor: accent,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
          backgroundColor: fill,
        }],
      },
      options: buildOptions(),
    });
    renderChart();
    window.addEventListener('themechange', onThemeChange);
  });

  $: if (chart && $performance) {
    renderChart();
  }
  $: if (chart && range) {
    renderChart();
  }

  onDestroy(() => {
    chart?.destroy();
    window.removeEventListener('themechange', onThemeChange);
  });
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <div class="flex items-center justify-between mb-2">
    <h2 class="text-sm font-semibold font-display text-[var(--text-primary)]">Portfolio value</h2>
    <div class="flex gap-1 bg-[var(--bg-inset)] rounded-[var(--radius-btn)] p-0.5">
      {#each [['7d','7d'],['30d','30d'],['all','All']] as [id, lbl]}
        <button
          class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
          class:bg-clay-soft={range === id}
          class:text-clay={range === id}
          class:text-[var(--text-secondary)]={range !== id}
          on:click={() => setRange(id)}
        >{lbl}</button>
      {/each}
    </div>
  </div>
  <div class="h-40"><canvas bind:this={canvas}></canvas></div>
</div>

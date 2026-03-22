<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { performance } from '../stores/performance';

  declare const Chart: any;

  let portfolioCanvas: HTMLCanvasElement;
  let priceCanvas: HTMLCanvasElement;
  let portfolioChart: any;
  let priceChart: any;

  function chartOpts(label: string, color: string) {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label,
            data: [],
            borderColor: color,
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: true,
            backgroundColor: color + '15',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { display: false },
          y: {
            ticks: { color: '#888', font: { size: 10 } },
            grid: { color: 'rgba(128,128,128,0.1)' },
          },
        },
        plugins: { legend: { display: false } },
        animation: false,
      },
    };
  }

  onMount(() => {
    portfolioChart = new Chart(portfolioCanvas, chartOpts('Portfolio', '#4ade80'));
    priceChart = new Chart(priceCanvas, chartOpts('Price', '#60a5fa'));
  });

  $: if (portfolioChart && $performance) {
    const ph = $performance.portfolioHistory || [];
    portfolioChart.data.labels = ph.map((p: { timestamp: string; value: number }) => p.timestamp);
    portfolioChart.data.datasets[0].data = ph.map((p: { timestamp: string; value: number }) => p.value);
    portfolioChart.update('none');
  }

  $: if (priceChart && $performance) {
    const pr = $performance.priceHistory || [];
    priceChart.data.labels = pr.map((p: { timestamp: string; price: number }) => p.timestamp);
    priceChart.data.datasets[0].data = pr.map((p: { timestamp: string; price: number }) => p.price);
    priceChart.update('none');
  }

  onDestroy(() => {
    portfolioChart?.destroy();
    priceChart?.destroy();
  });

  function fmtPnl(v: number) {
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v: number) {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }
</script>

<div class="space-y-4">
  <!-- P&L summary row -->
  {#if $performance}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      {#each [
        { label: 'Today', data: $performance.today },
        { label: '7 Days', data: $performance.week },
        { label: '30 Days', data: $performance.month },
        { label: 'Total', data: $performance.total },
      ] as item}
        <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
          <div class="text-xs text-[var(--text-muted)] mb-1">{item.label}</div>
          <div class="text-lg font-bold {item.data.pnl >= 0 ? 'text-accent-green' : 'text-red-400'}">
            {fmtPnl(item.data.pnl)}
          </div>
          <div class="text-xs {item.data.pct >= 0 ? 'text-accent-green' : 'text-red-400'}">
            {fmtPct(item.data.pct)}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Charts row -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
      <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">Portfolio — 24H</div>
      <div class="h-40"><canvas bind:this={portfolioCanvas}></canvas></div>
    </div>
    <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
      <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">Price — 24H</div>
      <div class="h-40"><canvas bind:this={priceCanvas}></canvas></div>
    </div>
  </div>
</div>

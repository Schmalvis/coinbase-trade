<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { performance } from '../stores/performance';

  declare const Chart: any;

  let portfolioCanvas: HTMLCanvasElement;
  let portfolioChart: any;

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
  });

  $: if (portfolioChart && $performance) {
    const ph = $performance.portfolio_history ?? [];
    portfolioChart.data.labels = ph.map((p: { timestamp: string; portfolio_usd: number }) => p.timestamp);
    portfolioChart.data.datasets[0].data = ph.map((p: { timestamp: string; portfolio_usd: number }) => p.portfolio_usd);
    portfolioChart.update('none');
  }

  onDestroy(() => {
    portfolioChart?.destroy();
  });

  function fmtPnl(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }
</script>

<div class="space-y-4">
  <!-- P&L summary row -->
  {#if $performance}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      {#each [
        { label: 'Today', pnl: $performance.today?.change, pct: $performance.today?.change_pct },
        { label: '7 Days', pnl: $performance.week?.change, pct: $performance.week?.change_pct },
        { label: '30 Days', pnl: $performance.month?.change, pct: $performance.month?.change_pct },
        { label: 'Total', pnl: $performance.total?.change, pct: $performance.total?.change_pct },
      ] as item}
        <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
          <div class="text-xs text-[var(--text-muted)] mb-1">{item.label}</div>
          <div class="text-lg font-bold {(item.pnl ?? 0) >= 0 ? 'text-accent-green' : 'text-red-400'}">
            {fmtPnl(item.pnl)}
          </div>
          <div class="text-xs {(item.pct ?? 0) >= 0 ? 'text-accent-green' : 'text-red-400'}">
            {fmtPct(item.pct)}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Chart -->
  <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
    <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">Portfolio Value</div>
    <div class="h-40"><canvas bind:this={portfolioCanvas}></canvas></div>
  </div>
</div>

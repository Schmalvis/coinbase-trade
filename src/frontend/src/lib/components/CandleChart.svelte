<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { assets } from '../stores/assets';
  import { fetchCandles } from '../api';
  import type { CandleData } from '../types';

  declare const Chart: any;

  let canvas: HTMLCanvasElement;
  let chart: any;
  let selectedSymbol = 'ETH';
  let selectedInterval = '15m';
  let candleData: any[] = [];
  let loading = false;
  let lastCandle: CandleData | null = null;

  $: symbols = [...new Set(($assets || []).filter(a => a.status === 'active').map(a => a.symbol))];
  $: if (symbols.length && !symbols.includes(selectedSymbol)) selectedSymbol = symbols[0];

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function currentColors() {
    return {
      gain: cssVar('--gain') || '#1E7B53',
      loss: cssVar('--loss') || '#B3372E',
      muted: cssVar('--text-muted') || '#8A867B',
      border: cssVar('--border') || 'rgba(0,0,0,0.1)',
    };
  }

  function recolor() {
    if (!chart) return;
    const { gain, loss, muted, border } = currentColors();
    chart.data.datasets[0].color = { up: gain, down: loss, unchanged: muted };
    chart.options.scales.x.ticks.color = muted;
    chart.options.scales.x.grid.color = border;
    chart.options.scales.y.ticks.color = muted;
    chart.options.scales.y.grid.color = border;
    chart.update('none');
  }

  function onThemeChange() {
    recolor();
  }

  // Derived indicators from last candle
  $: rsi = lastCandle ? null : null; // RSI not directly in CandleData; show volume info instead
  $: priceChange = candleData.length >= 2
    ? ((candleData[candleData.length - 1].c - candleData[candleData.length - 2].c) / candleData[candleData.length - 2].c * 100)
    : null;

  async function loadChart() {
    if (!canvas) return;
    loading = true;
    try {
      const data = await fetchCandles(selectedSymbol, selectedInterval, 100);
      if (!data || data.length === 0) { loading = false; return; }
      lastCandle = data[data.length - 1];
      candleData = data.map(c => ({
        x: new Date(c.open_time).getTime(),
        o: c.open, h: c.high, l: c.low, c: c.close,
      }));
      if (chart) {
        chart.data.datasets[0].data = candleData;
        chart.data.datasets[0].label = selectedSymbol;
        chart.update('none');
      }
    } catch (e) {
      console.warn('loadChart failed', e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    const { gain, loss, muted, border } = currentColors();
    chart = new Chart(canvas, {
      type: 'candlestick',
      data: {
        datasets: [{
          label: selectedSymbol,
          data: candleData,
          color: {
            up: gain,
            down: loss,
            unchanged: muted,
          },
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'timeseries',
            ticks: { color: muted, maxTicksLimit: 8 },
            grid: { color: border },
          },
          y: {
            ticks: { color: muted },
            grid: { color: border },
          },
        },
        plugins: { legend: { display: false } },
        animation: false,
      },
    });
    loadChart();
    window.addEventListener('themechange', onThemeChange);
  });

  onDestroy(() => {
    chart?.destroy();
    window.removeEventListener('themechange', onThemeChange);
  });

  function switchInterval(iv: string) {
    selectedInterval = iv;
    loadChart();
  }
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <!-- Header row -->
  <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
    <div class="flex items-center gap-2">
      <span class="text-sm font-semibold font-display text-[var(--text-primary)]">Candle chart</span>
      {#if symbols.length > 0}
        <select
          bind:value={selectedSymbol}
          on:change={() => loadChart()}
          class="bg-[var(--bg-inset)] border border-[var(--border)] text-[var(--text-primary)] rounded-[var(--radius-btn)] px-2 py-1 text-sm focus:outline-none focus:border-clay"
        >
          {#each symbols as sym}
            <option value={sym}>{sym}</option>
          {/each}
        </select>
      {/if}
      {#if loading}
        <span class="text-[10px] text-[var(--text-muted)]">loading…</span>
      {/if}
    </div>

    <!-- Timeframe pills -->
    <div class="flex gap-1 bg-[var(--bg-inset)] rounded-[var(--radius-btn)] p-0.5">
      {#each ['15m', '1h', '24h'] as iv}
        <button
          class="px-3 py-1 rounded-md text-xs font-medium transition-colors"
          class:bg-clay-soft={selectedInterval === iv}
          class:text-clay={selectedInterval === iv}
          class:text-[var(--text-secondary)]={selectedInterval !== iv}
          on:click={() => switchInterval(iv)}
        >
          {iv.toUpperCase()}
        </button>
      {/each}
    </div>
  </div>

  <!-- Chart canvas -->
  <div class="h-64 relative">
    <canvas bind:this={canvas}></canvas>
    {#if candleData.length === 0 && !loading}
      <div class="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
        No candle data for {selectedSymbol} / {selectedInterval}
      </div>
    {/if}
  </div>

  <!-- Indicator readouts -->
  {#if lastCandle}
    <div class="mt-3 flex gap-4 flex-wrap text-xs text-[var(--text-secondary)]">
      <span>
        O <span class="text-[var(--text-primary)] font-mono">{(lastCandle.open ?? 0).toFixed(2)}</span>
      </span>
      <span>
        H <span class="text-[var(--text-primary)] font-mono">{(lastCandle.high ?? 0).toFixed(2)}</span>
      </span>
      <span>
        L <span class="text-[var(--text-primary)] font-mono">{(lastCandle.low ?? 0).toFixed(2)}</span>
      </span>
      <span>
        C <span class="text-[var(--text-primary)] font-mono">{(lastCandle.close ?? 0).toFixed(2)}</span>
      </span>
      <span>
        Vol <span class="text-[var(--text-primary)] font-mono">{(lastCandle.volume ?? 0).toFixed(4)}</span>
      </span>
      {#if priceChange !== null}
        <span>
          Chg
          <span class="font-mono font-semibold"
            class:text-gain={priceChange >= 0}
            class:text-loss={priceChange < 0}
          >
            {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
          </span>
        </span>
      {/if}
    </div>
  {/if}
</div>

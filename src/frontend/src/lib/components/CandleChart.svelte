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
    chart = new Chart(canvas, {
      type: 'candlestick',
      data: {
        datasets: [{
          label: selectedSymbol,
          data: candleData,
          color: {
            up: '#4ade80',
            down: '#f87171',
            unchanged: '#888',
          },
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'timeseries',
            ticks: { color: '#888', maxTicksLimit: 8 },
            grid: { color: 'rgba(128,128,128,0.1)' },
          },
          y: {
            ticks: { color: '#888' },
            grid: { color: 'rgba(128,128,128,0.1)' },
          },
        },
        plugins: { legend: { display: false } },
        animation: false,
      },
    });
    loadChart();
  });

  onDestroy(() => chart?.destroy());

  function switchInterval(iv: string) {
    selectedInterval = iv;
    loadChart();
  }
</script>

<div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
  <!-- Header row -->
  <div class="flex items-center justify-between mb-3">
    <div class="flex items-center gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Candle Chart</span>
      {#if symbols.length > 0}
        <select
          bind:value={selectedSymbol}
          on:change={() => loadChart()}
          class="bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm"
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
    <div class="flex gap-1 bg-[var(--bg-primary)] rounded-lg p-0.5">
      {#each ['15m', '1h', '24h'] as iv}
        <button
          class="px-3 py-1 rounded-md text-xs font-medium transition-colors"
          class:bg-blue-500={selectedInterval === iv}
          class:text-white={selectedInterval === iv}
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
        O <span class="text-[var(--text-primary)] font-mono">{lastCandle.open.toFixed(2)}</span>
      </span>
      <span>
        H <span class="text-[var(--text-primary)] font-mono">{lastCandle.high.toFixed(2)}</span>
      </span>
      <span>
        L <span class="text-[var(--text-primary)] font-mono">{lastCandle.low.toFixed(2)}</span>
      </span>
      <span>
        C <span class="text-[var(--text-primary)] font-mono">{lastCandle.close.toFixed(2)}</span>
      </span>
      <span>
        Vol <span class="text-[var(--text-primary)] font-mono">{lastCandle.volume.toFixed(4)}</span>
      </span>
      {#if priceChange !== null}
        <span>
          Chg
          <span class="font-mono font-semibold"
            class:text-green-400={priceChange >= 0}
            class:text-red-400={priceChange < 0}
          >
            {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
          </span>
        </span>
      {/if}
    </div>
  {/if}
</div>

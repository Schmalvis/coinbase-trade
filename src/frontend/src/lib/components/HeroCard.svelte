<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { status } from '../stores/status';
  import { performance } from '../stores/performance';
  import { executeControl } from '../api';

  const dispatch = createEventDispatcher();

  let pauseLoading = false;
  let resumeLoading = false;

  function fmtUsd(v: number | null | undefined): string {
    if (v == null) return '--';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPnl(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v: number | null | undefined): string {
    if (v == null) return '';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtWallet(addr: string | null | undefined): string {
    if (!addr) return '--';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  function fmtTime(ts: string | null | undefined): string {
    if (!ts) return 'No trades yet';
    const d = new Date(ts);
    return 'Last trade ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  async function handlePause() {
    pauseLoading = true;
    try { await executeControl('pause'); } catch (e) { console.warn('Pause failed:', e); }
    pauseLoading = false;
  }

  async function handleResume() {
    resumeLoading = true;
    try { await executeControl('resume'); } catch (e) { console.warn('Resume failed:', e); }
    resumeLoading = false;
  }

  $: s = $status;
  $: p = $performance;
  $: portfolioValue = p?.current_usd ?? s?.portfolioUsd ?? null;
  $: todayChange = p?.today?.change;
  $: todayChangePct = p?.today?.change_pct;
  $: isRunning = s?.status === 'running';
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-5 sm:p-6">
  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
    <div>
      <div class="font-display text-4xl sm:text-5xl tracking-tight tabular-nums text-[var(--text-primary)]">
        {fmtUsd(portfolioValue)}
      </div>
      <div class="mt-1.5 text-sm font-mono tabular-nums" class:text-gain={(todayChange ?? 0) >= 0} class:text-loss={(todayChange ?? 0) < 0}>
        {#if todayChange != null}
          {fmtPnl(todayChange)} <span class="text-[var(--text-muted)] font-sans">today</span> {fmtPct(todayChangePct)}
        {:else}
          <span class="text-[var(--text-muted)] font-sans">No performance data yet</span>
        {/if}
      </div>

      <div class="mt-3 flex items-center gap-2 flex-wrap">
        <span
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-pill)] text-xs font-medium"
          class:bg-gain-soft={isRunning}
          class:text-gain={isRunning}
          class:bg-warn-soft={!isRunning}
          class:text-warn={!isRunning}
        >
          <span class="w-1.5 h-1.5 rounded-full" class:bg-gain={isRunning} class:bg-warn={!isRunning}></span>
          {s ? (isRunning ? 'Running' : 'Paused') : '—'}
        </span>
        {#if s?.dryRun}
          <span class="px-2.5 py-1 rounded-[var(--radius-pill)] text-xs font-semibold bg-warn-soft text-warn">DRY RUN</span>
        {:else if s}
          <span class="px-2.5 py-1 rounded-[var(--radius-pill)] text-xs font-medium text-[var(--text-muted)] border border-[var(--border)]">LIVE</span>
        {/if}
      </div>
    </div>

    <div class="flex sm:flex-col gap-2 w-full sm:w-auto">
      {#if isRunning}
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded-[var(--radius-btn)] text-sm font-medium border border-warn text-warn hover:bg-warn-soft transition-colors disabled:opacity-50"
          on:click={handlePause}
          disabled={pauseLoading}
        >{pauseLoading ? '…' : 'Pause'}</button>
      {:else}
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded-[var(--radius-btn)] text-sm font-medium bg-clay hover:bg-clay-hover text-white transition-colors disabled:opacity-50"
          on:click={handleResume}
          disabled={resumeLoading}
        >{resumeLoading ? '…' : 'Resume'}</button>
      {/if}
      <button
        class="flex-1 sm:flex-none px-4 py-2 rounded-[var(--radius-btn)] text-sm font-medium border border-[var(--border-hi)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
        on:click={() => dispatch('trade')}
      >Trade…</button>
    </div>
  </div>

  <div class="mt-4 pt-3 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)] font-mono tabular-nums">
    <span>{s ? fmtWallet(s.walletAddress) : '--'}</span>
    <span class="font-sans">{s?.activeNetwork ?? ''}</span>
    <span class="font-sans">{s ? fmtTime(s.lastTradeAt) : ''}</span>
  </div>
</div>

<script lang="ts">
  import { status } from '../stores/status';

  function fmtPrice(v: number | null): string {
    if (v == null) return '--';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtEth(v: number): string {
    if (v == null) return '--';
    return v.toFixed(6) + ' ETH';
  }

  function fmtUsdc(v: number): string {
    if (v == null) return '--';
    return v.toFixed(2) + ' USDC';
  }

  function fmtPortfolio(v: number): string {
    if (v == null) return '--';
    return '$' + v.toFixed(2);
  }

  function fmtWallet(addr: string | null): string {
    if (!addr) return '--';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  function fmtTime(ts: string | null): string {
    if (!ts) return 'No trades yet';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  $: s = $status;
</script>

<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-4">
  <!-- Status -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Status</div>
    {#if s}
      <div class="text-lg font-semibold mt-1 {s.status === 'running' ? 'text-accent-green' : 'text-yellow-400'}">
        {s.status}
      </div>
    {:else}
      <div class="text-lg font-semibold mt-1">--</div>
    {/if}
  </div>

  <!-- ETH Price -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">ETH Price</div>
    <div class="text-lg font-semibold mt-1">{s ? fmtPrice(s.ethPrice) : '--'}</div>
    <div class="text-xs text-[var(--text-muted)] mt-1">{s ? s.strategy : '--'}</div>
  </div>

  <!-- ETH Balance -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">ETH Balance</div>
    <div class="text-lg font-semibold mt-1">{s ? fmtEth(s.ethBalance) : '--'}</div>
  </div>

  <!-- USDC Balance -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">USDC Balance</div>
    <div class="text-lg font-semibold mt-1">{s ? fmtUsdc(s.usdcBalance) : '--'}</div>
  </div>

  <!-- Portfolio -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Portfolio</div>
    <div class="text-lg font-semibold mt-1">{s ? fmtPortfolio(s.portfolioUsd) : '--'}</div>
    <div class="text-xs text-[var(--text-muted)] mt-1">{s ? fmtTime(s.lastTradeAt) : '--'}</div>
  </div>

  <!-- Wallet -->
  <div class="bg-[var(--bg-card)] rounded-xl p-4 border border-[var(--border)]">
    <div class="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Wallet</div>
    <div class="text-lg font-semibold mt-1 font-mono">{s ? fmtWallet(s.walletAddress) : '--'}</div>
    <div class="text-xs text-[var(--text-muted)] mt-1">{s ? s.network : '--'}</div>
  </div>
</div>

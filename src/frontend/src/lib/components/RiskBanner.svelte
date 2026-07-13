<script lang="ts">
  import { risk } from '../stores/risk';
  import { setTab } from '../stores/nav';

  $: r = $risk;

  $: warning = !!r && r.has_data && (
    r.optimizer_status === 'risk-off' ||
    (r.portfolio_floor > 0 && r.portfolio_usd < r.portfolio_floor * 1.2) ||
    (r.daily_pnl_limit > 0 && r.daily_pnl_pct <= -0.8 * r.daily_pnl_limit)
  );

  $: message = !r ? '' :
    r.optimizer_status === 'risk-off' ? 'Optimizer is in risk-off mode — reducing exposure across assets.' :
    (r.portfolio_floor > 0 && r.portfolio_usd < r.portfolio_floor * 1.2) ? `Portfolio value is approaching the floor ($${r.portfolio_floor.toLocaleString()}).` :
    'Daily loss is approaching the configured limit.';
</script>

{#if warning}
  <div class="flex items-center justify-between gap-3 px-4 py-2.5 rounded-[var(--radius-card)] bg-warn-soft text-warn text-sm">
    <span>{message}</span>
    <button class="shrink-0 font-medium underline underline-offset-2" on:click={() => setTab('advanced')}>Details →</button>
  </div>
{/if}

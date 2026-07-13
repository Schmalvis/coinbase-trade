<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { executeTrade } from '../api';

  export let open: boolean = false;

  const dispatch = createEventDispatcher();

  const tokens = ['ETH', 'USDC', 'CBBTC', 'CBETH'];

  let fromToken = 'ETH';
  let toToken = 'USDC';
  let amount = '';
  let loading = false;
  let result: string | null = null;
  let errorMsg: string | null = null;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  function close() {
    result = null;
    errorMsg = null;
    amount = '';
    dispatch('close');
  }

  function swapDirection() {
    const prevFrom = fromToken;
    fromToken = toToken;
    toToken = prevFrom;
  }

  async function handleExecute() {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      errorMsg = 'Enter a valid amount';
      return;
    }
    loading = true;
    errorMsg = null;
    result = null;
    try {
      const res = await executeTrade(fromToken, toToken, amount);
      if (res.ok) {
        if (res.dryRun || res.dry_run) {
          result = 'Dry run — no real trade executed.';
        } else {
          result = res.txHash ? `Tx: ${res.txHash}` : 'Trade submitted.';
        }
      } else {
        errorMsg = 'Trade failed.';
      }
    } catch (e: any) {
      errorMsg = e.message ?? 'Unknown error';
    } finally {
      loading = false;
    }
  }

  const inputCls = 'w-full bg-[var(--bg-inset)] border border-[var(--border-hi)] rounded-[var(--radius-btn)] px-3 py-1.5 text-sm focus:outline-none focus:border-clay';
  const selectCls = 'w-full bg-[var(--bg-inset)] border border-[var(--border-hi)] rounded-[var(--radius-btn)] px-3 py-1.5 text-sm focus:outline-none focus:border-clay';
  const labelCls = 'block text-xs text-[var(--text-secondary)] mb-1';
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    on:click={close}
    role="dialog"
    aria-modal="true"
    aria-label="Trade"
  >
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div
      class="bg-[var(--bg-card)] rounded-none sm:rounded-2xl border border-[var(--border)] w-full max-w-sm max-h-[100dvh] sm:max-h-none overflow-y-auto p-6 shadow-[var(--shadow)]"
      on:click|stopPropagation
      role="document"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-semibold font-display">Execute trade</h2>
        <button class="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none" on:click={close} aria-label="Close">&times;</button>
      </div>

      <div class="mb-2">
        <label class={labelCls} for="trade-from">From</label>
        <select id="trade-from" class={selectCls} bind:value={fromToken}>
          {#each tokens as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </div>

      <div class="flex justify-center my-1">
        <button
          type="button"
          on:click={swapDirection}
          class="p-1.5 rounded-full border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-clay hover:border-clay transition-colors"
          aria-label="Swap direction"
          title="Swap direction"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 4v13M7 4 4 7M7 4l3 3M17 20V7M17 20l-3-3M17 20l3-3" />
          </svg>
        </button>
      </div>

      <div class="mb-3">
        <label class={labelCls} for="trade-to">To</label>
        <select id="trade-to" class={selectCls} bind:value={toToken}>
          {#each tokens.filter(t => t !== fromToken) as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </div>

      <div class="mb-4">
        <label class={labelCls} for="trade-amount">Amount</label>
        <input id="trade-amount" type="number" class={inputCls} bind:value={amount} step="any" min="0" placeholder="0.0" />
      </div>

      {#if result}
        <div class="mb-3 px-3 py-2 rounded-[var(--radius-btn)] bg-gain-soft text-gain text-xs">{result}</div>
      {/if}
      {#if errorMsg}
        <div class="mb-3 px-3 py-2 rounded-[var(--radius-btn)] bg-loss-soft text-loss text-xs">{errorMsg}</div>
      {/if}

      <div class="flex gap-2 justify-end">
        <button
          class="px-4 py-1.5 rounded-[var(--radius-btn)] text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          on:click={close}
        >Close</button>
        <button
          class="px-4 py-1.5 rounded-[var(--radius-btn)] text-sm font-semibold bg-clay hover:bg-clay-hover text-white transition-colors disabled:opacity-50"
          on:click={handleExecute}
          disabled={loading}
        >{loading ? 'Executing…' : 'Execute'}</button>
      </div>
    </div>
  </div>
{/if}

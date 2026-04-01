<script lang="ts">
  import { bulkEnableAssets, bulkDismissAssets } from '../api';
  import { loadAssets } from '../stores/assets';

  export let selected: Set<string>;
  export let onComplete: () => void;

  let loading = false;
  let statusMessage = '';

  async function handleAction(action: 'enable' | 'dismiss') {
    loading = true;
    statusMessage = '';
    const addresses = [...selected];
    try {
      const fn = action === 'enable' ? bulkEnableAssets : bulkDismissAssets;
      const result = await fn(addresses);
      const verb = action === 'enable' ? 'enabled' : 'dismissed';
      statusMessage = `${result.succeeded} ${verb}${result.skipped ? `, ${result.skipped} skipped` : ''}`;
      await loadAssets();
      onComplete();
    } catch {
      statusMessage = 'Action failed — please try again';
    } finally {
      loading = false;
    }
  }
</script>

{#if selected.size > 0}
  <div class="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-6 py-4
              bg-[var(--bg-card)] border-t border-[var(--border)] shadow-lg">
    <span class="text-sm text-[var(--text-secondary)]">
      {selected.size} asset{selected.size === 1 ? '' : 's'} selected
      {#if statusMessage}
        <span class="ml-2 text-[var(--text-primary)]">— {statusMessage}</span>
      {/if}
    </span>
    <div class="flex gap-3">
      <button
        disabled={loading}
        on:click={() => handleAction('enable')}
        class="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50
               disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {loading ? '…' : 'Enable Selected'}
      </button>
      <button
        disabled={loading}
        on:click={() => handleAction('dismiss')}
        class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50
               disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {loading ? '…' : 'Dismiss Selected'}
      </button>
    </div>
  </div>
{/if}

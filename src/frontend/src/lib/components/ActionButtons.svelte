<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { executeControl } from '../api';

  const dispatch = createEventDispatcher();

  let pauseLoading = false;
  let resumeLoading = false;

  async function handlePause() {
    pauseLoading = true;
    try {
      await executeControl('pause');
    } catch (e) {
      console.warn('Pause failed:', e);
    }
    pauseLoading = false;
  }

  async function handleResume() {
    resumeLoading = true;
    try { await executeControl('resume'); } catch {}
    resumeLoading = false;
  }
</script>

<div class="flex gap-2 flex-wrap">
  <button
    class="px-4 py-1.5 rounded-lg text-sm font-semibold border border-red-500/60 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
    on:click={handlePause}
    disabled={pauseLoading}
  >{pauseLoading ? '...' : 'PAUSE'}</button>

  <button
    class="px-4 py-1.5 rounded-lg text-sm font-semibold border border-green-500/60 text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-50"
    on:click={handleResume}
    disabled={resumeLoading}
  >{resumeLoading ? '...' : 'RESUME'}</button>

  <button
    class="px-4 py-1.5 rounded-lg text-sm font-semibold border border-[var(--border-hi)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
    on:click={() => dispatch('trade')}
  >TRADE</button>
</div>

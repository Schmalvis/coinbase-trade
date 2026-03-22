<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { settings, loadSettings } from '../stores/settings';
  import { saveSettings } from '../api';

  export let open: boolean = false;

  const dispatch = createEventDispatcher();

  let activeTab = 'strategy';

  // Form fields — strategy
  let strategy = 'threshold';
  let dropPct = 3;
  let risePct = 3;
  let smaShort = 5;
  let smaLong = 20;

  // Form fields — trading
  let tradeInterval = 60;
  let tradeCooldown = 300;
  let maxTradeEth = 0.1;
  let maxTradeUsdc = 200;
  let dryRun: string | boolean = false;

  // Form fields — optimizer
  let maxPositionPct = 40;
  let maxDailyLossPct = 5;
  let maxRotationPct = 25;
  let maxDailyRotations = 10;
  let portfolioFloorUsd = 100;
  let minRotationGainPct = 2;
  let maxCashPct = 80;
  let optimizerIntervalSeconds = 300;
  let rotationSellThreshold = -20;
  let rotationBuyThreshold = 30;
  let minRotationScoreDelta = 40;

  // Form fields — notifications
  let telegramMode = 'all';
  let digestTimes = '';
  let quietStart = '';
  let quietEnd = '';

  let saving = false;
  let errorMsg = '';

  function populateFromSettings(s: Record<string, any>) {
    strategy = String(s['STRATEGY'] ?? 'threshold');
    dropPct = Number(s['PRICE_DROP_THRESHOLD_PCT'] ?? 3);
    risePct = Number(s['PRICE_RISE_TARGET_PCT'] ?? 3);
    smaShort = Number(s['SMA_SHORT_WINDOW'] ?? 5);
    smaLong = Number(s['SMA_LONG_WINDOW'] ?? 20);
    tradeInterval = Number(s['TRADE_INTERVAL_SECONDS'] ?? 60);
    tradeCooldown = Number(s['TRADE_COOLDOWN_SECONDS'] ?? 300);
    maxTradeEth = Number(s['MAX_TRADE_SIZE_ETH'] ?? 0.1);
    maxTradeUsdc = Number(s['MAX_TRADE_SIZE_USDC'] ?? 200);
    dryRun = s['DRY_RUN'] ?? false;
    maxPositionPct = Number(s['MAX_POSITION_PCT'] ?? 40);
    maxDailyLossPct = Number(s['MAX_DAILY_LOSS_PCT'] ?? 5);
    maxRotationPct = Number(s['MAX_ROTATION_PCT'] ?? 25);
    maxDailyRotations = Number(s['MAX_DAILY_ROTATIONS'] ?? 10);
    portfolioFloorUsd = Number(s['PORTFOLIO_FLOOR_USD'] ?? 100);
    minRotationGainPct = Number(s['MIN_ROTATION_GAIN_PCT'] ?? 2);
    maxCashPct = Number(s['MAX_CASH_PCT'] ?? 80);
    optimizerIntervalSeconds = Number(s['OPTIMIZER_INTERVAL_SECONDS'] ?? 300);
    rotationSellThreshold = Number(s['ROTATION_SELL_THRESHOLD'] ?? -20);
    rotationBuyThreshold = Number(s['ROTATION_BUY_THRESHOLD'] ?? 30);
    minRotationScoreDelta = Number(s['MIN_ROTATION_SCORE_DELTA'] ?? 40);
    telegramMode = String(s['TELEGRAM_MODE'] ?? 'all');
    digestTimes = String(s['TELEGRAM_DIGEST_TIMES'] ?? '');
    quietStart = String(s['TELEGRAM_QUIET_START'] ?? '');
    quietEnd = String(s['TELEGRAM_QUIET_END'] ?? '');
  }

  onMount(() => loadSettings());

  const unsub = settings.subscribe(s => {
    if (s) populateFromSettings(s);
  });

  onDestroy(unsub);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') dispatch('close');
  }

  async function handleSave() {
    saving = true;
    errorMsg = '';
    const payload: Record<string, any> = {
      STRATEGY: strategy,
      PRICE_DROP_THRESHOLD_PCT: dropPct,
      PRICE_RISE_TARGET_PCT: risePct,
      SMA_SHORT_WINDOW: smaShort,
      SMA_LONG_WINDOW: smaLong,
      TRADE_INTERVAL_SECONDS: tradeInterval,
      TRADE_COOLDOWN_SECONDS: tradeCooldown,
      MAX_TRADE_SIZE_ETH: maxTradeEth,
      MAX_TRADE_SIZE_USDC: maxTradeUsdc,
      MAX_POSITION_PCT: maxPositionPct,
      MAX_DAILY_LOSS_PCT: maxDailyLossPct,
      MAX_ROTATION_PCT: maxRotationPct,
      MAX_DAILY_ROTATIONS: maxDailyRotations,
      PORTFOLIO_FLOOR_USD: portfolioFloorUsd,
      MIN_ROTATION_GAIN_PCT: minRotationGainPct,
      MAX_CASH_PCT: maxCashPct,
      OPTIMIZER_INTERVAL_SECONDS: optimizerIntervalSeconds,
      ROTATION_SELL_THRESHOLD: rotationSellThreshold,
      ROTATION_BUY_THRESHOLD: rotationBuyThreshold,
      MIN_ROTATION_SCORE_DELTA: minRotationScoreDelta,
      TELEGRAM_MODE: telegramMode,
      TELEGRAM_DIGEST_TIMES: digestTimes,
      TELEGRAM_QUIET_START: quietStart,
      TELEGRAM_QUIET_END: quietEnd,
    };
    try {
      const res = await saveSettings(payload);
      if (!res.ok) {
        errorMsg = res.error ?? 'Save failed';
      } else {
        await loadSettings();
        dispatch('close');
      }
    } catch (e: any) {
      errorMsg = e.message ?? 'Unknown error';
    } finally {
      saving = false;
    }
  }

  function tabClass(tab: string) {
    return activeTab === tab
      ? 'px-3 py-1.5 rounded-md text-sm font-medium bg-blue-500/20 text-blue-400'
      : 'px-3 py-1.5 rounded-md text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]';
  }

  const numInput = 'w-full bg-[var(--bg-primary)] border border-[var(--border-hi)] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500';
  const label = 'block text-xs text-[var(--text-secondary)] mb-1';
  const fieldGroup = 'mb-3';
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <!-- Backdrop -->
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    on:click={() => dispatch('close')}
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
  >
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <!-- Card -->
    <div
      class="bg-[var(--bg-card)] rounded-2xl border border-[var(--border)] w-full max-w-lg max-h-[80vh] overflow-y-auto p-6 shadow-xl"
      on:click|stopPropagation
      role="document"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-semibold">Settings</h2>
        <button
          class="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none"
          on:click={() => dispatch('close')}
          aria-label="Close"
        >&times;</button>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 bg-[var(--bg-primary)] rounded-lg p-0.5 mb-5">
        {#each ['strategy','trading','optimizer','notifications'] as tab}
          <button class={tabClass(tab)} on:click={() => { activeTab = tab; }}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        {/each}
      </div>

      <!-- Strategy tab -->
      {#if activeTab === 'strategy'}
        <div class={fieldGroup}>
          <span class={label}>Default Strategy (new assets)</span>
          <div class="flex gap-1">
            {#each ['threshold','sma'] as opt}
              <button
                class="px-3 py-1 rounded-md text-sm border transition-colors {strategy === opt ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'border-[var(--border-hi)] text-[var(--text-secondary)]'}"
                on:click={() => strategy = opt}
              >{opt}</button>
            {/each}
          </div>
        </div>
        <div class={fieldGroup}>
          <label class={label}>Price Drop Threshold %</label>
          <input type="number" class={numInput} bind:value={dropPct} step="0.1" min="0" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Price Rise Target %</label>
          <input type="number" class={numInput} bind:value={risePct} step="0.1" min="0" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>SMA Short Window</label>
          <input type="number" class={numInput} bind:value={smaShort} min="1" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>SMA Long Window</label>
          <input type="number" class={numInput} bind:value={smaLong} min="2" />
        </div>
      {/if}

      <!-- Trading tab -->
      {#if activeTab === 'trading'}
        <div class={fieldGroup}>
          <label class={label}>Trade Interval (seconds)</label>
          <input type="number" class={numInput} bind:value={tradeInterval} min="10" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Trade Cooldown (seconds)</label>
          <input type="number" class={numInput} bind:value={tradeCooldown} min="0" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Max Trade Size ETH</label>
          <input type="number" class={numInput} bind:value={maxTradeEth} step="0.01" min="0" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Max Trade Size USDC</label>
          <input type="number" class={numInput} bind:value={maxTradeUsdc} step="1" min="0" />
        </div>
        <div class={fieldGroup}>
          <span class={label}>DRY_RUN (read-only)</span>
          <div class="px-3 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-muted)]">
            {dryRun === true || dryRun === 'true' ? 'enabled' : 'disabled'}
          </div>
        </div>
      {/if}

      <!-- Optimizer tab -->
      {#if activeTab === 'optimizer'}
        {#each [
          ['MAX_POSITION_PCT','Max Position %',maxPositionPct],
          ['MAX_DAILY_LOSS_PCT','Max Daily Loss %',maxDailyLossPct],
          ['MAX_ROTATION_PCT','Max Rotation %',maxRotationPct],
          ['MAX_DAILY_ROTATIONS','Max Daily Rotations',maxDailyRotations],
          ['PORTFOLIO_FLOOR_USD','Portfolio Floor USD',portfolioFloorUsd],
          ['MIN_ROTATION_GAIN_PCT','Min Rotation Gain %',minRotationGainPct],
          ['MAX_CASH_PCT','Max Cash %',maxCashPct],
          ['OPTIMIZER_INTERVAL_SECONDS','Optimizer Interval (s)',optimizerIntervalSeconds],
          ['ROTATION_SELL_THRESHOLD','Rotation Sell Threshold',rotationSellThreshold],
          ['ROTATION_BUY_THRESHOLD','Rotation Buy Threshold',rotationBuyThreshold],
          ['MIN_ROTATION_SCORE_DELTA','Min Score Delta',minRotationScoreDelta],
        ] as [key, lbl]}
          <div class={fieldGroup}>
            <label class={label}>{lbl}</label>
            {#if key === 'MAX_POSITION_PCT'}
              <input type="number" class={numInput} bind:value={maxPositionPct} />
            {:else if key === 'MAX_DAILY_LOSS_PCT'}
              <input type="number" class={numInput} bind:value={maxDailyLossPct} />
            {:else if key === 'MAX_ROTATION_PCT'}
              <input type="number" class={numInput} bind:value={maxRotationPct} />
            {:else if key === 'MAX_DAILY_ROTATIONS'}
              <input type="number" class={numInput} bind:value={maxDailyRotations} />
            {:else if key === 'PORTFOLIO_FLOOR_USD'}
              <input type="number" class={numInput} bind:value={portfolioFloorUsd} />
            {:else if key === 'MIN_ROTATION_GAIN_PCT'}
              <input type="number" class={numInput} bind:value={minRotationGainPct} step="0.1" />
            {:else if key === 'MAX_CASH_PCT'}
              <input type="number" class={numInput} bind:value={maxCashPct} />
            {:else if key === 'OPTIMIZER_INTERVAL_SECONDS'}
              <input type="number" class={numInput} bind:value={optimizerIntervalSeconds} />
            {:else if key === 'ROTATION_SELL_THRESHOLD'}
              <input type="number" class={numInput} bind:value={rotationSellThreshold} />
            {:else if key === 'ROTATION_BUY_THRESHOLD'}
              <input type="number" class={numInput} bind:value={rotationBuyThreshold} />
            {:else if key === 'MIN_ROTATION_SCORE_DELTA'}
              <input type="number" class={numInput} bind:value={minRotationScoreDelta} />
            {/if}
          </div>
        {/each}
      {/if}

      <!-- Notifications tab -->
      {#if activeTab === 'notifications'}
        <div class={fieldGroup}>
          <span class={label}>Telegram Mode</span>
          <div class="flex gap-1 flex-wrap">
            {#each ['all','important_only','digest','off'] as mode}
              <button
                class="px-3 py-1 rounded-md text-sm border transition-colors {telegramMode === mode ? 'bg-blue-500/20 text-blue-400 border-blue-500/40' : 'border-[var(--border-hi)] text-[var(--text-secondary)]'}"
                on:click={() => telegramMode = mode}
              >{mode}</button>
            {/each}
          </div>
        </div>
        <div class={fieldGroup}>
          <label class={label}>Digest Times (comma-separated HH:MM)</label>
          <input type="text" class={numInput} bind:value={digestTimes} placeholder="08:00,20:00" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Quiet Start (HH:MM UTC)</label>
          <input type="text" class={numInput} bind:value={quietStart} placeholder="22:00" />
        </div>
        <div class={fieldGroup}>
          <label class={label}>Quiet End (HH:MM UTC)</label>
          <input type="text" class={numInput} bind:value={quietEnd} placeholder="08:00" />
        </div>
      {/if}

      {#if errorMsg}
        <p class="text-red-400 text-xs mt-2">{errorMsg}</p>
      {/if}

      <!-- Actions -->
      <div class="flex gap-2 justify-end mt-5">
        <button
          class="px-4 py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          on:click={() => dispatch('close')}
        >Cancel</button>
        <button
          class="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
          on:click={handleSave}
          disabled={saving}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

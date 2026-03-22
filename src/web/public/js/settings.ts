// Settings modal open/close/save
import { appState } from './state.js';
import { getAuthHeaders } from './api.js';
import { loadStatus, closeModal } from './status.js';

export function openSettings() {
  fetch('/api/settings').then(function(r){ return r.json(); }).then(function(s: any) {
    appState.settingsCache = s;
    appState.selectedStrategy = s.STRATEGY || 'threshold';
    const fields: Record<string, string> = {
      cfgDropPct: s.PRICE_DROP_THRESHOLD_PCT,
      cfgRisePct: s.PRICE_RISE_TARGET_PCT,
      cfgSmaShort: s.SMA_SHORT_WINDOW,
      cfgSmaLong: s.SMA_LONG_WINDOW,
      cfgMaxEth: s.MAX_TRADE_SIZE_ETH,
      cfgMaxUsdc: s.MAX_TRADE_SIZE_USDC,
      cfgCooldown: s.TRADE_COOLDOWN_SECONDS,
      cfgPollInterval: s.POLL_INTERVAL_SECONDS,
      cfgTradeInterval: s.TRADE_INTERVAL_SECONDS,
    };
    Object.keys(fields).forEach(function(id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(fields[id]);
    });
    const dryRunEl = document.getElementById('cfgDryRun') as HTMLInputElement | null;
    if (dryRunEl) dryRunEl.checked = !!s.DRY_RUN;

    // Optimizer fields
    const optFields = ['cfgMaxPositionPct','cfgMaxDailyLossPct','cfgMaxRotationPct','cfgMaxDailyRotations','cfgPortfolioFloorUsd','cfgMinRotationGainPct','cfgMaxCashPct','cfgOptimizerIntervalSec','cfgRotSellThreshold','cfgRotBuyThreshold','cfgMinRotScoreDelta','cfgRiskOffThreshold','cfgRiskOnThreshold','cfgDefaultFeeEstPct'];
    const optKeys = ['MAX_POSITION_PCT','MAX_DAILY_LOSS_PCT','MAX_ROTATION_PCT','MAX_DAILY_ROTATIONS','PORTFOLIO_FLOOR_USD','MIN_ROTATION_GAIN_PCT','MAX_CASH_PCT','OPTIMIZER_INTERVAL_SECONDS','ROTATION_SELL_THRESHOLD','ROTATION_BUY_THRESHOLD','MIN_ROTATION_SCORE_DELTA','RISK_OFF_THRESHOLD','RISK_ON_THRESHOLD','DEFAULT_FEE_ESTIMATE_PCT'];
    optFields.forEach(function(fid, i) { const el = document.getElementById(fid) as HTMLInputElement | null; if (el && s[optKeys[i]] != null) el.value = s[optKeys[i]]; });

    // Notification fields
    const telegramMode = document.getElementById('cfgTelegramMode') as HTMLSelectElement | null;
    if (telegramMode) telegramMode.value = s.TELEGRAM_MODE || 'all';
    const digestTimes = document.getElementById('cfgDigestTimes') as HTMLInputElement | null;
    if (digestTimes) digestTimes.value = s.TELEGRAM_DIGEST_TIMES || '08:00,20:00';
    const quietStart = document.getElementById('cfgQuietStart') as HTMLInputElement | null;
    if (quietStart) quietStart.value = s.TELEGRAM_QUIET_START || '';
    const quietEnd = document.getElementById('cfgQuietEnd') as HTMLInputElement | null;
    if (quietEnd) quietEnd.value = s.TELEGRAM_QUIET_END || '';

    // Security tab
    const secretEl = document.getElementById('cfgDashboardSecret') as HTMLInputElement | null;
    if (secretEl) secretEl.value = localStorage.getItem('cb-dashboard-secret') || '';

    selectStrategy(appState.selectedStrategy);
    switchTab('strategy');
    clearSettingsErrors();
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'flex';
  });
}

export function selectStrategy(s: string) {
  appState.selectedStrategy = s;
  const pillThreshold = document.getElementById('pillThreshold');
  const pillSma = document.getElementById('pillSma');
  const pillGrid = document.getElementById('pillGrid');
  if (pillThreshold) pillThreshold.classList.toggle('active', s === 'threshold');
  if (pillSma) pillSma.classList.toggle('active', s === 'sma');
  if (pillGrid) pillGrid.classList.toggle('active', s === 'grid');
  const thresholdParams = document.getElementById('thresholdParams');
  const smaParams = document.getElementById('smaParams');
  if (thresholdParams) thresholdParams.style.display = s === 'threshold' ? '' : 'none';
  if (smaParams) smaParams.style.display = s === 'sma' ? '' : 'none';
}

export function switchTab(tab: string) {
  const tabs = ['Strategy', 'Trading', 'Optimizer', 'Notify', 'Security'];
  const tabIds = ['tabStrategy', 'tabTrading', 'tabOptimizer', 'tabNotify', 'tabSecurity'];
  const btnIds = ['tabStrategyBtn', 'tabTradingBtn', 'tabOptimizerBtn', 'tabNotifyBtn', 'tabSecurityBtn'];
  const tabLower = tabs.map(function(t) { return t.toLowerCase(); });
  tabIds.forEach(function(id, i) {
    const el = document.getElementById(id);
    if (el) el.style.display = tabLower[i] === tab ? '' : 'none';
  });
  btnIds.forEach(function(id, i) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', tabLower[i] === tab);
  });
}

export function clearSettingsErrors() {
  ['errDropPct','errRisePct','errSmaShort','errSmaLong','errMaxEth','errMaxUsdc','errCooldown','errPollInterval','errTradeInterval'].forEach(function(id) { const el = document.getElementById(id); if (el) el.textContent = ''; });
}

export async function saveSettings() {
  clearSettingsErrors();
  const btn = document.getElementById('saveSettingsBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  const changes: any = {
    STRATEGY: appState.selectedStrategy,
    PRICE_DROP_THRESHOLD_PCT: parseFloat((document.getElementById('cfgDropPct') as HTMLInputElement).value),
    PRICE_RISE_TARGET_PCT: parseFloat((document.getElementById('cfgRisePct') as HTMLInputElement).value),
    SMA_SHORT_WINDOW: parseInt((document.getElementById('cfgSmaShort') as HTMLInputElement).value),
    SMA_LONG_WINDOW: parseInt((document.getElementById('cfgSmaLong') as HTMLInputElement).value),
    DRY_RUN: (document.getElementById('cfgDryRun') as HTMLInputElement).checked,
    MAX_TRADE_SIZE_ETH: parseFloat((document.getElementById('cfgMaxEth') as HTMLInputElement).value),
    MAX_TRADE_SIZE_USDC: parseFloat((document.getElementById('cfgMaxUsdc') as HTMLInputElement).value),
    TRADE_COOLDOWN_SECONDS: parseInt((document.getElementById('cfgCooldown') as HTMLInputElement).value),
    POLL_INTERVAL_SECONDS: parseInt((document.getElementById('cfgPollInterval') as HTMLInputElement).value),
    TRADE_INTERVAL_SECONDS: parseInt((document.getElementById('cfgTradeInterval') as HTMLInputElement).value)
  };
  const optMap: Record<string, string> = { cfgMaxPositionPct:'MAX_POSITION_PCT', cfgMaxDailyLossPct:'MAX_DAILY_LOSS_PCT', cfgMaxRotationPct:'MAX_ROTATION_PCT', cfgMaxDailyRotations:'MAX_DAILY_ROTATIONS', cfgPortfolioFloorUsd:'PORTFOLIO_FLOOR_USD', cfgMinRotationGainPct:'MIN_ROTATION_GAIN_PCT', cfgMaxCashPct:'MAX_CASH_PCT', cfgOptimizerIntervalSec:'OPTIMIZER_INTERVAL_SECONDS', cfgRotSellThreshold:'ROTATION_SELL_THRESHOLD', cfgRotBuyThreshold:'ROTATION_BUY_THRESHOLD', cfgMinRotScoreDelta:'MIN_ROTATION_SCORE_DELTA', cfgRiskOffThreshold:'RISK_OFF_THRESHOLD', cfgRiskOnThreshold:'RISK_ON_THRESHOLD', cfgDefaultFeeEstPct:'DEFAULT_FEE_ESTIMATE_PCT' };
  Object.keys(optMap).forEach(function(elId) { const el = document.getElementById(elId) as HTMLInputElement | null; if (el && el.value !== '') changes[optMap[elId]] = parseFloat(el.value); });
  // Notification settings
  const telegramMode = document.getElementById('cfgTelegramMode') as HTMLSelectElement | null;
  if (telegramMode) changes.TELEGRAM_MODE = telegramMode.value;
  const digestTimes = document.getElementById('cfgDigestTimes') as HTMLInputElement | null;
  if (digestTimes) changes.TELEGRAM_DIGEST_TIMES = digestTimes.value;
  const quietStart = document.getElementById('cfgQuietStart') as HTMLInputElement | null;
  if (quietStart) changes.TELEGRAM_QUIET_START = quietStart.value;
  const quietEnd = document.getElementById('cfgQuietEnd') as HTMLInputElement | null;
  if (quietEnd) changes.TELEGRAM_QUIET_END = quietEnd.value;
  try {
    const data = await fetch('/api/settings', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ changes: changes }) }).then(function(r){ return r.json(); });
    if (data.ok) { closeModal('settingsModal'); await loadStatus(); } else { showSettingsError(data.field, data.error); }
  } catch (e: any) { alert('Save failed: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } }
}

function showSettingsError(field: string, msg: string) {
  const m: Record<string, string> = { PRICE_DROP_THRESHOLD_PCT:'errDropPct', PRICE_RISE_TARGET_PCT:'errRisePct', SMA_SHORT_WINDOW:'errSmaShort', SMA_LONG_WINDOW:'errSmaLong', MAX_TRADE_SIZE_ETH:'errMaxEth', MAX_TRADE_SIZE_USDC:'errMaxUsdc', TRADE_COOLDOWN_SECONDS:'errCooldown', POLL_INTERVAL_SECONDS:'errPollInterval', TRADE_INTERVAL_SECONDS:'errTradeInterval' };
  const errId = m[field]; if (errId) { const el = document.getElementById(errId); if (el) el.textContent = msg; } else alert(msg);
}

function isSettingsDirty(): boolean {
  if (!appState.settingsCache || !Object.keys(appState.settingsCache).length) return false;
  const s = appState.settingsCache;
  return appState.selectedStrategy !== s.STRATEGY
    || parseFloat((document.getElementById('cfgDropPct') as HTMLInputElement).value) !== s.PRICE_DROP_THRESHOLD_PCT
    || parseFloat((document.getElementById('cfgRisePct') as HTMLInputElement).value) !== s.PRICE_RISE_TARGET_PCT
    || parseInt((document.getElementById('cfgSmaShort') as HTMLInputElement).value) !== s.SMA_SHORT_WINDOW
    || parseInt((document.getElementById('cfgSmaLong') as HTMLInputElement).value) !== s.SMA_LONG_WINDOW
    || (document.getElementById('cfgDryRun') as HTMLInputElement).checked !== !!s.DRY_RUN
    || parseFloat((document.getElementById('cfgMaxEth') as HTMLInputElement).value) !== s.MAX_TRADE_SIZE_ETH
    || parseFloat((document.getElementById('cfgMaxUsdc') as HTMLInputElement).value) !== s.MAX_TRADE_SIZE_USDC
    || parseInt((document.getElementById('cfgCooldown') as HTMLInputElement).value) !== s.TRADE_COOLDOWN_SECONDS
    || parseInt((document.getElementById('cfgPollInterval') as HTMLInputElement).value) !== s.POLL_INTERVAL_SECONDS
    || parseInt((document.getElementById('cfgTradeInterval') as HTMLInputElement).value) !== s.TRADE_INTERVAL_SECONDS;
}

export function closeSettingsModal() { if (isSettingsDirty() && !confirm('Discard unsaved changes?')) return; closeModal('settingsModal'); }
export function closeSettingsOnBackdrop(event: Event) { if (event.target === document.getElementById('settingsModal')) closeSettingsModal(); }

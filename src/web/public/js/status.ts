// Status loading, holdings, wallet, trades, network, controls, watchlist, rotations
// NOTE: innerHTML usage preserved from original inline JS — data comes from our own API
import { appState } from './state.js';
import { getAuthHeaders, postJSON } from './api.js';
import { populateCandleAssetSelect, renderAssetSelector } from './charts.js';

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.textContent || '';
}

export function renderNetworkSelector() {
  const el = document.getElementById('networkSelector');
  if (!el) return;
  el.textContent = '';
  for (let i = 0; i < appState.availableNetworks.length; i++) {
    const n = appState.availableNetworks[i];
    const isActive = n === appState.activeNetwork;
    const isMainnet = n.indexOf('mainnet') !== -1;
    const btn = document.createElement('button');
    btn.className = 'net-btn ' + (isActive ? 'active' : '') + ' ' + (isMainnet ? 'mainnet' : '');
    btn.textContent = n;
    btn.onclick = function() { switchNetwork(n); };
    el.appendChild(btn);
  }
}

export async function switchNetwork(network: string) {
  if (network === appState.activeNetwork) return;
  await fetch('/api/network', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ network: network }) });
  appState.activeNetwork = network;
  renderNetworkSelector();
  await (window as any).refresh();
}

export async function loadStatus() {
  try {
    const s = await fetch('/api/status').then(function(r){ return r.json(); });
    if (s.availableNetworks && s.availableNetworks.length) {
      appState.availableNetworks = s.availableNetworks;
      appState.activeNetwork = s.activeNetwork;
      renderNetworkSelector();
    }
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = s.status;
      statusEl.className = 'value status-' + s.status;
      if (s.dryRun) {
        const badge = document.createElement('span');
        badge.className = 'dry-badge';
        badge.textContent = 'Dry';
        statusEl.appendChild(badge);
      }
    }
    const priceEl = document.getElementById('price');
    if (priceEl) priceEl.textContent = s.lastPrice ? '$' + s.lastPrice.toFixed(2) : '--';
    const stratEl = document.getElementById('strategy');
    if (stratEl) stratEl.textContent = (s.ethStrategy || s.strategy) ? 'Strategy: ' + (s.ethStrategy || s.strategy) : '';
    const ethEl = document.getElementById('ethBalance');
    if (ethEl) ethEl.textContent = s.ethBalance != null ? s.ethBalance.toFixed(6) + ' ETH' : '--';
    const usdcEl = document.getElementById('usdcBalance');
    if (usdcEl) usdcEl.textContent = s.usdcBalance != null ? s.usdcBalance.toFixed(2) + ' USDC' : '--';
    const portfolioEl = document.getElementById('portfolio');
    if (portfolioEl) portfolioEl.textContent = s.portfolioUsd != null ? '$' + s.portfolioUsd.toFixed(2) : '--';
    const lastTradeEl = document.getElementById('lastTrade');
    if (lastTradeEl) lastTradeEl.textContent = s.lastTradeAt ? 'Last trade: ' + new Date(s.lastTradeAt).toLocaleTimeString() : 'No trades yet';
    const updateEl = document.getElementById('lastUpdate');
    if (updateEl) updateEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    populateCandleAssetSelect();
  } catch (e) { console.error('loadStatus:', e); }
}

export function renderHoldings() {
  const grid = document.getElementById('holdingsGrid');
  const title = document.getElementById('holdingsTitle');
  if (!grid || !title) return;
  const allExtras = appState.assetList.filter(function(a: any){ return a.symbol !== 'ETH' && a.symbol !== 'USDC' && a.balance != null; });
  const seenH: Record<string, boolean> = {};
  const extras = allExtras.filter(function(a: any) { if (seenH[a.symbol]) return false; seenH[a.symbol] = true; return true; });
  if (!extras.length) { grid.style.display = 'none'; title.style.display = 'none'; return; }
  title.style.display = '';
  grid.style.display = '';
  grid.textContent = '';
  extras.forEach(function(a: any) {
    const usdValue = (a.balance != null && a.price != null) ? (a.balance * a.price).toFixed(2) : null;
    const decimals = Math.max(0, a.decimals != null ? a.decimals : 6);
    const balFmt = a.balance != null ? Number(a.balance).toFixed(decimals <= 8 ? decimals : 6) : '--';
    const card = document.createElement('div');
    card.className = 'card';
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = a.symbol;
    const val = document.createElement('div');
    val.className = 'value';
    val.textContent = balFmt;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = usdValue ? '$' + usdValue : '';
    card.appendChild(lbl);
    card.appendChild(val);
    card.appendChild(sub);
    grid.appendChild(card);
  });
}

export function renderTradePairButtons() {
  const container = document.getElementById('tradePairBtns');
  if (!container) return;
  const tradeable = appState.assetList.filter(function(a: any){ return a.tradeMethod === 'agentkit'; });
  container.textContent = '';
  tradeable.forEach(function(a: any) {
    const btn = document.createElement('button');
    btn.className = 'pill' + (appState.tradePair.from === a.symbol ? ' active' : '');
    btn.textContent = a.symbol;
    btn.dataset.symbol = a.symbol;
    btn.onclick = function() { setTradePairFrom(a.symbol); };
    container.appendChild(btn);
  });
}

function setTradePairFrom(symbol: string) { setTradePair(symbol, symbol === 'USDC' ? 'ETH' : 'USDC'); }

export function setTradePair(from: string, to: string) {
  appState.tradePair = { from: from, to: to };
  document.querySelectorAll('#tradePairBtns button').forEach(function(btn: any) { btn.classList.toggle('active', btn.dataset.symbol === from); });
  const quoteBox = document.getElementById('tradeQuoteBox');
  if (quoteBox) quoteBox.style.display = 'none';
  const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = true;
  appState.tradeQuotedFromAmount = null;
  updateTradeLabel();
}

export function setTradeSide(side: string) {
  appState.tradeSide = side;
  const spendEl = document.getElementById('sideSpend');
  const receiveEl = document.getElementById('sideReceive');
  if (spendEl) spendEl.classList.toggle('active', side === 'from');
  if (receiveEl) receiveEl.classList.toggle('active', side === 'to');
  updateTradeLabel();
  const quoteBox = document.getElementById('tradeQuoteBox');
  if (quoteBox) quoteBox.style.display = 'none';
  const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = true;
  appState.tradeQuotedFromAmount = null;
}

function updateTradeLabel() {
  const token = appState.tradeSide === 'from' ? appState.tradePair.from : appState.tradePair.to;
  const labelEl = document.getElementById('tradeAmountLabel');
  if (labelEl) labelEl.textContent = 'Amount to ' + (appState.tradeSide === 'from' ? 'spend' : 'receive') + ' (' + token + ')';
}

export function renderWalletAddress() {
  const el = document.getElementById('walletAddress');
  if (el) el.textContent = appState.walletExpanded ? appState.fullWalletAddress : appState.fullWalletAddress.slice(0, 6) + '...' + appState.fullWalletAddress.slice(-4);
}

export function toggleWalletAddress() {
  if (!appState.fullWalletAddress) return;
  appState.walletExpanded = !appState.walletExpanded;
  const wrap = document.getElementById('walletWrap');
  if (wrap) wrap.classList.toggle('expanded', appState.walletExpanded);
  renderWalletAddress();
  copyWalletAddress();
}

function copyWalletAddress() {
  if (!appState.fullWalletAddress) return;
  navigator.clipboard.writeText(appState.fullWalletAddress).then(function() {
    const el = document.getElementById('walletCopy');
    if (el) {
      el.textContent = '\u2713'; el.classList.add('copied');
      setTimeout(function() { if (el) { el.textContent = '\u2398'; el.classList.remove('copied'); } }, 2000);
    }
  });
}

export async function loadWallet() {
  try {
    const w = await fetch('/api/wallet').then(function(r){ return r.json(); });
    if (w.address) {
      appState.fullWalletAddress = w.address;
      renderWalletAddress();
      const netEl = document.getElementById('walletNetwork');
      if (netEl) netEl.textContent = w.network || '';
    }
  } catch (e) {}
}

export async function control(action: string) {
  await fetch('/api/control/' + action, { method: 'POST', headers: getAuthHeaders() });
  await loadStatus();
}

export async function loadTrades() {
  try {
    const trades = await fetch('/api/trades?limit=15').then(function(r){ return r.json(); });
    const tbody = document.getElementById('trades');
    if (!tbody) return;
    if (!trades.length) {
      tbody.textContent = '';
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No trades recorded';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    tbody.textContent = '';
    trades.forEach(function(t: any) {
      const tradeNet = t.network || 'unknown';
      const tradeScan = tradeNet.indexOf('mainnet') !== -1 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
      const netLabel = tradeNet === 'base-mainnet' ? 'mainnet' : tradeNet === 'base-sepolia' ? 'sepolia' : tradeNet;
      const netColor = tradeNet.indexOf('mainnet') !== -1 ? 'var(--green)' : 'var(--text-secondary)';

      const tr = document.createElement('tr');

      const td1 = document.createElement('td');
      td1.style.cssText = 'white-space:nowrap;color:var(--text-secondary)';
      td1.textContent = new Date(t.timestamp).toLocaleString();
      tr.appendChild(td1);

      const td2 = document.createElement('td');
      td2.className = t.action;
      td2.textContent = t.action.toUpperCase();
      if (t.dry_run) {
        const drySpan = document.createElement('span');
        drySpan.style.cssText = 'opacity:.4;font-weight:400;font-size:0.7rem';
        drySpan.textContent = ' [dry]';
        td2.appendChild(drySpan);
      }
      tr.appendChild(td2);

      const td3 = document.createElement('td');
      td3.textContent = parseFloat(t.amount_eth).toFixed(6) + ' ETH';
      tr.appendChild(td3);

      const td4 = document.createElement('td');
      td4.textContent = '$' + parseFloat(t.price_usd).toFixed(2);
      tr.appendChild(td4);

      const td5 = document.createElement('td');
      td5.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:0.75rem';
      td5.textContent = t.reason || '';
      tr.appendChild(td5);

      const td6 = document.createElement('td');
      td6.style.cssText = 'font-size:0.65rem;color:' + netColor + ';text-transform:uppercase';
      td6.textContent = netLabel;
      tr.appendChild(td6);

      const td7 = document.createElement('td');
      td7.style.cssText = 'font-size:0.65rem;opacity:.5';
      if (t.tx_hash) {
        const a = document.createElement('a');
        a.href = tradeScan + '/tx/' + t.tx_hash;
        a.target = '_blank';
        a.style.cssText = 'color:var(--accent);text-decoration:none';
        a.textContent = t.tx_hash.slice(0,10) + '...';
        td7.appendChild(a);
      } else {
        td7.textContent = '--';
      }
      tr.appendChild(td7);

      tbody.appendChild(tr);
    });
  } catch (e) { console.error('loadTrades:', e); }
}

export async function loadRotations() {
  try {
    const data = await fetch('/api/rotations?limit=10').then(function(r){ return r.json(); });
    const list = Array.isArray(data) ? data : (data.rotations || []);
    const el = document.getElementById('rotationsList');
    if (!el) return;
    if (!list.length) {
      el.textContent = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:var(--text-muted);font-size:0.72rem';
      msg.textContent = 'No rotations yet. The optimizer will log rotations here when it identifies profitable asset swaps.';
      el.appendChild(msg);
      return;
    }
    el.textContent = '';
    list.forEach(function(r: any) {
      const status = r.status || 'unknown';
      const gainPct = r.gain_pct != null ? (r.gain_pct >= 0 ? '+' : '') + r.gain_pct.toFixed(2) + '%' : '';
      const gainColor = (r.gain_pct || 0) >= 0 ? 'var(--green)' : 'var(--red)';
      const veto = status === 'vetoed' && r.veto_reason ? ' | ' + r.veto_reason : '';
      const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';

      const item = document.createElement('div');
      item.className = 'rotation-item ' + status;

      const pair = document.createElement('div');
      pair.className = 'rotation-pair';
      pair.textContent = (r.sell_symbol||'?') + ' \u2192 ' + (r.buy_symbol||'?');
      item.appendChild(pair);

      const meta = document.createElement('div');
      meta.className = 'rotation-meta';
      const gainSpan = document.createElement('span');
      gainSpan.style.color = gainColor;
      gainSpan.textContent = gainPct;
      meta.appendChild(gainSpan);
      meta.appendChild(document.createTextNode(
        (r.fees != null ? ' | fee: $' + r.fees.toFixed(2) : '') +
        ' | ' + status + veto + ' | ' + ts
      ));
      item.appendChild(meta);

      el.appendChild(item);
    });
  } catch (e) { console.warn('loadRotations:', e); }
}

export async function loadWatchlist() {
  try {
    const data = await fetch('/api/watchlist').then(function(r){ return r.json(); });
    const items = Array.isArray(data) ? data : (data.items || []);
    const el = document.getElementById('watchlistItems');
    if (!el) return;
    if (!items.length) {
      el.textContent = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:var(--text-muted);font-size:0.72rem';
      msg.textContent = 'No watchlist items';
      el.appendChild(msg);
      return;
    }
    el.textContent = '';
    items.forEach(function(w: any) {
      const sym = w.symbol || w;
      const addr = w.address ? ' (' + w.address.slice(0,8) + '...)' : '';
      const item = document.createElement('div');
      item.className = 'watchlist-item';
      const span = document.createElement('span');
      span.textContent = sym + addr;
      item.appendChild(span);
      const btn = document.createElement('button');
      btn.className = 'btn-theme';
      btn.style.cssText = 'padding:0.15rem 0.5rem;font-size:0.6rem;color:var(--red);border-color:var(--red)';
      btn.textContent = 'X';
      btn.onclick = function() { removeWatchlistItem(sym); };
      item.appendChild(btn);
      el.appendChild(item);
    });
  } catch (e) { console.warn('loadWatchlist:', e); }
}

export async function addWatchlistItem() {
  const symbolEl = document.getElementById('watchlistSymbol') as HTMLInputElement | null;
  const addressEl = document.getElementById('watchlistAddress') as HTMLInputElement | null;
  if (!symbolEl || !addressEl) return;
  const symbol = symbolEl.value.trim().toUpperCase();
  const address = addressEl.value.trim();
  if (!symbol) return;
  await fetch('/api/watchlist', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ symbol: symbol, address: address || undefined }) });
  symbolEl.value = '';
  addressEl.value = '';
  await loadWatchlist();
}

async function removeWatchlistItem(symbol: string) {
  await fetch('/api/watchlist/' + encodeURIComponent(symbol), { method: 'DELETE', headers: getAuthHeaders() });
  await loadWatchlist();
}

// Trade modal
export function switchTradeTab(mode: string) {
  appState.tradeMode = mode;
  const tabStd = document.getElementById('tradeTabStd');
  const tabCustom = document.getElementById('tradeTabCustom');
  if (tabStd) tabStd.classList.toggle('active', mode === 'standard');
  if (tabCustom) tabCustom.classList.toggle('active', mode === 'custom');
  const stdPane = document.getElementById('tradeStandardPane');
  const customPane = document.getElementById('tradeCustomPane');
  if (stdPane) stdPane.style.display = mode === 'standard' ? '' : 'none';
  if (customPane) customPane.style.display = mode === 'custom' ? '' : 'none';
  const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = true;
  const resultEl = document.getElementById('tradeResult');
  if (resultEl) resultEl.textContent = '';
  appState.tradeQuotedFromAmount = null;
}

export function openTrade(from: string | null, to: string | null) {
  switchTradeTab('standard');
  renderTradePairButtons();
  setTradePair(from || 'ETH', to || 'USDC');
  setTradeSide('from');
  const amountEl = document.getElementById('tradeAmount') as HTMLInputElement | null;
  if (amountEl) amountEl.value = '';
  const quoteBox = document.getElementById('tradeQuoteBox');
  if (quoteBox) quoteBox.style.display = 'none';
  const resultEl = document.getElementById('tradeResult');
  if (resultEl) resultEl.textContent = '';
  const errEl = document.getElementById('tradeAmountErr');
  if (errEl) errEl.textContent = '';
  const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = true;
  appState.tradeQuotedFromAmount = null;
  const ensoIn = document.getElementById('ensoTokenIn') as HTMLInputElement | null;
  const ensoOut = document.getElementById('ensoTokenOut') as HTMLInputElement | null;
  const ensoAmt = document.getElementById('ensoAmount') as HTMLInputElement | null;
  const ensoErr = document.getElementById('ensoErr');
  if (ensoIn) ensoIn.value = '';
  if (ensoOut) ensoOut.value = '';
  if (ensoAmt) ensoAmt.value = '';
  if (ensoErr) ensoErr.textContent = '';
  const modal = document.getElementById('tradeModal');
  if (modal) modal.style.display = 'flex';
}

export async function getTradeQuote() {
  const amountEl = document.getElementById('tradeAmount') as HTMLInputElement | null;
  const amount = amountEl ? amountEl.value : '';
  const errEl = document.getElementById('tradeAmountErr');
  if (!amount || parseFloat(amount) <= 0) { if (errEl) errEl.textContent = 'Enter a valid amount'; return; }
  if (errEl) errEl.textContent = '';
  const quoteBox = document.getElementById('tradeQuoteBox');
  if (quoteBox) quoteBox.style.display = 'none';
  try {
    const q = await fetch('/api/quote?from=' + appState.tradePair.from + '&to=' + appState.tradePair.to + '&amount=' + amount + '&side=' + appState.tradeSide).then(function(r){ return r.json(); });
    if (q.error) { if (errEl) errEl.textContent = q.error; return; }
    appState.tradeQuotedFromAmount = q.fromAmount;
    const estimated = appState.tradeSide === 'to' ? ' (estimated)' : '';
    const quoteText = document.getElementById('tradeQuoteText');
    if (quoteText) quoteText.textContent = 'Spend ' + parseFloat(q.fromAmount).toFixed(6) + ' ' + appState.tradePair.from + ' -> Receive ' + parseFloat(q.toAmount).toFixed(6) + ' ' + appState.tradePair.to + estimated;
    const impact = parseFloat(q.priceImpact);
    const impactEl = document.getElementById('tradePriceImpact');
    if (impactEl) {
      if (!isNaN(impact)) { impactEl.textContent = 'Price impact: ' + impact.toFixed(3) + '%'; impactEl.style.color = impact > 3 ? 'var(--red)' : impact > 1 ? 'var(--yellow)' : 'var(--text-secondary)'; } else { impactEl.textContent = ''; }
    }
    if (quoteBox) quoteBox.style.display = '';
    const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
    if (confirmBtn) confirmBtn.disabled = false;
  } catch (e: any) { if (errEl) errEl.textContent = 'Quote failed: ' + e.message; }
}

export async function confirmTrade() {
  if (appState.tradeMode === 'custom') { await confirmEnsoTrade(); return; }
  if (!appState.tradeQuotedFromAmount) return;
  const btn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Executing...'; }
  const resultEl = document.getElementById('tradeResult');
  if (resultEl) resultEl.textContent = '';
  try {
    const data = await fetch('/api/trade', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ from: appState.tradePair.from, to: appState.tradePair.to, fromAmount: appState.tradeQuotedFromAmount }) }).then(function(r){ return r.json(); });
    if (data.ok) {
      const explorer = (appState.activeNetwork && appState.activeNetwork.indexOf('mainnet') !== -1) ? 'https://basescan.org' : 'https://sepolia.basescan.org';
      if (resultEl) {
        resultEl.textContent = '';
        const span = document.createElement('span');
        span.style.color = 'var(--green)';
        span.textContent = 'Trade executed - ';
        if (data.txHash) {
          const a = document.createElement('a');
          a.href = explorer + '/tx/' + data.txHash;
          a.target = '_blank';
          a.style.color = 'var(--accent)';
          a.textContent = data.txHash.slice(0,12) + '...';
          span.appendChild(a);
        } else {
          span.appendChild(document.createTextNode('[dry run]'));
        }
        resultEl.appendChild(span);
      }
      setTimeout(function(){ closeModal('tradeModal'); }, 4000);
      await loadStatus();
    } else {
      if (resultEl) {
        resultEl.textContent = '';
        const span = document.createElement('span');
        span.style.color = 'var(--red)';
        span.textContent = 'Error: ' + escapeHtml(data.error || 'Unknown error');
        resultEl.appendChild(span);
      }
      if (btn) btn.disabled = false;
    }
  } catch (e: any) {
    if (resultEl) {
      resultEl.textContent = '';
      const span = document.createElement('span');
      span.style.color = 'var(--red)';
      span.textContent = 'Error: ' + escapeHtml(e.message || 'Unknown error');
      resultEl.appendChild(span);
    }
    if (btn) btn.disabled = false;
  }
  finally { if (btn) btn.textContent = 'Confirm'; }
}

export function validateEnsoForm(): boolean {
  const tokenIn = (document.getElementById('ensoTokenIn') as HTMLInputElement | null)?.value.trim() || '';
  const tokenOut = (document.getElementById('ensoTokenOut') as HTMLInputElement | null)?.value.trim() || '';
  const amount = (document.getElementById('ensoAmount') as HTMLInputElement | null)?.value || '';
  const errEl = document.getElementById('ensoErr');
  const addrRe = /^0x[a-fA-F0-9]{40}$/;
  if (!addrRe.test(tokenIn)) { if (errEl) errEl.textContent = 'Invalid Token In address'; return false; }
  if (!addrRe.test(tokenOut)) { if (errEl) errEl.textContent = 'Invalid Token Out address'; return false; }
  if (!amount || parseFloat(amount) <= 0) { if (errEl) errEl.textContent = 'Enter a valid amount'; return false; }
  if (errEl) errEl.textContent = '';
  const confirmBtn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = false;
  return true;
}

async function confirmEnsoTrade() {
  const tokenIn = (document.getElementById('ensoTokenIn') as HTMLInputElement | null)?.value.trim() || '';
  const tokenOut = (document.getElementById('ensoTokenOut') as HTMLInputElement | null)?.value.trim() || '';
  const amountIn = (document.getElementById('ensoAmount') as HTMLInputElement | null)?.value || '';
  if (!validateEnsoForm()) return;
  const btn = document.getElementById('confirmTradeBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Routing...'; }
  const resultEl = document.getElementById('tradeResult');
  if (resultEl) resultEl.textContent = '';
  try {
    const data = await fetch('/api/trade/enso', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ tokenIn: tokenIn, tokenOut: tokenOut, amountIn: amountIn }) }).then(function(r){ return r.json(); });
    if (data.ok) {
      if (resultEl) {
        resultEl.textContent = '';
        const span = document.createElement('span');
        span.style.color = 'var(--green)';
        span.textContent = 'Routed - ';
        if (data.txHash) {
          const a = document.createElement('a');
          a.href = 'https://basescan.org/tx/' + data.txHash;
          a.target = '_blank';
          a.style.color = 'var(--accent)';
          a.textContent = data.txHash.slice(0,12) + '...';
          span.appendChild(a);
        } else {
          span.appendChild(document.createTextNode('[dry run]'));
        }
        resultEl.appendChild(span);
      }
      setTimeout(function(){ closeModal('tradeModal'); }, 4000);
      await loadStatus();
    } else {
      if (resultEl) {
        resultEl.textContent = '';
        const span = document.createElement('span');
        span.style.color = 'var(--red)';
        span.textContent = 'Error: ' + escapeHtml(data.error || 'Unknown error');
        resultEl.appendChild(span);
      }
      if (btn) btn.disabled = false;
    }
  } catch (e: any) {
    if (resultEl) {
      resultEl.textContent = '';
      const span = document.createElement('span');
      span.style.color = 'var(--red)';
      span.textContent = 'Error: ' + escapeHtml(e.message || 'Unknown error');
      resultEl.appendChild(span);
    }
    if (btn) btn.disabled = false;
  }
  finally { if (btn) btn.textContent = 'Confirm'; }
}

// Faucet modal
export function openFaucet() {
  const ethBtn = document.getElementById('faucetEthBtn') as HTMLButtonElement | null;
  const usdcBtn = document.getElementById('faucetUsdcBtn') as HTMLButtonElement | null;
  if (ethBtn) { ethBtn.textContent = 'Request ETH'; ethBtn.disabled = false; }
  if (usdcBtn) { usdcBtn.textContent = 'Request USDC'; usdcBtn.disabled = false; }
  const modal = document.getElementById('faucetModal');
  if (modal) modal.style.display = 'flex';
}

export async function requestFaucetAsset(assetId: string) {
  const btnId = assetId === 'eth' ? 'faucetEthBtn' : 'faucetUsdcBtn';
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Requesting...'; }
  try {
    const data = await fetch('/api/faucet', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ assetId: assetId }) }).then(function(r){ return r.json(); });
    if (data.ok) { if (btn) { btn.textContent = 'Sent!'; setTimeout(function(){ if (btn) { btn.textContent = 'Request ' + assetId.toUpperCase(); btn.disabled = false; } }, 5000); } }
    else { if (btn) { btn.textContent = 'Failed'; setTimeout(function(){ if (btn) { btn.textContent = 'Request ' + assetId.toUpperCase(); btn.disabled = false; } }, 3000); } }
  } catch (e) { if (btn) { btn.textContent = 'Error'; setTimeout(function(){ if (btn) { btn.textContent = 'Request ' + assetId.toUpperCase(); btn.disabled = false; } }, 3000); } }
}

// Modal utilities
export function closeModal(id: string) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

export function closeOnBackdrop(event: Event, id: string) {
  if (event.target === document.getElementById(id)) closeModal(id);
}

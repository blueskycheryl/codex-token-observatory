const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
let currentState = null;
let threadSearchQuery = '';
let refreshTimer = null;
let refreshInFlight = false;
let autoRefresh = localStorage.getItem('codex-token-observer:auto-refresh') !== 'off';

function fmt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? compact.format(n) : '—';
}
function exact(value) {
  const n = Number(value);
  return Number.isFinite(n) ? integer.format(n) : '—';
}
function pct(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : '—';
}
function time(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function setText(id, value) { $(id).textContent = value; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function drawSpark(values) {
  const svg = $('spark');
  if (!values?.length) { svg.querySelector('.spark-line').setAttribute('d', ''); svg.querySelector('.spark-fill').setAttribute('d', ''); return; }
  const max = Math.max(...values, 1), min = Math.min(...values, 0), spread = Math.max(max - min, 1);
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 320},${68 - ((value - min) / spread) * 56}`).join(' ');
  svg.querySelector('.spark-line').setAttribute('d', `M ${points}`);
  svg.querySelector('.spark-fill').setAttribute('d', `M 0,72 L ${points} L 320,72 Z`);
}
function updateThreadSelect(threads, selected) {
  const select = $('threadSelect');
  const query = threadSearchQuery.trim().toLowerCase();
  const list = (threads || []).filter((thread) => {
    if (!query) return true;
    return [thread.name, thread.modelProvider, thread.id, thread.status]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const signature = `${query}::${list.map((thread) => `${thread.id}:${thread.name}:${thread.status}`).join('|') || 'empty'}`;
  const isFocused = document.activeElement === select;
  const selectedInList = list.some((thread) => thread.id === selected);
  const desired = selectedInList ? selected : (list.some((thread) => thread.id === select.value) ? select.value : list[0]?.id || '');

  // Do not rebuild the native select on every poll. Replacing its options while it
  // is open makes Chromium lose focus, which looks like a flashing dropdown.
  if (select.dataset.signature === signature) {
    if (!isFocused && select.value !== desired) select.value = desired;
    return;
  }
  if (isFocused) return;

  select.innerHTML = '';
  for (const thread of list) {
    const option = document.createElement('option');
    option.value = thread.id;
    option.textContent = `${thread.name.slice(0, 48)} · ${thread.status}`;
    select.appendChild(option);
  }
  if (!list.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '暂无线程'; select.appendChild(option);
  }
  select.dataset.signature = signature;
  select.value = desired;
}
function renderModels(models) {
  const root = $('models');
  if (!models?.length) { root.innerHTML = '<div class="empty">等待 usage 数据…</div>'; return; }
  root.innerHTML = models.slice(0, 8).map((model) => `<div class="model-row"><span class="model-name" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</span><div class="model-bar"><span style="width:${Math.max(2, Math.min(100, Number(model.sharePercent) || 0))}%"></span></div><span class="model-tokens">${fmt(model.totalTokens)}</span><span class="model-share">${pct(model.sharePercent)}</span></div>`).join('');
}
let usagePeriod = localStorage.getItem('codex-token-observer:usage-period') || 'month';

function localIsoDate(date) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}
function usageWeekStart(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localIsoDate(date);
}
function renderUsageTimeline(timeline) {
  const daily = (timeline?.daily || []).filter((item) => item?.date).sort((a, b) => a.date.localeCompare(b.date));
  const today = localIsoDate(new Date());
  const fromInput = $('usageFrom');
  const toInput = $('usageTo');
  if (!fromInput.value) fromInput.value = shiftDate(today, -29);
  if (!toInput.value) toInput.value = today;

  let bars = [];
  let periodLabel = '按月';
  if (usagePeriod === 'custom' || usagePeriod === 'day') {
    const from = usagePeriod === 'custom' ? fromInput.value : shiftDate(today, -29);
    const to = usagePeriod === 'custom' ? toInput.value : today;
    const start = from <= to ? from : to;
    const end = from <= to ? to : from;
    const values = new Map(daily.map((item) => [item.date, Number(item.tokens) || 0]));
    const cursor = new Date(`${start}T00:00:00`);
    const finish = new Date(`${end}T00:00:00`);
    while (cursor <= finish && bars.length < 120) {
      const date = localIsoDate(cursor);
      bars.push({ key: date, label: date.slice(5), tokens: values.get(date) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    periodLabel = usagePeriod === 'custom' ? '自定义每日' : '最近 30 天';
  } else {
    const groups = new Map();
    for (const item of daily) {
      const key = usagePeriod === 'week' ? usageWeekStart(item.date) : item.date.slice(0, 7);
      const current = groups.get(key) || { key, tokens: 0 };
      current.tokens += Number(item.tokens) || 0;
      groups.set(key, current);
    }
    bars = [...groups.values()].slice(-12).map((item) => ({
      ...item,
      label: usagePeriod === 'week' ? item.key.slice(5) : item.key,
    }));
    periodLabel = usagePeriod === 'week' ? '按周' : '按月';
  }

  const root = $('usageChart');
  if (!bars.length) {
    root.innerHTML = '<div class="empty">暂无可用 usage 数据</div>';
    setText('timelineSummary', `${periodLabel} · 暂无数据`);
    setText('timelineSource', timeline?.source === 'official' ? 'Codex account/usage' : 'local history');
    return;
  }
  const max = Math.max(...bars.map((item) => item.tokens), 1);
  root.innerHTML = bars.map((item) => `<div class="usage-bar-item" title="${escapeHtml(item.key)} · ${exact(item.tokens)} tokens"><div class="usage-bar-value">${fmt(item.tokens)}</div><div class="usage-bar-track"><i style="height:${Math.max(item.tokens ? 4 : 1, (item.tokens / max) * 100)}%"></i></div><span>${escapeHtml(item.label)}</span></div>`).join('');
  const total = bars.reduce((sum, item) => sum + item.tokens, 0);
  setText('timelineSummary', `${periodLabel} · ${bars.length} 个区间 · ${fmt(total)} tokens`);
  setText('timelineSource', timeline?.source === 'official' ? 'Codex account/usage' : 'local history');
  document.querySelectorAll('[data-usage-period]').forEach((button) => button.classList.toggle('active', button.dataset.usagePeriod === usagePeriod));
}
function updateProcessSwitch(processName) {
  const process = processName === 'pi' ? 'pi' : 'codex';
  document.querySelectorAll('[data-process]').forEach((button) => button.classList.toggle('active', button.dataset.process === process));
  setText('processLabel', `LOCAL TELEMETRY / ${process.toUpperCase()}`);
  setText('threadLabel', process === 'pi' ? '会话' : '线程');
  setText('quotaLabel', process === 'pi' ? 'PI LOCAL USAGE' : 'AVAILABLE CAPACITY');
}
function render(state) {
  currentState = state;
  const isPi = state.process === 'pi';
  updateProcessSwitch(state.process);
  const ready = state.connection?.status === 'ready';
  const connection = $('connection');
  connection.classList.toggle('offline', !ready);
  connection.querySelector('span').textContent = ready ? (isPi ? 'PI LOCAL LIVE' : 'APP-SERVER LIVE') : (state.connection?.status || 'OFFLINE').toUpperCase();
  updateThreadSelect(state.threads, state.selectedThreadId);
  const usedPercent = Number.isFinite(Number(state.resetWindow?.usedPercent)) ? Number(state.resetWindow.usedPercent) : null;
  const remainingPercent = usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
  setText('quotaRemaining', isPi || remainingPercent === null ? '—' : `${remainingPercent.toFixed(1)}%`);
  setText('quotaResetAt', isPi ? '—' : dateTime(state.resetWindow?.resetsAt));
  setText('quotaResetWindow', isPi ? 'local session data' : (state.resetWindow?.durationMinutes ? `${state.resetWindow.durationMinutes} min window` : 'window unavailable'));
  setText('quotaUsageHint', isPi ? '按 pi 本地会话 usage 汇总 · 不提供额度上限' : (usedPercent === null ? 'Codex rate-limit 数据不可用' : `已使用 ${usedPercent.toFixed(1)}% · 剩余 ${remainingPercent.toFixed(1)}%`));
  $('quotaMeter').style.width = `${isPi ? 0 : (remainingPercent || 0)}%`;

  const current = state.current || {};
  const percent = Number.isFinite(Number(current.contextPercent)) ? Number(current.contextPercent) : null;
  setText('contextPercent', percent === null ? '—' : `${percent.toFixed(1)}%`);
  setText('contextUsed', current.contextUsed ? fmt(current.contextUsed) : '—');
  setText('contextUsedSmall', current.contextUsed ? `${exact(current.contextUsed)} tokens` : '—');
  setText('contextCapacity', current.contextWindow ? `${fmt(current.contextWindow)} token capacity` : 'capacity unavailable');
  setText('contextModel', current.model || '—');
  $('contextMeter').style.width = `${Math.min(100, percent || 0)}%`;
  $('contextRing').style.background = `conic-gradient(var(--lime) ${(percent || 0) * 3.6}deg, #27362c 0deg)`;
  $('contextTag').textContent = percent === null ? 'UNKNOWN' : (percent > 85 ? 'NEAR LIMIT' : 'HEALTHY');
  $('contextTag').className = `tag ${percent > 85 ? 'amber' : 'green'}`;

  setText('throughput', Math.round(state.throughput?.current || 0));
  setText('throughputAverage', `${Math.round(state.throughput?.average || 0)} tok/s`);
  const throughputSource = state.throughput?.source || 'idle';
  setText('throughputTag', throughputSource === 'live' ? 'LIVE' : (throughputSource === 'history' ? 'RECENT' : 'IDLE'));
  $('throughputTag').className = `tag ${throughputSource === 'idle' ? 'cyan' : 'amber'}`;
  drawSpark(state.throughput?.series || []);
  setText('currentCache', fmt(state.account?.currentCachedTokens));
  setText('todayCache', fmt(state.account?.todayCachedTokens));
  setText('cacheHit', pct(current.cacheHitPercent));
  $('cacheBar').style.width = `${Math.min(100, Number(current.cacheHitPercent) || 0)}%`;

  setText('usageSource', state.account?.source || '—');
  setText('todayTokens', fmt(state.account?.todayTokens));
  setText('resetTokens', fmt(state.account?.sinceResetTokens));
  setText('lifetimeTokens', fmt(state.account?.lifetimeTokens));
  setText('resetLabel', state.account?.windowLabel || (state.resetWindow?.durationMinutes ? `${state.resetWindow.durationMinutes} min window` : 'active window'));
  renderModels(state.models);
  renderUsageTimeline(state.usageTimeline);

  const thread = state.selectedThread;
  setText('threadName', thread?.name || '暂无活动线程');
  setText('threadModel', current.model || thread?.modelProvider || '—');
  setText('threadStatus', thread?.status || '—');
  setText('threadId', thread?.id ? thread.id.slice(0, 18) + '…' : '—');
  setText('lastTurn', fmt(current.lastTurn?.totalTokens));
  setText('threadTotal', fmt(current.threadTotal?.totalTokens));
  $('notes').innerHTML = (state.caveats || []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  setText('historyInfo', `${state.history?.files || 0} rollout files · ${state.history?.lastScanAt ? `scanned ${time(state.history.lastScanAt)}` : 'scanner warming'}`);
}
async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch(`/api/state?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $('connection').classList.add('offline');
    $('connection').querySelector('span').textContent = 'DASHBOARD OFFLINE';
  } finally {
    refreshInFlight = false;
  }
}
async function switchDashboardProcess(processName) {
  if (processName !== 'codex' && processName !== 'pi') return;
  threadSearchQuery = '';
  $('threadSearch').value = '';
  document.querySelector('.thread-picker').classList.remove('search-ready');
  await fetch(`/api/process?process=${encodeURIComponent(processName)}`).catch(() => {});
  await refresh();
}
document.querySelectorAll('[data-process]').forEach((button) => {
  button.addEventListener('click', () => switchDashboardProcess(button.dataset.process));
});
function revealThreadSearch() {
  const picker = document.querySelector('.thread-picker');
  if (!picker.classList.contains('search-ready')) picker.classList.add('search-ready');
}
$('threadSelect').addEventListener('mousedown', revealThreadSearch);
$('threadSelect').addEventListener('focus', revealThreadSearch);
$('threadSelect').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id) return;
  await fetch(`/api/select?threadId=${encodeURIComponent(id)}`).catch(() => {});
});
$('threadSearch').addEventListener('input', (event) => {
  threadSearchQuery = event.target.value;
  updateThreadSelect(currentState?.threads || [], currentState?.selectedThreadId);
});
$('threadSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.target.value = '';
    threadSearchQuery = '';
    updateThreadSelect(currentState?.threads || [], currentState?.selectedThreadId);
  }
});
document.querySelectorAll('[data-usage-period]').forEach((button) => {
  button.addEventListener('click', () => {
    usagePeriod = button.dataset.usagePeriod;
    localStorage.setItem('codex-token-observer:usage-period', usagePeriod);
    renderUsageTimeline(currentState?.usageTimeline);
  });
});
['usageFrom', 'usageTo'].forEach((id) => $(id).addEventListener('change', () => {
  usagePeriod = 'custom';
  localStorage.setItem('codex-token-observer:usage-period', usagePeriod);
  renderUsageTimeline(currentState?.usageTimeline);
}));
$('autoRefresh').checked = autoRefresh;
$('autoRefresh').addEventListener('change', (event) => {
  autoRefresh = event.target.checked;
  localStorage.setItem('codex-token-observer:auto-refresh', autoRefresh ? 'on' : 'off');
  if (autoRefresh) {
    refresh();
    refreshTimer = setInterval(refresh, 1000);
  } else if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
refresh();
if (autoRefresh) refreshTimer = setInterval(refresh, 1000);

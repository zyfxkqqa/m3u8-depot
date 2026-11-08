import { api } from './api.js';
import { $, state, setMessage } from './state.js';
import { escapeHtml, formatFfmpegTime, formatSize, statusText } from './formatters.js';

const TASK_FILTERS = [
  ['all', '全部'], ['parsed', '待开始'], ['queued', '排队中'], ['running', '下载中'],
  ['retrying', '等待重试'], ['committing', '正在提交'], ['deleting', '正在删除'], ['done', '已完成'], ['failed', '失败'],
];
let pollingController;
let initialized = false;
let requestApi = api;

function queuedPosition(taskId) {
  const index = state.tasks.filter(task => task.status === 'queued').findIndex(task => task.id === taskId);
  return index >= 0 ? index + 1 : 0;
}

function formatProgress(task) {
  const raw = String(task.progressText || '').trim();
  if (task.status === 'running') {
    const time = raw.match(/time=([^\s]+)/)?.[1];
    const speed = raw.match(/speed=([^\s]+)/)?.[1];
    if (time || speed) return [time ? `已处理 ${formatFfmpegTime(time)}` : '', speed || ''].filter(Boolean).join(' · ');
    return raw && raw !== '下载中' ? raw : '正在下载';
  }
  if (task.status === 'queued') {
    const queueIndex = queuedPosition(task.id);
    return queueIndex ? `队列第 ${queueIndex} 位` : '等待下载';
  }
  if (task.status === 'retrying') return raw || '等待自动重试';
  if (task.status === 'committing') return raw || '正在提交文件';
  if (task.status === 'deleting') return raw || '正在删除';
  if (task.status === 'parsed') return raw && raw !== '已解析，等待开始' ? raw : '等待手动开始';
  if (task.status === 'done') return '完成';
  if (task.status === 'failed' && /FFMPEG_STALLED|FFmpeg stalled/i.test(String(task.error || ''))) return '源线路长时间无进度，自动刷新地址并重试后仍失败，请选择其他播放线路重试';
  if (task.status === 'failed') return '失败';
  return raw || '';
}

function formatTaskSize(task) {
  if (task.outputSize) return formatSize(task.outputSize);
  if (task.status === 'running') return '写入中';
  return '';
}

function batchKey(task) { return task.batchId || '__manual__'; }
function batchLabel(task) { return [task.batchTitle, task.batchLine].filter(Boolean).join(' / ') || '播放页手动解析'; }
function parseEpisodeNo(task) {
  const text = `${task.title || ''} ${task.pageUrl || ''}`;
  const titleMatch = text.match(/第\s*0*(\d+)\s*[集话話]/);
  if (titleMatch) return Number(titleMatch[1]);
  const urlMatch = text.match(/-(\d+)\.html(?:$|[?#])/);
  return urlMatch ? Number(urlMatch[1]) : Number.MAX_SAFE_INTEGER;
}
function taskCreatedAt(task) {
  const time = Date.parse(task.createdAt || task.updatedAt || '');
  return Number.isFinite(time) ? time : 0;
}
function compareTasks(a, b) {
  const batch = batchLabel(a).localeCompare(batchLabel(b), 'zh-CN');
  if (batch) return batch;
  const episode = parseEpisodeNo(a) - parseEpisodeNo(b);
  return episode || taskCreatedAt(a) - taskCreatedAt(b);
}
function getTaskBatches() {
  const batches = new Map();
  for (const task of state.tasks) {
    const key = batchKey(task);
    if (!batches.has(key)) batches.set(key, { key, label: batchLabel(task), count: 0 });
    batches.get(key).count += 1;
  }
  return [...batches.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}
function getBatchFilteredTasks() {
  const tasks = state.taskBatchFilter === 'all' ? state.tasks : state.tasks.filter(task => batchKey(task) === state.taskBatchFilter);
  return [...tasks].sort(compareTasks);
}
function getFilteredTasks() {
  const tasks = getBatchFilteredTasks();
  return state.taskFilter === 'all' ? tasks : tasks.filter(task => task.status === state.taskFilter);
}
function getPaginationInfo() {
  const filtered = getFilteredTasks();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.taskPageSize));
  state.taskPage = Math.min(Math.max(1, state.taskPage), totalPages);
  const start = (state.taskPage - 1) * state.taskPageSize;
  return { filtered, pageTasks: filtered.slice(start, start + state.taskPageSize), totalPages };
}
function currentPageTasks() { return getPaginationInfo().pageTasks; }
function isTaskSelectable(task) { return task.status !== 'deleting'; }
function selectedTaskIds() {
  const visibleIds = new Set(getFilteredTasks().filter(isTaskSelectable).map(task => task.id));
  return [...state.selectedTasks].filter(id => visibleIds.has(id));
}
function countTasksByStatus() {
  return getBatchFilteredTasks().reduce((counts, task) => {
    counts.all += 1; counts[task.status] = (counts[task.status] || 0) + 1; return counts;
  }, { all: 0, parsed: 0, queued: 0, running: 0, retrying: 0, committing: 0, deleting: 0, done: 0, failed: 0 });
}

export function renderHealth() {
  const element = $('#healthText');
  if (!state.health) { element.textContent = '本地服务未连接'; return; }
  $('#versionText').textContent = state.health.version ? `v${state.health.version}` : '';
  element.textContent = `输出目录：${state.health.outputDir} | FFmpeg：${state.health.ffmpegExists ? '可用' : '未找到'} | 并发任务：${state.health.maxActiveTasks}`;
}

function renderTaskSummary() {
  const counts = countTasksByStatus();
  $('#taskCount').textContent = `${counts.all} 个任务`;
  $('#taskSummary').innerHTML = TASK_FILTERS.map(([key, label]) => `
    <button type="button" class="summary-pill ${state.taskFilter === key ? 'active' : ''}" data-filter="${key}">
      ${label} <span>${counts[key] || 0}</span>
    </button>`).join('');
}
function renderBatchFilter() {
  const select = $('#taskBatchFilter');
  const batches = getTaskBatches();
  if (state.taskBatchFilter !== 'all' && !batches.some(batch => batch.key === state.taskBatchFilter)) state.taskBatchFilter = 'all';
  select.innerHTML = '<option value="all">全部批次</option>' + batches.map(batch => `<option value="${escapeHtml(batch.key)}">${escapeHtml(batch.label)} (${batch.count})</option>`).join('');
  select.value = state.taskBatchFilter;
}
function duplicateSourceText(task) {
  if (!task.duplicate) return '';
  const source = state.tasks.find(item => item.id === task.duplicateOf);
  const title = task.existingTitle || source?.title || task.duplicateOf || '已存在任务';
  const status = task.existingStatus || source?.status || '';
  return status ? `${title}（${statusText(status)}）` : title;
}
function renderTaskActions(task, expanded) {
  const id = escapeHtml(task.id);
  const detailButton = `<button type="button" class="ghost" data-action="toggle-detail" data-id="${id}">${expanded ? '收起' : '详情'}</button>`;
  const deleteButton = `<button type="button" class="danger" data-action="delete" data-id="${id}">删除</button>`;
  if (task.status === 'deleting') return detailButton;
  if (['running', 'retrying', 'committing'].includes(task.status)) return `${detailButton}<button type="button" class="danger soft-danger" data-action="cancel" data-id="${id}">停止</button>`;
  if (task.status === 'queued') return `${detailButton}<button type="button" class="ghost" data-action="cancel" data-id="${id}">取消排队</button>${deleteButton}`;
  if (task.status === 'failed') return `<button type="button" data-action="start" data-id="${id}">重试</button>${detailButton}${deleteButton}`;
  if (task.status === 'parsed') return `<button type="button" data-action="start" data-id="${id}">开始</button>${detailButton}${deleteButton}`;
  return `${detailButton}${deleteButton}`;
}
function renderTaskDetailRow(task) {
  return `<tr class="task-detail-row"><td colspan="7"><div class="task-detail">
    <div><strong>播放页：</strong>${escapeHtml(task.pageUrl || '-')}</div><div><strong>M3U8：</strong>${escapeHtml(task.m3u8Url || '-')}</div>
    <div><strong>标题来源：</strong>${escapeHtml(task.titleSource || '-')}</div><div><strong>M3U8 来源：</strong>${escapeHtml(task.m3u8Source || '-')}</div>
    <div><strong>输出路径：</strong>${escapeHtml(task.output || '-')}</div><div><strong>批次：</strong>${escapeHtml([task.batchTitle, task.batchLine].filter(Boolean).join(' / ') || '-')}</div>
    ${task.duplicate ? `<div><strong>重复来源：</strong>${escapeHtml(duplicateSourceText(task))}</div>` : ''}
    ${task.error ? `<div class="error"><strong>错误：</strong>${escapeHtml(task.error)}</div>` : ''}
  </div></td></tr>`;
}
function renderTaskRow(task) {
  const expanded = state.expandedTasks.has(task.id);
  const selectable = isTaskSelectable(task);
  const duplicateTag = task.duplicate ? `<span class="tag warn" title="${escapeHtml(duplicateSourceText(task))}">重复</span>` : '';
  return `<tr>
    <td class="check-col"><input type="checkbox" data-task-check="${escapeHtml(task.id)}" ${selectable && state.selectedTasks.has(task.id) ? 'checked' : ''} ${selectable ? '' : 'disabled aria-label="正在删除，不可选择"'}></td>
    <td class="title-cell"><span>${escapeHtml(task.title || task.pageUrl || '-')}</span>${duplicateTag}</td>
    <td class="batch-cell">${escapeHtml(batchLabel(task))}</td><td><span class="badge ${escapeHtml(task.status)}">${escapeHtml(statusText(task.status))}</span></td>
    <td class="progress-cell">${escapeHtml(formatProgress(task))}</td><td>${escapeHtml(formatTaskSize(task))}</td><td class="row-actions">${renderTaskActions(task, expanded)}</td>
  </tr>${expanded ? renderTaskDetailRow(task) : ''}`;
}
function renderTaskTable() {
  const list = $('#taskList');
  const { pageTasks } = getPaginationInfo();
  if (!state.tasks.length) { list.innerHTML = '<div class="empty">暂无任务。先解析播放页，或从详情页选择集数下载。</div>'; return; }
  if (!pageTasks.length) { list.innerHTML = '<div class="empty">当前筛选下没有任务。</div>'; return; }
  list.innerHTML = `<table class="task-table"><thead><tr><th class="check-col">选</th><th>标题</th><th>批次</th><th>状态</th><th>进度</th><th>大小</th><th>操作</th></tr></thead><tbody>${pageTasks.map(renderTaskRow).join('')}</tbody></table>`;
}
function renderPagination() {
  const { filtered, totalPages } = getPaginationInfo();
  $('#paginationInfo').textContent = `共 ${filtered.length} 条`; $('#pageInfo').textContent = `第 ${state.taskPage} / ${totalPages} 页`;
  $('#taskPageSize').value = String(state.taskPageSize); $('#firstPageBtn').disabled = state.taskPage <= 1; $('#prevPageBtn').disabled = state.taskPage <= 1;
  $('#nextPageBtn').disabled = state.taskPage >= totalPages; $('#lastPageBtn').disabled = state.taskPage >= totalPages;
}
function renderTaskToolbarState() {
  const pageTasks = currentPageTasks(); const ids = selectedTaskIds(); const filtered = getFilteredTasks();
  const selectablePageTasks = pageTasks.filter(isTaskSelectable);
  $('#selectPageTasksBtn').disabled = selectablePageTasks.length === 0; $('#invertPageTasksBtn').disabled = selectablePageTasks.length === 0;
  $('#startSelectedTasksBtn').disabled = ids.length === 0; $('#deleteSelectedTasksBtn').disabled = ids.length === 0;
  $('#retryFailedTasksBtn').disabled = !filtered.some(task => task.status === 'failed'); $('#clearDoneBtn').disabled = !filtered.some(task => task.status === 'done');
}
export function renderTasks() { renderBatchFilter(); renderTaskSummary(); renderTaskTable(); renderPagination(); renderTaskToolbarState(); }

async function startTasks(ids = []) { await requestApi('/api/start', { method: 'POST', body: JSON.stringify({ ids }) }); await pollingController.refreshNow(); }
async function cancelTasks(ids = []) { await requestApi('/api/cancel', { method: 'POST', body: JSON.stringify({ ids }) }); await pollingController.refreshNow(); }
async function deleteTasks(ids = []) { await requestApi('/api/delete', { method: 'POST', body: JSON.stringify({ ids }) }); await pollingController.refreshNow(); }
function confirmDanger(message) { return window.confirm(message); }

export async function runToolbarAction({ button, pendingMessage, successMessage, action, onSuccess }) {
  button.disabled = true;
  setMessage('#taskMessage', pendingMessage);
  try {
    await action();
    if (onSuccess) onSuccess();
    setMessage('#taskMessage', successMessage);
    return true;
  } catch (error) {
    setMessage('#taskMessage', error?.message || String(error), true);
    return false;
  } finally {
    renderTaskToolbarState();
  }
}

export function initTasks(controller, options = {}) {
  pollingController = controller;
  requestApi = options.request || api;
  if (initialized) return;
  initialized = true;
  $('#clearDoneBtn').addEventListener('click', async () => {
    const ids = getFilteredTasks().filter(task => task.status === 'done').map(task => task.id);
    if (!ids.length) return setMessage('#taskMessage', '当前筛选下没有完成任务。');
    if (!confirmDanger(`确定清理当前筛选下的 ${ids.length} 个完成任务吗？`)) return setMessage('#taskMessage', '已取消清理完成任务。');
    await runToolbarAction({
      button: $('#clearDoneBtn'),
      pendingMessage: `正在清理 ${ids.length} 个完成任务...`,
      successMessage: `已清理 ${ids.length} 个完成任务。`,
      action: () => deleteTasks(ids),
    });
  });
  $('#selectPageTasksBtn').addEventListener('click', () => { const tasks = currentPageTasks().filter(isTaskSelectable); tasks.forEach(task => state.selectedTasks.add(task.id)); renderTasks(); setMessage('#taskMessage', `已选择本页 ${tasks.length} 个任务。`); });
  $('#invertPageTasksBtn').addEventListener('click', () => { currentPageTasks().filter(isTaskSelectable).forEach(task => state.selectedTasks.has(task.id) ? state.selectedTasks.delete(task.id) : state.selectedTasks.add(task.id)); renderTasks(); setMessage('#taskMessage', `当前已选择 ${selectedTaskIds().length} 个任务。`); });
  $('#startSelectedTasksBtn').addEventListener('click', async () => {
    const ids = selectedTaskIds();
    if (!ids.length) return setMessage('#taskMessage', '请先选择任务。', true);
    await runToolbarAction({
      button: $('#startSelectedTasksBtn'),
      pendingMessage: `正在开始 ${ids.length} 个任务...`,
      successMessage: `已提交 ${ids.length} 个任务。`,
      action: () => startTasks(ids),
    });
  });
  $('#deleteSelectedTasksBtn').addEventListener('click', async () => {
    const ids = selectedTaskIds(); if (!ids.length) return setMessage('#taskMessage', '请先选择任务。', true);
    if (!confirmDanger(`确定删除选中的 ${ids.length} 个任务吗？删除后任务记录会从列表移除。`)) return setMessage('#taskMessage', '已取消删除。');
    await runToolbarAction({
      button: $('#deleteSelectedTasksBtn'),
      pendingMessage: `正在删除 ${ids.length} 个任务...`,
      successMessage: `已删除 ${ids.length} 个任务。`,
      action: () => deleteTasks(ids),
      onSuccess: () => { ids.forEach(id => state.selectedTasks.delete(id)); renderTasks(); },
    });
  });
  $('#retryFailedTasksBtn').addEventListener('click', async () => {
    const ids = getFilteredTasks().filter(task => task.status === 'failed').map(task => task.id);
    if (!ids.length) return setMessage('#taskMessage', '当前筛选下没有失败任务。');
    await runToolbarAction({
      button: $('#retryFailedTasksBtn'),
      pendingMessage: `正在重试 ${ids.length} 个失败任务...`,
      successMessage: `已提交 ${ids.length} 个失败任务重试。`,
      action: () => startTasks(ids),
    });
  });
  $('#taskPageSize').addEventListener('change', event => { state.taskPageSize = Number(event.target.value) || 20; state.taskPage = 1; renderTasks(); });
  $('#taskBatchFilter').addEventListener('change', event => { state.taskBatchFilter = event.target.value || 'all'; state.selectedTasks = new Set(selectedTaskIds()); state.taskPage = 1; renderTasks(); setMessage('#taskMessage', '已切换批次筛选。'); });
  $('#clearTaskFiltersBtn').addEventListener('click', () => { state.taskBatchFilter = 'all'; state.taskFilter = 'all'; state.selectedTasks = new Set(selectedTaskIds()); state.taskPage = 1; renderTasks(); setMessage('#taskMessage', '已清除任务筛选。'); });
  $('#firstPageBtn').addEventListener('click', () => { state.taskPage = 1; renderTasks(); }); $('#prevPageBtn').addEventListener('click', () => { state.taskPage -= 1; renderTasks(); });
  $('#nextPageBtn').addEventListener('click', () => { state.taskPage += 1; renderTasks(); }); $('#lastPageBtn').addEventListener('click', () => { state.taskPage = getPaginationInfo().totalPages; renderTasks(); });
  $('#taskSummary').addEventListener('click', event => { const button = event.target.closest('button[data-filter]'); if (!button) return; state.taskFilter = button.dataset.filter; state.selectedTasks = new Set(selectedTaskIds()); state.taskPage = 1; renderTasks(); setMessage('#taskMessage', `已切换到“${button.textContent.trim()}”筛选。`); });
  $('#taskList').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]'); if (!button) return; const id = button.dataset.id;
    if (button.dataset.action === 'start') { setMessage('#taskMessage', '正在提交任务...'); startTasks([id]).then(() => setMessage('#taskMessage', '任务已提交。')).catch(error => setMessage('#taskMessage', error.message, true)); }
    if (button.dataset.action === 'cancel') { const task = state.tasks.find(item => item.id === id); if (task?.status === 'running' && !confirmDanger(`确定停止“${task.title || '当前任务'}”吗？停止后需要手动重新开始。`)) return setMessage('#taskMessage', '已取消停止任务。'); setMessage('#taskMessage', '正在取消任务...'); cancelTasks([id]).then(() => setMessage('#taskMessage', '任务已取消。')).catch(error => setMessage('#taskMessage', error.message, true)); }
    if (button.dataset.action === 'delete') { const task = state.tasks.find(item => item.id === id); if (!confirmDanger(`确定删除“${task?.title || '当前任务'}”吗？删除后任务记录会从列表移除。`)) return setMessage('#taskMessage', '已取消删除。'); setMessage('#taskMessage', '正在删除任务...'); deleteTasks([id]).then(() => setMessage('#taskMessage', '任务已删除。')).catch(error => setMessage('#taskMessage', error.message, true)); }
    if (button.dataset.action === 'toggle-detail') { state.expandedTasks.has(id) ? state.expandedTasks.delete(id) : state.expandedTasks.add(id); renderTasks(); }
  });
  $('#taskList').addEventListener('change', event => { const input = event.target.closest('input[data-task-check]'); if (!input) return; const task = state.tasks.find(item => item.id === input.dataset.taskCheck); if (!task || !isTaskSelectable(task)) { input.checked = false; state.selectedTasks.delete(input.dataset.taskCheck); return renderTaskToolbarState(); } input.checked ? state.selectedTasks.add(input.dataset.taskCheck) : state.selectedTasks.delete(input.dataset.taskCheck); renderTaskToolbarState(); setMessage('#taskMessage', `当前已选择 ${selectedTaskIds().length} 个任务。`); });
}

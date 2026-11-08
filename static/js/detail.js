import { api } from './api.js';
import { $, state, setMessage } from './state.js';
import { escapeHtml } from './formatters.js';

let pollingController;
let switchTab;
let duplicateDialog;
let initialized = false;
let requestApi = api;

function setAddButtonsDisabled(disabled) {
  $('#addSelectedBtn').disabled = disabled;
  $('#addSelectedResultBtn').disabled = disabled;
}
function currentLineEpisodes() { return state.detail?.lines?.[state.activeLineIndex]?.episodes || []; }
export function renderDetail() {
  const result = $('#detailResult');
  if (!state.detail) { result.hidden = true; setAddButtonsDisabled(true); return; }
  result.hidden = false;
  const lines = state.detail.lines || [];
  const activeLine = lines[state.activeLineIndex] || lines[0];
  $('#detailTitle').textContent = state.detail.title || '-';
  $('#detailSummary').textContent = `${lines.length} 条线路，当前线路 ${activeLine ? activeLine.episodes.length : 0} 集`;
  $('#lineTabs').innerHTML = lines.map((line, index) => `<button type="button" class="line-tab ${index === state.activeLineIndex ? 'active' : ''}" data-line-index="${index}">${escapeHtml(line.name)} <span>${line.episodes.length}</span></button>`).join('');
  if (!activeLine) { $('#episodeGrid').innerHTML = '<div class="empty">没有可选集数。</div>'; setAddButtonsDisabled(true); return; }
  $('#episodeGrid').innerHTML = activeLine.episodes.map(episode => `<label class="episode-item"><input type="checkbox" value="${escapeHtml(episode.url)}" ${state.selectedEpisodes.has(episode.url) ? 'checked' : ''}><span>${escapeHtml(episode.name)}</span></label>`).join('');
  setAddButtonsDisabled(state.selectedEpisodes.size === 0);
}

async function parseDetail() {
  const url = $('#detailUrlInput').value.trim();
  if (!url) return setMessage('#detailMessage', '请输入详情页地址。', true);
  $('#parseDetailBtn').disabled = true; state.detail = null; state.activeLineIndex = 0; state.selectedEpisodes = new Set(); renderDetail(); setMessage('#detailMessage', '正在解析详情页...');
  try {
    const data = await requestApi('/api/detail/parse', { method: 'POST', body: JSON.stringify({ url }) });
    state.detail = data.detail; state.activeLineIndex = 0; state.selectedEpisodes = new Set((state.detail.lines[0]?.episodes || []).map(item => item.url)); renderDetail();
    setMessage('#detailMessage', `解析完成：${state.detail.title}，${state.detail.lines.length} 条线路。`);
  } catch (error) { setMessage('#detailMessage', error.message, true); } finally { $('#parseDetailBtn').disabled = false; }
}

export async function downloadSelectedEpisodes() {
  const urls = [...state.selectedEpisodes];
  if (!urls.length) return setMessage('#detailMessage', '请先选择集数。', true);
  setAddButtonsDisabled(true); setMessage('#detailMessage', `正在检查 ${urls.length} 个选中集数...`);
  try {
    const check = await requestApi('/api/parse/check', { method: 'POST', body: JSON.stringify({ urls }) });
    const duplicateCount = check.summary?.duplicate || 0; const failedCount = check.summary?.failed || 0; let mode = 'redownload';
    if (duplicateCount > 0) { mode = await duplicateDialog.choose(check.summary || {}); if (!mode) return setMessage('#detailMessage', '已取消下载。'); }
    const currentLine = state.detail?.lines?.[state.activeLineIndex];
    const commit = await requestApi('/api/parse/commit', { method: 'POST', body: JSON.stringify({ items: check.items, mode, batch: { title: state.detail?.title || '', line: currentLine?.name || '' } }) });
    const started = commit.startIds?.length || 0; const created = commit.results?.filter(item => item.id).length || 0; const duplicateText = duplicateCount ? `，重复 ${duplicateCount} 个` : '';
    setMessage('#detailMessage', `已创建 ${created} 个任务，已开始 ${started} 个${duplicateText}，失败 ${failedCount} 个。`, failedCount > 0);
    await pollingController.refreshNow(); switchTab('tasks');
  } catch (error) { setMessage('#detailMessage', error.message, true); } finally { setAddButtonsDisabled(state.selectedEpisodes.size === 0); }
}

export function initDetail(options) {
  pollingController = options.pollingController; switchTab = options.switchTab; duplicateDialog = options.duplicateDialog; requestApi = options.request || api;
  if (initialized) return;
  initialized = true;
  $('#parseDetailBtn').addEventListener('click', parseDetail); $('#addSelectedBtn').addEventListener('click', downloadSelectedEpisodes); $('#addSelectedResultBtn').addEventListener('click', downloadSelectedEpisodes);
  $('#lineTabs').addEventListener('click', event => { const button = event.target.closest('button[data-line-index]'); if (!button) return; state.activeLineIndex = Number(button.dataset.lineIndex); state.selectedEpisodes = new Set(currentLineEpisodes().map(item => item.url)); renderDetail(); });
  $('#episodeGrid').addEventListener('change', event => { const input = event.target.closest('input[type="checkbox"]'); if (!input) return; input.checked ? state.selectedEpisodes.add(input.value) : state.selectedEpisodes.delete(input.value); setAddButtonsDisabled(state.selectedEpisodes.size === 0); });
  $('#selectAllEpisodesBtn').addEventListener('click', () => { currentLineEpisodes().forEach(item => state.selectedEpisodes.add(item.url)); renderDetail(); });
  $('#invertEpisodesBtn').addEventListener('click', () => { currentLineEpisodes().forEach(item => state.selectedEpisodes.has(item.url) ? state.selectedEpisodes.delete(item.url) : state.selectedEpisodes.add(item.url)); renderDetail(); });
  $('#clearEpisodesBtn').addEventListener('click', () => { currentLineEpisodes().forEach(item => state.selectedEpisodes.delete(item.url)); renderDetail(); });
}

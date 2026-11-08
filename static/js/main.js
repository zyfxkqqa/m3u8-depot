import { api } from './api.js';
import { $, $$, state, setMessage } from './state.js';
import { createPollingController } from './polling.mjs';
import { createDuplicateDialog } from './duplicate-dialog.js';
import { initTasks, renderHealth, renderTasks } from './tasks.js';
import { initDetail } from './detail.js';
import { initSites } from './sites.js';

let application = null;

export function switchTab(name) {
  const tabs = $$('.tab');
  const selectedTab = tabs.find(tab => tab.dataset.tab === name);
  if (!selectedTab) return;
  tabs.forEach(tab => {
    const selected = tab === selectedTab;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (!panel) return;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
}

export function handleTabKeydown(event, tabs = $$('.tab')) {
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else return;
  event.preventDefault();
  const nextTab = tabs[nextIndex];
  switchTab(nextTab.dataset.tab);
  nextTab.focus();
}

export async function refreshAll(context = { isCurrent: () => true }, request = api) {
  try {
    const health = await request('/api/health');
    const tasks = await request('/api/tasks');
    if (!context.isCurrent()) return;
    state.health = health;
    state.tasks = tasks.tasks || [];
    renderHealth();
    renderTasks();
  } catch (error) {
    if (context.isCurrent()) $('#healthText').textContent = `服务异常：${error.message}`;
    throw error;
  }
}

export function createPlayPage(options) {
  const request = options.request || api;
  const query = options.query || $;
  let initialized = false;

  async function parseUrls() {
    const urls = query('#urlInput').value.trim();
    if (!urls) return setMessage('#message', '请输入播放页地址。', true);
    query('#parseBtn').disabled = true;
    setMessage('#message', '正在解析播放页...');
    try {
      const check = await request('/api/parse/check', { method: 'POST', body: JSON.stringify({ urls }) });
      const duplicateCount = check.summary?.duplicate || 0;
      const failedCount = check.summary?.failed || 0;
      let mode = 'direct';
      if (duplicateCount > 0) {
        mode = await options.duplicateDialog.choose(check.summary || {});
        if (!mode) { setMessage('#message', '已取消下载。'); return; }
      }
      const commit = await request('/api/parse/commit', {
        method: 'POST',
        body: JSON.stringify({ items: check.items, mode }),
      });
      const created = commit.results?.filter(item => item.id).length || 0;
      const started = commit.startIds?.length || 0;
      const duplicateText = duplicateCount ? `，重复 ${duplicateCount} 个` : '';
      setMessage('#message', `已创建 ${created} 个任务，已开始 ${started} 个${duplicateText}，失败 ${failedCount} 个。`, failedCount > 0);
      await options.pollingController.refreshNow();
      options.switchTab('tasks');
    } catch (error) {
      setMessage('#message', error.message, true);
    } finally {
      query('#parseBtn').disabled = false;
    }
  }

  return {
    init() {
      if (initialized) return;
      initialized = true;
      query('#parseBtn').addEventListener('click', parseUrls);
    },
    parseUrls,
  };
}

export function initApp(options = {}) {
  if (application) return application;
  const request = options.request || api;
  const duplicateDialog = options.duplicateDialog || createDuplicateDialog();
  const pollingController = options.pollingController || createPollingController({
    refresh: context => refreshAll(context, request),
    getTasks: () => state.tasks,
    isHidden: () => document.hidden,
    setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeoutFn: timer => window.clearTimeout(timer),
  });
  const playPage = createPlayPage({ request, duplicateDialog, pollingController, switchTab, query: $ });

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    tab.addEventListener('keydown', handleTabKeydown);
  });
  $('#refreshBtn').addEventListener('click', () => pollingController.refreshNow());
  playPage.init();
  initSites({ request }).catch(() => {});
  initTasks(pollingController, { request });
  initDetail({ pollingController, switchTab, duplicateDialog, request });
  document.addEventListener('visibilitychange', () => pollingController.reschedule());
  window.addEventListener('pagehide', () => pollingController.stop());
  window.addEventListener('pageshow', () => { pollingController.start().catch(() => {}); });
  window.addEventListener('beforeunload', () => pollingController.stop());
  pollingController.start().catch(() => {});

  application = { pollingController, duplicateDialog, playPage };
  return application;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initApp(), { once: true });
  else initApp();
}

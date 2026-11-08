export const state = {
  tasks: [],
  health: null,
  detail: null,
  activeLineIndex: 0,
  selectedEpisodes: new Set(),
  taskFilter: 'all',
  selectedTasks: new Set(),
  expandedTasks: new Set(),
  taskPage: 1,
  taskPageSize: 20,
  taskBatchFilter: 'all',
};

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];

export function setMessage(selector, text, isError = false) {
  const element = $(selector);
  element.textContent = text || '';
  element.style.color = isError ? '#dc2626' : '#667085';
}

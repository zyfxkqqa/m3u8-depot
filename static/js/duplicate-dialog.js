import { $ } from './state.js';

export function createDuplicateDialog(query = $) {
  const modal = query('#duplicateModal');
  const text = query('#duplicateModalText');
  const directButton = query('#directDownloadBtn');
  const redownloadButton = query('#redownloadBtn');
  const cancelButton = query('#cancelDuplicateBtn');
  const buttons = [directButton, redownloadButton, cancelButton];
  let pending = null;
  let restoreFocusTo = null;

  function isInsideModal(element) {
    if (!element) return false;
    return element === modal || modal.contains?.(element) === true;
  }

  function canRestoreFocus(element) {
    if (!element || element.isConnected === false || element.hidden === true) return false;
    if (typeof element.focus !== 'function') return false;
    return typeof element.closest !== 'function' || !element.closest('[hidden]');
  }

  function settle(result, options = {}) {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    if (options.hide !== false) modal.hidden = true;
    resolve(result);
    if (options.restoreFocus !== false) {
      const target = restoreFocusTo;
      restoreFocusTo = null;
      if (canRestoreFocus(target)) target.focus();
    } else if (options.preserveRestoreTarget !== true) {
      restoreFocusTo = null;
    }
  }

  function handleKeydown(event) {
    if (modal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      settle(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const currentIndex = buttons.indexOf(event.target);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === buttons.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    buttons[nextIndex].focus();
  }

  directButton.addEventListener('click', () => settle('direct'));
  redownloadButton.addEventListener('click', () => settle('redownload'));
  cancelButton.addEventListener('click', () => settle(null));
  modal.addEventListener('keydown', handleKeydown);

  return {
    choose(summary) {
      if (pending) {
        settle(null, { hide: false, restoreFocus: false, preserveRestoreTarget: true });
      } else {
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        restoreFocusTo = isInsideModal(activeElement) ? null : activeElement;
      }
      text.textContent = `本次选择 ${summary.total || 0} 个，发现 ${summary.duplicate || 0} 个重复任务。直接下载会让新任务自动下载，重复任务进入任务列表等待手动开始。重新下载会让新任务和重复任务全部自动下载。`;
      modal.hidden = false;
      const choice = new Promise(resolve => { pending = resolve; });
      directButton.focus();
      return choice;
    },
  };
}

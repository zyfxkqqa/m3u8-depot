const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

class FakeClassList {
  constructor(active = false) { this.values = new Set(active ? ['active'] : []); }
  toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id, active = false) {
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(active);
    this.hidden = false;
    this.tabIndex = active ? 0 : -1;
    this.isConnected = true;
    this.textContent = '';
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  contains(element) {
    for (let current = element; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
  closest(selector) {
    if (selector !== '[hidden]') return null;
    for (let current = this; current; current = current.parent) {
      if (current.hidden) return current;
    }
    return null;
  }
  focus() { global.document.activeElement = this; }
  async dispatch(type, event = {}) {
    const payload = { target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, ...event };
    for (const listener of this.listeners.get(type) || []) await listener(payload);
    return payload;
  }
}

async function run() {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  assert.match(html, /class="tabs" role="tablist"/);
  for (const name of ['sites', 'play', 'detail', 'tasks']) {
    assert.match(html, new RegExp(`id="${name}Tab"[^>]+role="tab"[^>]+aria-controls="${name}Panel"`));
    assert.match(html, new RegExp(`id="${name}Panel"[^>]+role="tabpanel"[^>]+aria-labelledby="${name}Tab"`));
  }

  const panels = new Map(['sites', 'play', 'detail', 'tasks'].map((name, index) => {
    const panel = new FakeElement(`${name}Panel`, index === 0);
    panel.hidden = index !== 0;
    return [panel.id, panel];
  }));
  const tabs = ['sites', 'play', 'detail', 'tasks'].map((name, index) => {
    const tab = new FakeElement(`${name}Tab`, index === 0);
    tab.dataset.tab = name;
    tab.setAttribute('aria-controls', `${name}Panel`);
    tab.setAttribute('aria-selected', String(index === 0));
    return tab;
  });
  const modal = new FakeElement('duplicateModal'); modal.hidden = true;
  const text = new FakeElement('duplicateModalText');
  const direct = new FakeElement('directDownloadBtn');
  const redownload = new FakeElement('redownloadBtn');
  const cancel = new FakeElement('cancelDuplicateBtn');
  direct.parent = modal; redownload.parent = modal; cancel.parent = modal;
  const opener = new FakeElement('opener');
  const elements = new Map([...panels, [modal.id, modal], [text.id, text], [direct.id, direct], [redownload.id, redownload], [cancel.id, cancel]]);
  global.document = {
    readyState: 'loading', hidden: false, activeElement: opener,
    querySelector: selector => elements.get(selector.replace(/^#/, '')) || null,
    querySelectorAll: selector => selector === '.tab' ? tabs : [],
    getElementById: id => elements.get(id) || null,
    addEventListener() {},
  };
  global.window = { setTimeout, clearTimeout, addEventListener() {} };
  try {
    const main = await import(`${pathToFileURL(path.join(root, 'static', 'js', 'main.js')).href}?accessibility`);
    main.switchTab('detail');
    assert.strictEqual(tabs[2].getAttribute('aria-selected'), 'true');
    assert.strictEqual(tabs[2].tabIndex, 0);
    assert.strictEqual(panels.get('detailPanel').hidden, false);
    assert.strictEqual(panels.get('playPanel').hidden, true);
    const keyEvent = { key: 'End', currentTarget: tabs[2], preventDefault() { this.defaultPrevented = true; } };
    main.handleTabKeydown(keyEvent, tabs);
    assert.strictEqual(global.document.activeElement, tabs[3]);
    assert.strictEqual(panels.get('tasksPanel').hidden, false);

    const { createDuplicateDialog } = await import(`${pathToFileURL(path.join(root, 'static', 'js', 'duplicate-dialog.js')).href}?accessibility`);
    const dialog = createDuplicateDialog(selector => elements.get(selector.replace(/^#/, '')));
    opener.focus();
    const first = dialog.choose({ total: 2, duplicate: 1 });
    assert.strictEqual(global.document.activeElement, direct);
    await modal.dispatch('keydown', { key: 'Tab', target: cancel });
    assert.strictEqual(global.document.activeElement, direct);
    await modal.dispatch('keydown', { key: 'Tab', shiftKey: true, target: direct });
    assert.strictEqual(global.document.activeElement, cancel);
    await modal.dispatch('keydown', { key: 'Escape', target: cancel });
    assert.strictEqual(await first, null);
    assert.strictEqual(modal.hidden, true);
    assert.strictEqual(global.document.activeElement, opener);

    opener.focus();
    const superseded = dialog.choose({ total: 1, duplicate: 1 });
    const replacement = dialog.choose({ total: 3, duplicate: 2 });
    assert.strictEqual(await superseded, null);
    assert.strictEqual(modal.hidden, false);
    assert.strictEqual(global.document.activeElement, direct);
    await redownload.dispatch('click');
    assert.strictEqual(await replacement, 'redownload');
    assert.strictEqual(global.document.activeElement, opener);
  } finally {
    delete global.document;
    delete global.window;
  }
  console.log('stage4-accessibility-smoke-ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

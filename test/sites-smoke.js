const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const sites = require('../lib/sites');
const { createApplication } = require('../server');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'static', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'static', 'style.css'), 'utf8');
  const sitesListRule = css.match(/\.sites-list\s*\{([^}]*)\}/);
  assert.ok(sitesListRule, 'sites-list style rule is required');
  assert.match(sitesListRule[1], /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.doesNotMatch(sitesListRule[1], /repeat\s*\(\s*auto-fit/i);
  const tabNames = [...html.matchAll(/class="tab(?: active)?"[^>]+data-tab="([^"]+)"/g)].map(match => match[1]);
  assert.deepStrictEqual(tabNames, ['sites', 'play', 'detail', 'tasks']);
  assert.match(html, /id="sitesTab" class="tab active"[^>]+aria-selected="true"/);
  assert.match(html, /id="sitesPanel" class="panel tab-panel active"/);
  const sitesPanelHtml = html.slice(html.indexOf('id="sitesPanel"'), html.indexOf('id="playPanel"'));
  assert.doesNotMatch(sitesPanelHtml, /kxmp4|maliys/i);

  const registered = sites.getPublicSites();
  assert.deepStrictEqual(registered.map(site => site.id), ['kxmp4', 'maliys', 'zjlqzg']);
  assert.strictEqual(registered.find(site => site.id === 'maliys').name, '麻栗影视');
  assert.strictEqual(registered.find(site => site.id === 'zjlqzg').name, 'ZJLQZG');
  assert.ok(registered.every(site => site.homepage && site.capabilities.play && site.capabilities.detail));

  const created = [];
  global.document = { createElement(tag) {
    const element = { tag, children: [], append(...items) { this.children.push(...items); } };
    created.push(element);
    return element;
  } };
  try {
    const elements = {
      '#sitesList': { children: [], replaceChildren() { this.children = []; }, append(item) { this.children.push(item); } },
      '#siteCount': {}, '#sitesMessage': { style: {} },
    };
    const module = await import(`${pathToFileURL(path.join(projectRoot, 'static', 'js', 'sites.js')).href}?sites-smoke`);
    await module.initSites({ request: async () => ({ ok: true, sites: registered }), query: selector => elements[selector] });
    assert.strictEqual(elements['#sitesList'].children.length, 3);
    const links = created.filter(element => element.tag === 'a');
    assert.strictEqual(links.length, 3);
    assert.ok(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'));
    assert.deepStrictEqual(links.map(link => link.href), registered.map(site => site.homepage));
  } finally { delete global.document; }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8-sites-'));
  const config = {
    HOST: '127.0.0.1', PORT: 0, ROOT_DIR: root, STATIC_DIR: path.join(projectRoot, 'static'),
    DATA_DIR: path.join(root, 'data'), TASKS_FILE: path.join(root, 'data', 'tasks.json'), OUTPUT_DIR: path.join(root, 'output'),
    FFMPEG: path.join(root, 'missing-ffmpeg.exe'), USER_AGENT: 'sites-smoke', MAX_ACTIVE_TASKS: 1, PARSE_CONCURRENCY: 2,
  };
  const app = createApplication(config, { runtimeLogger: { log: () => {}, close: async () => {} } });
  try {
    const address = await app.start();
    const response = await request(address.port, '/api/sites');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, sites: registered });
  } finally {
    await app.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  console.log('sites-smoke-ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

const { parseDetailPage } = require('../lib/detail-extractor');
const { checkPlayUrls, commitCheckedItems } = require('../lib/parse-workflow');
const { readJsonBody } = require('../lib/http/request-body');
const { sendJson } = require('../lib/http/respond');

function splitUrls(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(url => url.trim())
    .filter(Boolean);
}

function waitWithSignal(value, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('parse aborted'));
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('parse aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => { signal.removeEventListener('abort', onAbort); resolve(result); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function createParseRoutes({ store, scheduler, parseOptions, parseDetail = parseDetailPage, validateUrl, runParseOperation = (_req, work) => work() }) {
  return async function parseRoutes(req, res, url) {
    if (req.method !== 'POST') return false;

    if (url.pathname === '/api/parse') {
      const body = await readJsonBody(req);
      const urls = splitUrls(body.urls);
      if (urls.length === 0) {
        sendJson(res, 400, { ok: false, error: '请输入至少一个播放页地址' });
        return true;
      }
      const checked = await runParseOperation(req, async signal => {
        await Promise.all(urls.map(value => waitWithSignal(validateUrl(value, { signal }), signal)));
        return checkPlayUrls(urls, store, {
          ...parseOptions,
          parsePlayPage: pageUrl => parseOptions.parsePlayPage(pageUrl, { signal }),
        });
      });
      const committed = await commitCheckedItems(checked.items, store, { mode: 'manual', batch: body.batch || null });
      sendJson(res, 200, { ok: true, results: committed.results, summary: committed.summary });
      return true;
    }

    if (url.pathname === '/api/parse/check') {
      const body = await readJsonBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : splitUrls(body.urls);
      if (urls.length === 0) {
        sendJson(res, 400, { ok: false, error: '请输入至少一个播放页地址' });
        return true;
      }
      const checked = await runParseOperation(req, async signal => {
        await Promise.all(urls.map(value => waitWithSignal(validateUrl(value, { signal }), signal)));
        return checkPlayUrls(urls, store, {
          ...parseOptions,
          parsePlayPage: pageUrl => parseOptions.parsePlayPage(pageUrl, { signal }),
        });
      });
      sendJson(res, 200, { ok: true, items: checked.items, summary: checked.summary });
      return true;
    }

    if (url.pathname === '/api/parse/commit') {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        sendJson(res, 400, { ok: false, error: '没有可提交的解析结果' });
        return true;
      }
      const mode = body.mode || 'manual';
      if (!['manual', 'direct', 'redownload'].includes(mode)) {
        sendJson(res, 400, { ok: false, error: `未知提交模式: ${mode}` });
        return true;
      }
      const committed = await commitCheckedItems(items, store, { mode, batch: body.batch || null });
      if (committed.startIds.length) scheduler.schedule();
      sendJson(res, 200, { ok: true, ...committed });
      return true;
    }

    if (url.pathname === '/api/detail/parse') {
      const body = await readJsonBody(req);
      const detailUrl = String(body.url || '').trim();
      if (!detailUrl) {
        sendJson(res, 400, { ok: false, error: '请输入详情页地址' });
        return true;
      }
      const detail = await runParseOperation(req, async signal => {
        await waitWithSignal(validateUrl(detailUrl, { signal }), signal);
        return parseDetail(detailUrl, { signal });
      });
      sendJson(res, 200, { ok: true, detail });
      return true;
    }

    return false;
  };
}

module.exports = { createParseRoutes, splitUrls };

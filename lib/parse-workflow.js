const crypto = require('crypto');
const { parsePlayPage } = require('./play-extractor');
const { sanitizeBatchInput } = require('./task-input');

function summarizeItems(items) {
  return items.reduce((summary, item) => {
    summary.total += 1;
    if (item.status === 'parse_failed') summary.failed += 1;
    else if (item.duplicate) summary.duplicate += 1;
    else summary.new += 1;
    return summary;
  }, { total: 0, new: 0, duplicate: 0, failed: 0 });
}

async function checkPlayUrls(urls, store, options = {}) {
  const parsePage = options.parsePlayPage || parsePlayPage;
  const requestedConcurrency = Number(options.concurrency);
  const configuredConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 4;
  const concurrency = Math.max(1, Math.min(urls.length || 1, configuredConcurrency));
  const items = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= urls.length) return;
      const pageUrl = urls[index];
      try {
        const parsed = await parsePage(pageUrl);
        const duplicateTask = store.findDuplicate(parsed);
        items[index] = {
          ...parsed,
          duplicate: Boolean(duplicateTask),
          duplicateOf: duplicateTask?.id || null,
          existingStatus: duplicateTask?.status || null,
          existingTitle: duplicateTask?.title || null,
        };
      } catch (error) {
        if (options.onParseError) options.onParseError(pageUrl, error);
        items[index] = {
          pageUrl,
          status: 'parse_failed',
          error: String(error.message || error),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { items, summary: summarizeItems(items) };
}

async function commitCheckedItems(items, store, options = {}) {
  const mode = options.mode || 'manual';
  const batch = sanitizeBatchInput(options.batch);
  const batchId = batch ? crypto.randomUUID() : null;
  const created = [];

  for (const item of items) {
    if (item.status === 'parse_failed') {
      created.push(item);
      continue;
    }

    const task = await store.commitParsedTask(item, {
      mode,
      batchId,
      batchTitle: batch?.title || null,
      batchLine: batch?.line || null,
    });

    created.push(task);
  }

  return {
    results: created,
    summary: summarizeItems(created),
    startIds: created.filter(item => item.id && item.status === 'queued').map(item => item.id),
  };
}

module.exports = { checkPlayUrls, commitCheckedItems, summarizeItems };

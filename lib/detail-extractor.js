const { requestText } = require('./http-client');
const { getSiteAdapter, common } = require('./sites');
async function parseDetailPage(detailUrl, options = {}) {
  const html = await requestText(detailUrl, '', { ...(options.requestOptions || {}), signal: options.signal || options.requestOptions?.signal });
  return getSiteAdapter(detailUrl).parseDetail(html, detailUrl);
}
module.exports = { parseDetailPage, extractDetailTitle: common.extractDetailTitle, extractPlayLines: common.extractPlayLines };

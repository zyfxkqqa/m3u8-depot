const { requestText } = require('./http-client');
const { getSiteAdapter, common } = require('./sites');
async function parsePlayPage(pageUrl, options = {}) {
  const html = await requestText(pageUrl, '', { ...(options.requestOptions || {}), signal: options.signal || options.requestOptions?.signal });
  return getSiteAdapter(pageUrl).parsePlay(html, pageUrl);
}
module.exports = { parsePlayPage, parsePlayerData: common.parsePlayerData, decodePlayerUrl: common.decodePlayerUrl, extractTitle: common.extractTitle, extractM3u8: common.extractM3u8 };

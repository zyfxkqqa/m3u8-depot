const common = require('./common-maccms');
module.exports = {
  id: 'maliys',
  name: '麻栗影视',
  homepage: 'https://www.maliys.com/',
  domain: 'www.maliys.com',
  capabilities: { play: true, detail: true },
  status: 'supported',
  matches: url => /(^|\.)maliys\.com$/i.test(new URL(url).hostname),
  parsePlay: common.parsePlayHtml,
  parseDetail: common.parseDetailHtml,
};

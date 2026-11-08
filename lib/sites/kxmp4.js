const common = require('./common-maccms');
module.exports = {
  id: 'kxmp4',
  name: 'KXMP4',
  homepage: 'https://www.kxmp4.com/',
  domain: 'www.kxmp4.com',
  capabilities: { play: true, detail: true },
  status: 'supported',
  matches: url => /(^|\.)kxmp4\.com$/i.test(new URL(url).hostname),
  parsePlay: common.parsePlayHtml,
  parseDetail: common.parseDetailHtml,
};

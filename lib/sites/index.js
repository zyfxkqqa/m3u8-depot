const common = require('./common-maccms');
const kxmp4 = require('./kxmp4');
const maliys = require('./maliys');
const zjlqzg = require('./zjlqzg');
const adapters = [kxmp4, maliys, zjlqzg];
function getPublicSites() {
  return adapters.map(({ id, name, homepage, domain, capabilities, status }) => ({
    id, name, homepage, domain, status, capabilities: { ...capabilities },
  }));
}
function getSiteAdapter(url) {
  return adapters.find(adapter => { try { return adapter.matches(url); } catch (_) { return false; } }) || { id: 'common-maccms', matches: () => true, parsePlay: common.parsePlayHtml, parseDetail: common.parseDetailHtml };
}
module.exports = { adapters, getPublicSites, getSiteAdapter, common };

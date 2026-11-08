const { sendJson } = require('../lib/http/respond');
const { getPublicSites } = require('../lib/sites');

function createSiteRoutes() {
  return async function siteRoutes(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/sites') return false;
    sendJson(res, 200, { ok: true, sites: getPublicSites() });
    return true;
  };
}

module.exports = { createSiteRoutes };

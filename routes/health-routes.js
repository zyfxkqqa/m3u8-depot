const fs = require('fs');
const { sendJson } = require('../lib/http/respond');
const { VERSION } = require('../lib/version');

function createHealthRoutes({ runtimeConfig }) {
  return async function healthRoutes(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/health') return false;
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      port: runtimeConfig.PORT,
      outputDir: runtimeConfig.OUTPUT_DIR,
      ffmpeg: runtimeConfig.FFMPEG,
      ffmpegExists: fs.existsSync(runtimeConfig.FFMPEG),
      maxActiveTasks: runtimeConfig.MAX_ACTIVE_TASKS,
    });
    return true;
  };
}

module.exports = { createHealthRoutes };

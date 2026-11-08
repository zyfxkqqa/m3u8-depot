const http = require('http');
const path = require('path');

const config = require('./lib/config');
const { createTaskStore } = require('./lib/task-store');
const { createScheduler } = require('./lib/scheduler');
const { createRuntimeLogger } = require('./lib/runtime-logger');
const { sendJson } = require('./lib/http/respond');
const { HttpError, asHttpError } = require('./lib/http-error');
const { protectLocalPost } = require('./lib/http/request-protection');
const { serveStatic } = require('./lib/http/static-files');
const { createHealthRoutes } = require('./routes/health-routes');
const { createSiteRoutes } = require('./routes/site-routes');
const { createParseRoutes } = require('./routes/parse-routes');
const { createTaskRoutes, queryTasks } = require('./routes/task-routes');
const { VERSION } = require('./lib/version');
const { createUrlPolicy } = require('./lib/url-policy');
const { parsePlayPage } = require('./lib/play-extractor');
const { parseDetailPage } = require('./lib/detail-extractor');

function createApplication(runtimeConfig = config, applicationOptions = {}) {
  const shutdownTimeoutMs = applicationOptions.shutdownTimeoutMs ?? 5000;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new TypeError('shutdownTimeoutMs must be positive');
  const validateUrl = applicationOptions.urlPolicy || createUrlPolicy(applicationOptions.urlPolicyOptions);
  const requestOptions = { validateUrl, ...(applicationOptions.httpClientOptions || {}) };
  const loggerObject = applicationOptions.runtimeLogger
    || (applicationOptions.logger ? { log: applicationOptions.logger, close: async () => {} } : createRuntimeLogger({
      filePath: applicationOptions.runtimeLogFile || path.join(runtimeConfig.ROOT_DIR, 'server-runtime.log'),
      ...(applicationOptions.loggerOptions || {}),
    }));
  const runtimeLogger = (message, error) => loggerObject.log(message, error);
  const parseOptions = {
    concurrency: runtimeConfig.PARSE_CONCURRENCY || 4,
    parsePlayPage: applicationOptions.parsePlayPage || ((pageUrl, options = {}) => parsePlayPage(pageUrl, { requestOptions, signal: options.signal })),
    onParseError: (pageUrl, error) => runtimeLogger(`parse failed: ${pageUrl}`, error),
  };
  const store = createTaskStore({
    dataDir: runtimeConfig.DATA_DIR,
    tasksFile: runtimeConfig.TASKS_FILE,
    outputDir: runtimeConfig.OUTPUT_DIR,
    onPersistenceError: error => runtimeLogger('task persistence failed', error),
    ...(applicationOptions.storeOptions || {}),
  });
  const scheduler = createScheduler(store, {
    ffmpeg: runtimeConfig.FFMPEG,
    n3u8dl: runtimeConfig.N3U8DL,
    engine: runtimeConfig.DOWNLOAD_ENGINE,
    threads: runtimeConfig.DOWNLOAD_THREADS,
    outputDir: runtimeConfig.OUTPUT_DIR,
    userAgent: runtimeConfig.USER_AGENT,
    maxActiveTasks: runtimeConfig.MAX_ACTIVE_TASKS,
    onError: error => runtimeLogger('scheduler task failed', error),
    onTaskError: (task, error) => runtimeLogger(`download failed: ${task.id} ${task.title || ''}`, error),
    ...(applicationOptions.schedulerOptions || {}),
  });
  const routes = [
    createHealthRoutes({ runtimeConfig }),
    createSiteRoutes(),
    createParseRoutes({
      store, scheduler, parseOptions, validateUrl,
      parseDetail: applicationOptions.parseDetail || ((detailUrl, options = {}) => parseDetailPage(detailUrl, { requestOptions, signal: options.signal })),
      runParseOperation,
    }),
    createTaskRoutes({ store, scheduler }),
  ];
  let closePromise = null;
  let closing = false;
  const activeParseControllers = new Set();
  const sockets = new Set();

  async function runParseOperation(req, work) {
    if (closing) throw new HttpError(503, 'APP_CLOSING', 'application is closing');
    const controller = new AbortController();
    activeParseControllers.add(controller);
    const abortRequest = () => controller.abort(new HttpError(499, 'CLIENT_ABORTED', 'client disconnected'));
    req.once('aborted', abortRequest);
    try {
      return await work(controller.signal);
    } finally {
      req.off('aborted', abortRequest);
      activeParseControllers.delete(controller);
    }
  }

  async function routeRequest(req, res) {
    if (closing) throw new HttpError(503, 'APP_CLOSING', 'application is closing');
    const url = new URL(req.url, `http://${runtimeConfig.HOST}:${runtimeConfig.PORT}`);
    protectLocalPost(req);
    const isPollingRequest = req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/tasks');
    if (!isPollingRequest) runtimeLogger(`${req.method} ${url.pathname}`);
    for (const route of routes) {
      if (await route(req, res, url)) return;
    }
    serveStatic(req, res, runtimeConfig);
  }

  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch(error => {
      const mapped = asHttpError(error);
      runtimeLogger(`request failed: ${req.method} ${req.url}`, mapped.cause || error);
      sendJson(res, mapped.statusCode || 500, { ok: false, code: mapped.code || 'INTERNAL_ERROR', error: String(mapped.message || mapped) });
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function start() {
    await store.loadTasks();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(runtimeConfig.PORT, runtimeConfig.HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!scheduler.isStopping()) scheduler.schedule();
    runtimeLogger(`server started: http://${runtimeConfig.HOST}:${server.address().port}`);
    return server.address();
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      const closingError = new HttpError(503, 'APP_CLOSING', 'application is closing');
      for (const controller of activeParseControllers) controller.abort(closingError);
      const deadlineAt = Date.now() + shutdownTimeoutMs;
      const failures = [];

      const timeoutError = resource => {
        const error = new Error(`shutdown timed out while closing ${resource}`);
        error.code = 'SHUTDOWN_TIMEOUT';
        error.resource = resource;
        return error;
      };

      const closeResource = async (resource, operation, onFailure) => {
        let operationPromise;
        try {
          operationPromise = Promise.resolve(operation());
        } catch (error) {
          operationPromise = Promise.reject(error);
        }

        const remaining = deadlineAt - Date.now();
        let timer;
        try {
          if (remaining <= 0) {
            operationPromise.catch(() => {});
            throw timeoutError(resource);
          }
          await Promise.race([
            operationPromise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(timeoutError(resource)), remaining);
            }),
          ]);
        } catch (error) {
          failures.push({ resource, error });
          try { onFailure?.(error); } catch (cleanupError) {
            failures.push({ resource: `${resource} cleanup`, error: cleanupError });
          }
        } finally {
          clearTimeout(timer);
        }
      };

      const closeHttpServer = () => new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
      });
      const forceCloseHttpServer = () => {
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
      };

      await Promise.all([
        closeResource('scheduler', () => scheduler.stop({ cancelActive: true })),
        closeResource('HTTP server', closeHttpServer, forceCloseHttpServer),
      ]);

      await Promise.all([
        closeResource('task store', () => store.close()),
        closeResource('runtime logger', () => loggerObject.close()),
      ]);

      forceCloseHttpServer();
      if (failures.length) {
        const error = new AggregateError(
          failures.map(failure => failure.error),
          `application shutdown failed: ${failures.map(failure => failure.resource).join(', ')}`,
        );
        error.code = 'SHUTDOWN_FAILED';
        error.failures = failures.map(failure => ({
          resource: failure.resource,
          code: failure.error?.code || 'SHUTDOWN_ERROR',
          message: String(failure.error?.message || failure.error),
        }));
        throw error;
      }
    })();
    return closePromise;
  }

  return { server, store, scheduler, logger: loggerObject, start, close };
}

let application = null;
let shuttingDown = false;

async function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (application) application.logger.log(`controlled shutdown: ${signal}`);
  try {
    if (application) await application.close();
  } catch (error) {
    if (application) application.logger.log('controlled shutdown failed', error);
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  process.on('uncaughtException', error => {
    if (application) application.logger.log('uncaughtException', error);
    shutdown('uncaughtException', 1).catch(() => {});
  });
  process.on('unhandledRejection', error => {
    if (application) application.logger.log('unhandledRejection', error);
    shutdown('unhandledRejection', 1).catch(() => {});
  });
  process.on('SIGINT', () => shutdown('SIGINT', 0).catch(() => {}));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0).catch(() => {}));

  application = createApplication();
  application.start().then(() => {
    console.log(`m3u8-depot v${VERSION}: http://${config.HOST}:${config.PORT}`);
    console.log(`Output: ${config.OUTPUT_DIR}`);
    console.log(`FFmpeg: ${config.FFMPEG}`);
  }).catch(error => {
    application.logger.log('startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = { createApplication, queryTasks };

const http = require('http');
const https = require('https');
const { USER_AGENT } = require('./config');
const { HttpError } = require('./http-error');
const { createUrlPolicy } = require('./url-policy');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function abortError(cause) {
  if (cause instanceof HttpError && cause.code === 'UPSTREAM_ABORTED') return cause;
  return new HttpError(499, 'UPSTREAM_ABORTED', 'upstream request was aborted', cause ? { cause } : {});
}

function normalizeUpstreamError(error, signal) {
  if (error instanceof HttpError && error.code === 'UPSTREAM_DEADLINE') return error;
  if (error instanceof HttpError && error.code === 'UPSTREAM_ABORTED') return error;
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return abortError(error || signal?.reason);
  }
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function waitWithSignal(value, signal) {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => { signal.removeEventListener('abort', onAbort); resolve(result); },
      error => { signal.removeEventListener('abort', onAbort); reject(normalizeUpstreamError(error, signal)); },
    );
  });
}

function positiveOption(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) throw new TypeError(`${name} must be a positive number`);
  return selected;
}

function pinnedLookup(addresses) {
  let index = 0;
  const validated = addresses
    .map(item => ({ address: item.address, family: Number(item.family) }))
    .filter(item => item.address && (item.family === 4 || item.family === 6));

  return (hostname, options, callback) => {
    const lookupOptions = typeof options === 'object' && options !== null ? options : { family: options };
    const requestedFamily = Number(lookupOptions.family) || 0;
    let candidates = requestedFamily
      ? validated.filter(item => item.family === requestedFamily)
      : validated.slice();

    const order = lookupOptions.order || (lookupOptions.verbatim === false ? 'ipv4first' : 'verbatim');
    if (order === 'ipv4first') candidates.sort((left, right) => left.family - right.family);
    if (order === 'ipv6first') candidates.sort((left, right) => right.family - left.family);

    if (!candidates.length) {
      const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      error.errno = 'ENOTFOUND';
      error.syscall = 'getaddrinfo';
      error.hostname = hostname;
      callback(error);
      return;
    }

    if (lookupOptions.all) {
      callback(null, candidates.map(item => ({ ...item })));
      return;
    }

    const selected = candidates[index++ % candidates.length];
    callback(null, selected.address, selected.family);
  };
}

function requestHop(validated, referer, options, deadlineAt) {
  const parsed = validated.url;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new HttpError(504, 'UPSTREAM_DEADLINE', 'upstream request deadline exceeded'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let deadlineTimer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', onAbort);
      request.setTimeout(0);
      if (response) response.setTimeout(0);
      if (error) reject(normalizeUpstreamError(error, options.signal)); else resolve(value);
    };
    const failAndDestroy = error => {
      if (response && !response.destroyed) response.destroy(error);
      if (!request.destroyed) request.destroy(error);
      finish(error);
    };
    const onAbort = () => failAndDestroy(abortError(options.signal?.reason));
    const client = parsed.protocol === 'https:' ? https : http;
    const transportOptions = {
      method: 'GET',
      headers: {
        'User-Agent': options.userAgent || USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
      agent: false,
      lookup: pinnedLookup(validated.addresses),
      servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
    };
    const onResponse = res => {
      response = res;
      res.setTimeout(options.idleTimeoutMs, () => failAndDestroy(new HttpError(504, 'UPSTREAM_IDLE_TIMEOUT', 'upstream response timed out')));
      if (REDIRECTS.has(res.statusCode) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, parsed).href;
        res.destroy();
        finish(null, { redirectUrl: nextUrl });
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(new HttpError(502, 'UPSTREAM_HTTP', `upstream returned HTTP ${res.statusCode}`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        failAndDestroy(new HttpError(502, 'UPSTREAM_TOO_LARGE', 'upstream response is too large'));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (received > options.maxBytes) {
          failAndDestroy(new HttpError(502, 'UPSTREAM_TOO_LARGE', 'upstream response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, { text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', finish);
    };
    const request = options.requestFactory
      ? options.requestFactory({ client, url: parsed, options: transportOptions, onResponse })
      : client.request(parsed, transportOptions, onResponse);
    request.setTimeout(options.idleTimeoutMs, () => failAndDestroy(new HttpError(504, 'UPSTREAM_IDLE_TIMEOUT', 'upstream connection timed out')));
    request.on('error', finish);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    deadlineTimer = setTimeout(() => failAndDestroy(new HttpError(504, 'UPSTREAM_DEADLINE', 'upstream request deadline exceeded')), remaining);
    request.end();
  });
}

async function requestText(url, referer = '', options = {}) {
  const validateUrl = options.validateUrl || createUrlPolicy(options.urlPolicyOptions);
  const requestOptions = {
    ...options,
    maxBytes: positiveOption(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
    idleTimeoutMs: positiveOption(options.idleTimeoutMs, 15000, 'idleTimeoutMs'),
  };
  const deadlineMs = positiveOption(options.deadlineMs, 30000, 'deadlineMs');
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new TypeError('maxRedirects must be a non-negative integer');
  const deadlineAt = options.deadlineAt ?? (Date.now() + deadlineMs);
  let currentUrl = url;
  let currentReferer = referer;

  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfAborted(options.signal);
    if (redirectCount > maxRedirects) throw new HttpError(502, 'TOO_MANY_REDIRECTS', 'too many redirects');
    const validated = await waitWithSignal(validateUrl(currentUrl, { deadlineAt, signal: options.signal }), options.signal);
    const result = await requestHop(validated, currentReferer, requestOptions, deadlineAt);
    if (!result.redirectUrl) return result.text;
    currentReferer = currentReferer || currentUrl;
    currentUrl = result.redirectUrl;
  }
}

module.exports = { DEFAULT_MAX_BYTES, pinnedLookup, requestText };

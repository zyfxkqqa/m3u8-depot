const dns = require('dns');
const net = require('net');
const { HttpError } = require('./http-error');

const DEFAULT_HOSTS = ['kxmp4.com', 'maliys.com', 'zjlqzg.com'];
const BLOCKED_ADDRESSES = new net.BlockList();
const PUBLIC_ADDRESS_EXCEPTIONS = new Set([
  '192.0.0.9',
  '192.0.0.10',
  '192.88.99.2',
]);
const SPECIAL_IPV6_REPRESENTATIONS = new net.BlockList();
SPECIAL_IPV6_REPRESENTATIONS.addSubnet('::', 96, 'ipv6');
SPECIAL_IPV6_REPRESENTATIONS.addSubnet('::ffff:0:0', 96, 'ipv6');
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'],
  ['100::', 64, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['fec0::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'],
  ['2001::', 32, 'ipv6'], ['2001:2::', 48, 'ipv6'], ['2001:10::', 28, 'ipv6'],
  ['2001:20::', 28, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'], ['5f00::', 16, 'ipv6'],
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, family);

function normalizeHostname(value) {
  return String(value).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isBlockedAddress(address) {
  const normalized = normalizeHostname(address).split('%')[0];
  const family = net.isIP(normalized);
  if (!family) return true;
  if (family === 6 && SPECIAL_IPV6_REPRESENTATIONS.check(normalized, 'ipv6')) return true;
  if (PUBLIC_ADDRESS_EXCEPTIONS.has(normalized)) return false;
  return BLOCKED_ADDRESSES.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function hostAllowed(hostname, allowedHosts) {
  const host = normalizeHostname(hostname);
  return allowedHosts.some(base => host === base || host.endsWith(`.${base}`));
}

function resolveBeforeDeadline(resolver, hostname, deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return resolver(hostname);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new HttpError(504, 'UPSTREAM_DEADLINE', 'upstream request deadline exceeded'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HttpError(504, 'UPSTREAM_DEADLINE', 'upstream request deadline exceeded')),
      remaining,
    );
    Promise.resolve().then(() => resolver(hostname)).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function createUrlPolicy(options = {}) {
  const allowedHosts = (options.allowedHosts || DEFAULT_HOSTS).map(normalizeHostname);
  const resolver = options.resolver || (hostname => dns.promises.lookup(hostname, { all: true, verbatim: true }));
  return async function validateUrl(value, context = {}) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new HttpError(400, 'INVALID_URL', 'invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'URL_PROTOCOL', 'only HTTP and HTTPS URLs are allowed');
    if (parsed.username || parsed.password) throw new HttpError(400, 'URL_CREDENTIALS', 'URL credentials are not allowed');
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostAllowed(hostname, allowedHosts)) throw new HttpError(403, 'SITE_NOT_ALLOWED', 'site is not supported');
    if (hostname === 'localhost' || net.isIP(hostname)) throw new HttpError(403, 'PRIVATE_ADDRESS', 'local and private addresses are not allowed');
    let records;
    try {
      records = await resolveBeforeDeadline(resolver, hostname, context.deadlineAt);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'UPSTREAM_DEADLINE') throw error;
      throw new HttpError(502, 'DNS_FAILED', 'DNS lookup failed', { cause: error });
    }
    const addresses = (Array.isArray(records) ? records : [records]).map(record => typeof record === 'string' ? { address: record, family: net.isIP(record) } : record);
    if (!addresses.length || addresses.some(record => !record.address || isBlockedAddress(record.address))) {
      throw new HttpError(403, 'PRIVATE_ADDRESS', 'resolved address is not publicly routable');
    }
    return { url: parsed, addresses };
  };
}

module.exports = { DEFAULT_HOSTS, createUrlPolicy, isBlockedAddress };

function htmlDecode(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(value) {
  return htmlDecode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function sanitizeFileName(name) {
  let value = String(name || 'video')
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .]+$/g, '')
    .slice(0, 120)
    .replace(/[ .]+$/g, '');
  const windowsStem = value.split('.')[0].replace(/[ .]+$/g, '');
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(windowsStem)) {
    value = `_${value}`.slice(0, 120).replace(/[ .]+$/g, '');
  }
  return value || 'video';
}

function combineTitle(name, part) {
  const cleanName = stripTags(name);
  const cleanPart = stripTags(part);
  if (cleanName && cleanPart && !cleanName.includes(cleanPart)) return `${cleanName} ${cleanPart}`;
  return cleanName || cleanPart;
}

function formatEpisode(nid) {
  const number = Number(nid);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `第${String(number).padStart(2, '0')}集`;
}

function unescapeJsonScript(value) {
  return String(value || '').replace(/\\\//g, '/');
}

function resolveUrl(url, baseUrl) {
  return new URL(url, baseUrl).href;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  htmlDecode,
  stripTags,
  sanitizeFileName,
  combineTitle,
  formatEpisode,
  unescapeJsonScript,
  resolveUrl,
  uniqueBy,
};

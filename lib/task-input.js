const PARSED_FIELDS = ['pageUrl', 'title', 'titleSource', 'm3u8Url', 'm3u8Source'];

function pickStringFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (typeof source?.[field] === 'string') result[field] = source[field];
  }
  return result;
}

function sanitizeParsedInput(source) {
  const parsed = pickStringFields(source, PARSED_FIELDS);
  if (!parsed.pageUrl || !parsed.m3u8Url) throw new Error('Parsed item is missing pageUrl or m3u8Url');
  return parsed;
}

function sanitizeBatchInput(source) {
  if (!source || typeof source !== 'object') return null;
  const batch = pickStringFields(source, ['title', 'line']);
  return batch.title || batch.line ? batch : null;
}

module.exports = { PARSED_FIELDS, sanitizeBatchInput, sanitizeParsedInput };

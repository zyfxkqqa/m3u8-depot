const { combineTitle, formatEpisode, sanitizeFileName, stripTags, unescapeJsonScript, resolveUrl, uniqueBy } = require('../text');

function extractBalancedObject(source, startIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function parsePlayerData(html) {
  const assignment = /\b(?:var|let|const)\s+player_[A-Za-z0-9_]+\s*=\s*/ig;
  let match;
  while ((match = assignment.exec(html)) !== null) {
    let objectStart = assignment.lastIndex;
    while (/\s/.test(html[objectStart] || '')) objectStart += 1;
    if (html[objectStart] !== '{') continue;
    const objectText = extractBalancedObject(html, objectStart);
    if (!objectText) continue;
    try {
      const parsed = JSON.parse(unescapeJsonScript(objectText));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof parsed.url === 'string' && parsed.url.trim()) return parsed;
    } catch (_) { /* Try the next assignment. */ }
  }
  return null;
}

function decodePlayerUrl(url, encrypt) {
  let value = unescapeJsonScript(url);
  try {
    if (Number(encrypt) === 1) value = decodeURIComponent(value);
    if (Number(encrypt) === 2) value = Buffer.from(value, 'base64').toString('utf8');
  } catch (_) {
    return unescapeJsonScript(url);
  }
  return unescapeJsonScript(value);
}

function extractTitle(html, playerData) {
  const h1 = html.match(/<h1\s+class=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const name = h1[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '';
    const part = h1[1].match(/<span\b[^>]*class=["'][^"']*data2[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '';
    const title = combineTitle(name, part) || stripTags(h1[1]);
    if (title) return { title, source: 'h1.title' };
  }
  const vodVars = html.match(/var\s+vod_name\s*=\s*'([^']*)'[\s\S]*?vod_part\s*=\s*'([^']*)'/i);
  if (vodVars) {
    const title = combineTitle(vodVars[1], vodVars[2]);
    if (title) return { title, source: 'vod_name+vod_part' };
  }
  if (playerData?.vod_data?.vod_name) {
    const title = combineTitle(playerData.vod_data.vod_name, formatEpisode(playerData.nid));
    if (title) return { title, source: 'player_data' };
  }
  const titleText = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleMatch = titleText.match(/《([^《》]+)》\s*(第\s*\d+\s*集)?/);
  if (titleMatch) return { title: combineTitle(titleMatch[1], titleMatch[2]), source: 'document.title' };
  if (titleText) return { title: titleText.replace(/\s*[-_].*$/, ''), source: 'document.title' };
  return { title: `video_${Date.now()}`, source: 'fallback' };
}

function extractM3u8(html, playerData) {
  if (playerData?.url) {
    const playerUrl = decodePlayerUrl(playerData.url, playerData.encrypt);
    if (/\.m3u8(?:$|[?#])/i.test(playerUrl)) return { m3u8Url: playerUrl, source: 'player_data.url' };
  }
  const jsonUrl = html.match(/"url"\s*:\s*"(https?:\\?\/\\?\/[^"']+?\.m3u8[^"']*)"/i)?.[1];
  if (jsonUrl) return { m3u8Url: unescapeJsonScript(jsonUrl), source: 'json url' };
  const plainUrl = html.match(/https?:\/\/[^"'<>\s]+?\.m3u8[^"'<>\s]*/i)?.[0];
  if (plainUrl) return { m3u8Url: plainUrl, source: 'plain url' };
  throw new Error('未在页面中找到 m3u8 地址');
}

function parsePlayHtml(html, pageUrl) {
  const playerData = parsePlayerData(html);
  const titleInfo = extractTitle(html, playerData);
  const m3u8Info = extractM3u8(html, playerData);
  return { pageUrl, title: sanitizeFileName(titleInfo.title), titleSource: titleInfo.source, m3u8Url: m3u8Info.m3u8Url, m3u8Source: m3u8Info.source };
}

function extractDetailTitle(html) {
  const detailTitle = html.match(/<div\b[^>]*class=["'][^"']*stui-content__detail[^"']*["'][^>]*>[\s\S]*?<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (detailTitle) return stripTags(detailTitle);
  const h1Title = html.match(/<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1Title) return stripTags(h1Title);
  const docTitle = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const match = docTitle.match(/《([^《》]+)》/);
  return match?.[1] || docTitle.replace(/\s*[-_].*$/, '') || '未命名详情页';
}

function extractPlayLines(html, detailUrl) {
  const lines = [];
  const blockPattern = /<div\b[^>]*class=["'][^"']*stui-vodlist__head[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(html)) !== null) {
    const block = blockMatch[1];
    if (!/stui-content__playlist/i.test(block) || !/(?:\/play\/|\/yun\/)/i.test(block)) continue;
    const rawName = block.match(/<span\b[^>]*class=["'][^"']*pull-right1[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
      || block.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]
      || `线路 ${lines.length + 1}`;
    const name = stripTags(rawName).replace(/^\s*[>&|\-]+\s*/, '').trim() || `线路 ${lines.length + 1}`;
    const episodes = [];
    const linkPattern = /<a\b[^>]*href=["']([^"']*(?:\/play\/|\/yun\/)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkPattern.exec(block)) !== null) episodes.push({ name: stripTags(linkMatch[2]) || `第${episodes.length + 1}集`, url: resolveUrl(linkMatch[1], detailUrl) });
    const uniqueEpisodes = uniqueBy(episodes, item => item.url);
    if (uniqueEpisodes.length > 0) lines.push({ name, episodes: uniqueEpisodes });
  }
  return uniqueBy(lines, line => `${line.name}:${line.episodes.map(item => item.url).join('|')}`);
}

function parseDetailHtml(html, detailUrl) {
  const title = extractDetailTitle(html);
  const lines = extractPlayLines(html, detailUrl);
  if (lines.length === 0) throw new Error('未在详情页中找到播放线路');
  return { title, url: detailUrl, lines };
}

module.exports = { parsePlayerData, decodePlayerUrl, extractTitle, extractM3u8, parsePlayHtml, extractDetailTitle, extractPlayLines, parseDetailHtml };

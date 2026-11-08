const common = require('./common-maccms');
const { stripTags, resolveUrl, uniqueBy } = require('../text');

function getAttribute(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] || '';
}

function hasClass(attributes, className) {
  return getAttribute(attributes, 'class').split(/\s+/).includes(className);
}

function extractTitle(html) {
  const h1Pattern = /<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi;
  let h1Match;
  while ((h1Match = h1Pattern.exec(html)) !== null) {
    if (!hasClass(h1Match[1], 'title')) continue;
    const spanText = stripTags(h1Match[2].match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    return spanText || stripTags(h1Match[2]) || '未命名详情页';
  }
  return '未命名详情页';
}

function extractBalancedDiv(html, startIndex) {
  const tagPattern = /<div\b[^>]*>|<\/div\s*>/gi;
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html)) !== null) {
    if (/^<\/div/i.test(tagMatch[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(startIndex, tagPattern.lastIndex);
  }
  return html.slice(startIndex);
}

function extractTabNames(html) {
  const names = new Map();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorPattern.exec(html)) !== null) {
    const href = getAttribute(anchorMatch[1], 'href');
    const id = href.match(/^#(playlist\d+)$/i)?.[1]?.toLowerCase();
    if (id && !names.has(id)) names.set(id, stripTags(anchorMatch[2]));
  }
  return names;
}

function extractEpisodes(block, detailUrl) {
  const episodes = [];
  const listPattern = /<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi;
  let listMatch;
  while ((listMatch = listPattern.exec(block)) !== null) {
    if (!hasClass(listMatch[1], 'ewave-content__playlist')) continue;
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let anchorMatch;
    while ((anchorMatch = anchorPattern.exec(listMatch[2])) !== null) {
      const href = getAttribute(anchorMatch[1], 'href');
      if (!/\/tianlangtv\//i.test(href)) continue;
      try {
        episodes.push({
          name: stripTags(anchorMatch[2]) || `第${episodes.length + 1}集`,
          url: resolveUrl(href, detailUrl),
        });
      } catch (_) { /* Ignore malformed episode links. */ }
    }
  }
  return uniqueBy(episodes, episode => episode.url);
}

function parseDetail(html, detailUrl) {
  const title = extractTitle(html);
  const tabNames = extractTabNames(html);
  const lines = [];
  const divPattern = /<div\b([^>]*)>/gi;
  let divMatch;
  while ((divMatch = divPattern.exec(html)) !== null) {
    const id = getAttribute(divMatch[1], 'id').toLowerCase();
    if (!/^playlist\d+$/.test(id) || !hasClass(divMatch[1], 'tab-pane')) continue;
    const block = extractBalancedDiv(html, divMatch.index);
    const episodes = extractEpisodes(block, detailUrl);
    if (episodes.length > 0) {
      lines.push({ name: tabNames.get(id) || `线路${lines.length + 1}`, episodes });
    }
    divPattern.lastIndex = divMatch.index + block.length;
  }
  if (lines.length === 0) throw new Error('未在详情页中找到播放线路');
  return { title, url: detailUrl, lines };
}

module.exports = {
  id: 'zjlqzg',
  name: 'ZJLQZG',
  homepage: 'https://www.zjlqzg.com/',
  domain: 'www.zjlqzg.com',
  capabilities: { play: true, detail: true },
  status: 'supported',
  matches: url => /(^|\.)zjlqzg\.com$/i.test(new URL(url).hostname),
  parsePlay: common.parsePlayHtml,
  parseDetail,
};

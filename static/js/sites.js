import { api } from './api.js';
import { $ } from './state.js';

function capabilityText(capabilities = {}) {
  return [capabilities.play && '播放页', capabilities.detail && '详情页'].filter(Boolean).join('、') || '未标注';
}

export function renderSites(sites, query = $) {
  const list = query('#sitesList');
  list.replaceChildren();
  query('#siteCount').textContent = `${sites.length} 个站点`;
  for (const site of sites) {
    const item = document.createElement('article');
    item.className = 'site-item';
    const heading = document.createElement('h3');
    heading.textContent = site.name;
    const link = document.createElement('a');
    link.className = 'site-domain';
    link.href = site.homepage;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = site.domain;
    const capabilities = document.createElement('span');
    capabilities.className = 'site-capabilities';
    capabilities.textContent = `支持：${capabilityText(site.capabilities)}`;
    const status = document.createElement('span');
    status.className = 'badge done';
    status.textContent = site.status === 'supported' ? '已接入' : site.status;
    item.append(heading, link, capabilities, status);
    list.append(item);
  }
}

export async function initSites(options = {}) {
  const request = options.request || api;
  const query = options.query || $;
  try {
    const result = await request('/api/sites');
    renderSites(result.sites || [], query);
    query('#sitesMessage').textContent = '';
  } catch (error) {
    query('#sitesMessage').textContent = `站点列表加载失败：${error.message}`;
    query('#sitesMessage').style.color = '#dc2626';
  }
}

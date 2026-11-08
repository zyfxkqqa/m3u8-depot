const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sites = require('../lib/sites');
const zjlqzg = require('../lib/sites/zjlqzg');
const { createUrlPolicy } = require('../lib/url-policy');

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'static', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'static', 'style.css'), 'utf8');
  const playStart = html.indexOf('id="playPanel"');
  const detailStart = html.indexOf('id="detailPanel"');
  const tasksStart = html.indexOf('id="tasksPanel"');
  const sitesStart = html.indexOf('id="sitesPanel"');
  assert.ok(playStart >= 0 && detailStart > playStart && tasksStart > detailStart);

  const sitesPanel = html.slice(sitesStart, playStart);
  const playPanel = html.slice(playStart, detailStart);
  const detailPanel = html.slice(detailStart, tasksStart);
  const tasksPanel = html.slice(tasksStart);
  const getPlaceholder = (panel, id) => {
    const match = panel.match(new RegExp(`<(?:textarea|input)\\b[^>]*\\bid="${id}"[^>]*\\bplaceholder="([^"]*)"`));
    assert.ok(match, `${id} placeholder not found`);
    return match[1];
  };
  const playPlaceholder = getPlaceholder(playPanel, 'urlInput');
  const detailPlaceholder = getPlaceholder(detailPanel, 'detailUrlInput');
  assert.strictEqual(playPlaceholder, '每行输入一个播放页地址，例如：&#10;https://www.kxmp4.com/play/378302-6-2.html&#10;https://www.maliys.com/yun/64204-4-1.html&#10;https://www.zjlqzg.com/tianlangtv/193253-1-1.html');
  assert.strictEqual(detailPlaceholder, '请输入一个详情页地址，例如：&#10;https://www.kxmp4.com/detail/378301.html&#10;https://www.maliys.com/html/64204.html&#10;https://www.zjlqzg.com/tianlangyy/193253.html');
  assert.ok(playPanel.includes('<textarea id="urlInput" rows="7"'));
  assert.ok(detailPanel.includes('<textarea id="detailUrlInput" class="detail-url-input" rows="5"'));
  assert.ok(!html.includes('class="input-examples"'));
  assert.ok(!sitesPanel.includes('<h2>支持站点</h2>'));
  assert.ok(!tasksPanel.includes('<h2>下载任务</h2>'));
  assert.ok(playPanel.includes('<label for="urlInput">播放页地址</label>'));
  assert.ok(detailPanel.includes('<label for="detailUrlInput">详情页地址</label>'));
  assert.ok(sitesPanel.includes('id="siteCount"'));
  assert.ok(tasksPanel.includes('id="taskCount"'));

  const getCssRule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} CSS rule not found`);
    return match[1].replace(/\s+/g, '');
  };
  assert.ok(getCssRule('.detail-url-input').includes('min-height:116px'));
  assert.ok(getCssRule('.sites-head').includes('justify-content:flex-end'));
  assert.ok(getCssRule('.tasks-head').includes('justify-content:flex-end'));
  assert.ok(getCssRule('.sites-list').includes('grid-template-columns:minmax(0,1fr)'));

  const playUrl = 'https://www.zjlqzg.com/tianlangtv/193253-1-1.html';
  const m3u8Url = 'https://player.yzzyvip-35.com/20260709/10500_b4e62d56/index.m3u8';
  const playHtml = `
    <script>var vod_name = '百花杀'; var vod_part = '第01集';</script>
    <script>
      var player_aaaa = {
        "flag":"play",
        "encrypt":0,
        "url":"https:\\/\\/player.yzzyvip-35.com\\/20260709\\/10500_b4e62d56\\/index.m3u8",
        "vod_data":{"vod_name":"百花杀"},
        "nid":1
      };
    </script>`;
  const play = zjlqzg.parsePlay(playHtml, playUrl);
  assert.strictEqual(play.title, '百花杀 第01集');
  assert.strictEqual(play.m3u8Url, m3u8Url);

  const oldPlayer = sites.common.parsePlayerData('<script>const player_data = {"url":"https:\\/\\/cdn.example.com\\/old.m3u8"};</script>');
  assert.strictEqual(oldPlayer.url, 'https://cdn.example.com/old.m3u8');

  const prioritizedPlayer = sites.common.parsePlayerData(`
    <script>var player_config = {"theme":"dark"};</script>
    <script>var player_aaaa = {"url":"https://cdn.example.com/right.m3u8"};</script>`);
  assert.strictEqual(prioritizedPlayer.url, 'https://cdn.example.com/right.m3u8');

  const detailUrl = 'https://www.zjlqzg.com/tianlangyy/193253.html';
  const detailHtml = `
    <h1 class="title"><span>百花杀</span><small>其他文字</small></h1>
    <nav>
      <a href="#playlist1">阿里云播</a>
      <a href="#playlist4">神马云播</a>
      <a href="#playlist2">奇异云播</a>
      <a href="#playlist3">百度云播</a>
    </nav>
    <div id="playlist1" class="tab-pane active">
      <div class="nested"><ul class="ewave-content__playlist">
        <li><a href="/tianlangtv/193253-1-1.html">第01集</a></li>
        <li><a href="/tianlangtv/193253-1-2.html">第02集</a></li>
        <li><a href="/tianlangtv/193253-1-2.html">重复第02集</a></li>
        <li><a href="/tianlangtv/193253-1-99.html">番外</a></li>
        <li><a href="/play/8888-1-1/">1080P</a></li>
      </ul></div>
    </div>
    <div class="tab-pane" id="playlist4"><ul class="ewave-content__playlist"><li><a href="/tianlangtv/193253-4-1.html">第01集</a></li></ul></div>
    <div id="playlist2" class="tab-pane"><ul class="ewave-content__playlist"><li><a href="/tianlangtv/193253-2-1.html">第01集</a></li></ul></div>
    <div id="playlist3" class="tab-pane"><ul class="ewave-content__playlist"><li><a href="/tianlangtv/193253-3-1.html">第01集</a></li></ul></div>`;
  const detail = zjlqzg.parseDetail(detailHtml, detailUrl);
  assert.strictEqual(detail.title, '百花杀');
  assert.deepStrictEqual(detail.lines.map(line => line.name), ['阿里云播', '神马云播', '奇异云播', '百度云播']);
  assert.deepStrictEqual(detail.lines[0].episodes.map(episode => episode.name), ['第01集', '第02集', '番外']);
  assert.deepStrictEqual(detail.lines[0].episodes.map(episode => episode.url), [
    'https://www.zjlqzg.com/tianlangtv/193253-1-1.html',
    'https://www.zjlqzg.com/tianlangtv/193253-1-2.html',
    'https://www.zjlqzg.com/tianlangtv/193253-1-99.html',
  ]);
  assert.ok(detail.lines.flatMap(line => line.episodes).every(episode => !episode.url.includes('/play/8888')));

  assert.strictEqual(sites.getSiteAdapter(playUrl).id, 'zjlqzg');
  assert.deepStrictEqual(sites.getPublicSites().map(site => site.id), ['kxmp4', 'maliys', 'zjlqzg']);
  assert.strictEqual(sites.getPublicSites()[2].name, 'ZJLQZG');

  const validateUrl = createUrlPolicy({
    resolver: async hostname => [{ address: '1.1.1.1', family: 4, hostname }],
  });
  const validated = await validateUrl(playUrl);
  assert.strictEqual(validated.url.href, playUrl);
  assert.strictEqual(validated.addresses[0].address, '1.1.1.1');

  console.log('zjlqzg-smoke-ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

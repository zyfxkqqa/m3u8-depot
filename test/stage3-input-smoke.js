const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { Readable } = require('stream');

const { readBody, readJsonBody } = require('../lib/http/request-body');
const { parsePlayerData } = require('../lib/sites/common-maccms');

const MAX_BODY_BYTES = 1024 * 1024;

function requestFrom(chunks) {
  return Readable.from(chunks);
}

async function expectHttpError(run, statusCode, code) {
  await assert.rejects(run, error => error?.statusCode === statusCode && error?.code === code);
}

function requireConfig(overrides = {}) {
  const configPath = path.join(__dirname, '..', 'lib', 'config.js');
  const script = `const c=require(${JSON.stringify(configPath)});process.stdout.write(JSON.stringify([c.MAX_ACTIVE_TASKS,c.PARSE_CONCURRENCY]));`;
  const env = { ...process.env };
  delete env.M3U8_MAX_ACTIVE_TASKS;
  delete env.M3U8_PARSE_CONCURRENCY;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1000, env });
}

async function run() {
  const source = Buffer.from(JSON.stringify({ title: '中文标题' }));
  const splitAt = source.indexOf(Buffer.from('中')) + 1;
  assert.deepStrictEqual(
    await readJsonBody(requestFrom([source.subarray(0, splitAt), source.subarray(splitAt)])),
    { title: '中文标题' },
  );

  const exactLimit = Buffer.alloc(MAX_BODY_BYTES, 0x61);
  assert.strictEqual((await readBody(requestFrom([exactLimit]))).length, MAX_BODY_BYTES);
  await expectHttpError(() => readBody(requestFrom([exactLimit, Buffer.from('b')])), 413, 'BODY_TOO_LARGE');
  await expectHttpError(() => readJsonBody(requestFrom([Buffer.from('{bad json')])), 400, 'INVALID_JSON');

  const first = parsePlayerData(`<script>var player_data={"nested":{"text":"} and {"},"encrypt":0,"url":"https://cdn.test/a.m3u8"}</script>`);
  assert.strictEqual(first.nested.text, '} and {');
  const second = parsePlayerData(`<script>\nlet player_data =\n{"url":"https://cdn.test/b.m3u8","vod_data":{"vod_name":"B"},"encrypt":2};\n</script>`);
  assert.deepStrictEqual(second, { url: 'https://cdn.test/b.m3u8', vod_data: { vod_name: 'B' }, encrypt: 2 });
  const thirdPayload = JSON.stringify({ encrypt: 1, url: 'https://cdn.test/c.m3u8', meta: { quote: '"}"' } });
  const third = parsePlayerData(`<script>const player_data=${thirdPayload} ;</script>`);
  assert.strictEqual(third.meta.quote, '"}"');
  assert.strictEqual(parsePlayerData(`<script>var player_data={"url":"x";</script>`), null);

  let child = requireConfig();
  assert.strictEqual(child.status, 0, child.stderr);
  assert.deepStrictEqual(JSON.parse(child.stdout), [2, 4]);
  child = requireConfig({ M3U8_MAX_ACTIVE_TASKS: '8', M3U8_PARSE_CONCURRENCY: '16' });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.deepStrictEqual(JSON.parse(child.stdout), [8, 16]);

  for (const [name, value] of [
    ['M3U8_MAX_ACTIVE_TASKS', '0'],
    ['M3U8_MAX_ACTIVE_TASKS', '1.5'],
    ['M3U8_MAX_ACTIVE_TASKS', '33'],
    ['M3U8_PARSE_CONCURRENCY', 'NaN'],
    ['M3U8_PARSE_CONCURRENCY', '-1'],
    ['M3U8_PARSE_CONCURRENCY', '65'],
  ]) {
    child = requireConfig({ [name]: value });
    assert.notStrictEqual(child.status, 0, `${name}=${value} must fail during require`);
    assert.match(child.stderr, new RegExp(`Invalid ${name}`));
  }

  console.log('stage3-input-smoke-ok');
}

let timer;
Promise.race([
  run(),
  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stage3 input smoke timed out')), 7000); }),
]).then(() => clearTimeout(timer), error => {
  clearTimeout(timer);
  console.error(error.stack || error);
  process.exitCode = 1;
});

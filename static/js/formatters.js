export function statusText(status) {
  return {
    parsed: '待开始', queued: '排队中', running: '下载中', retrying: '等待重试',
    committing: '正在提交', deleting: '正在删除', done: '完成', failed: '失败', parse_failed: '解析失败',
  }[status] || status;
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 2 : 0)} ${units[index]}`;
}

export function formatFfmpegTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!match) return value;
  const [, hours, minutes, seconds] = match;
  return hours === '00' ? `${minutes}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

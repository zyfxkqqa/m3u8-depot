export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if ((options.method || 'GET').toUpperCase() === 'POST') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-M3U8-Local-Request', '1');
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

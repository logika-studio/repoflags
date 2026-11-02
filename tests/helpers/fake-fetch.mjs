// Injectable fake fetch for tests: no real network, every call is logged.

/**
 * @param {Record<string, {status?: number, json?: any, text?: string, headers?: Record<string,string>, throws?: string}>} routes
 *   key = "<METHOD> <url>"
 * @param {Array<{key: string, host: string, auth: string|null}>} log
 */
export function makeFakeFetch(routes, log = []) {
  const fn = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${String(url)}`;
    const headers = new Headers(init.headers ?? {});
    log.push({ key, host: new URL(String(url)).host, auth: headers.get('authorization') });
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    if (route.throws) throw new Error(route.throws);
    const status = route.status ?? 200;
    // 204 and 304 are null body statuses: new Response('') would throw (review tests IN-07).
    const body = status === 204 || status === 304 ? null : route.json !== undefined ? JSON.stringify(route.json) : (route.text ?? '');
    return new Response(body, { status, headers: route.headers ?? {} });
  };
  fn.log = log;
  return fn;
}

/** Fetch that records and always throws: proves that offline mode never touches the network. */
export function makeForbiddenFetch(log = []) {
  const fn = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${String(url)}`;
    log.push({ key, host: null, auth: null });
    throw new Error(`network forbidden in this test: ${key}`);
  };
  fn.log = log;
  return fn;
}

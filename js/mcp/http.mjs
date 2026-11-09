// The xsolana MCP server over HTTP (MCP's Streamable HTTP transport), for a hosted endpoint that chat apps add by URL
// (claude.ai, ChatGPT, Claude Desktop), where a local stdio server can't run. It speaks Request and Response, so a
// Next.js route handler, a Worker or `xsolana mcp --http` all serve it the same way.
//
// It is the stdio server's own handler (server.mjs `handle`) in remote mode: only the tools in REMOTE_TOOLS, every spec
// passed whole as an argument, no file read or written, nothing signed. Each request stands alone (no session), and
// every answer is one JSON body: no event stream, so GET is refused as the transport allows.
import { createServer } from 'node:http';
import { handle } from './server.mjs';

/** The largest request body read: a spec is a few kilobytes; a megabyte is far more than any. */
export const MAX_BODY_BYTES = 1_000_000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
const empty = (status, headers = {}) => new Response(null, { status, headers: { ...CORS, ...headers } });
const rpcError = (code, message, status = 400) => json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);

/** The body as text, or null once it is longer than `limit` bytes. */
async function bodyText(request, limit) {
  const said = Number(request.headers.get('content-length'));
  if (said > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * One HTTP request to the MCP endpoint, answered. `allowOrigin(origin)` decides which browser origins may call it (a
 * request with no Origin header, from a server or a desktop app, always may); by default every origin, since the
 * endpoint holds no session, no cookie and nothing private.
 * @param {Request} request
 * @param {{ allowOrigin?: (origin: string) => boolean, maxBodyBytes?: number, ctx?: object }} [options]
 * @returns {Promise<Response>}
 */
export async function mcpHttp(request, { allowOrigin = () => true, maxBodyBytes = MAX_BODY_BYTES, ctx = {} } = {}) {
  const origin = request.headers.get('origin');
  if (origin && !allowOrigin(origin)) return rpcError(-32000, 'This origin may not call this server.', 403);
  if (request.method === 'OPTIONS') return empty(204);
  if (request.method !== 'POST') return empty(405, { allow: 'POST, OPTIONS' });
  const text = await bodyText(request, maxBodyBytes);
  if (text === null) return rpcError(-32600, `The request is larger than ${maxBodyBytes} bytes.`, 413);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(-32700, 'Not JSON.');
  }
  const answer = m =>
    handle(m, { ...ctx, remote: true }).catch(e => ({
      jsonrpc: '2.0',
      id: m?.id ?? null,
      error: { code: -32603, message: e.message },
    }));
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map(answer))).filter(Boolean);
    return replies.length ? json(replies) : empty(202);
  }
  const reply = await answer(message);
  // A notification or a client's response gets no body.
  return reply ? json(reply) : empty(202);
}

/**
 * Serves mcpHttp at `path` on this machine (`xsolana mcp --http`). It listens on 127.0.0.1 unless told otherwise, and
 * then answers only pages on localhost: a site in the browser can't reach it by renaming its host (DNS rebinding).
 * @returns {Promise<import('node:http').Server>}
 */
export function serveHttp({ port = 8787, host = '127.0.0.1', path = '/mcp' } = {}) {
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const allowOrigin = origin => {
    if (!local) return true;
    try {
      return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`The MCP endpoint is ${path}.`);
        return;
      }
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(one => [k, one]),
        ),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      const response = await mcpHttp(request, { allowOrigin });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(e.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.error(`xsolana MCP server over HTTP: http://${host}:${server.address().port}${path}`);
      resolve(server);
    });
  });
}

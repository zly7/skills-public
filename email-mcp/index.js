import 'dotenv/config';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { createAuth, json, readBody } from './auth.js';
import { createMailServer } from './mail.js';

export function createApp(config, { mailFactory = createMailServer } = {}) {
  const auth = createAuth(config);
  const hosts = new Set([new URL(config.publicBase).host, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
  let activeMcp = 0;
  const server = createServer(async (req, res) => {
    try {
      if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'invalid_host' });
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) return json(res, 403, { error: 'invalid_origin' });
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
      }
      if (!auth.rate('all', 600, 60)) return json(res, 429, { error: 'try_later' }, { 'retry-after': '60' });
      if (!req.url || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: 'invalid_url' });
      const url = new URL(req.url, config.publicBase);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { name: 'email-mcp', version: '0.1.0', mode: 'single-owner', transport: 'streamable-http' });
      if (await auth.handle(req, res, url)) return;
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not_found' });
      const record = auth.bearer(req);
      if (!record) return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${config.metadataUrl}", scope="mail.read"` });
      // Stateless JSON responses. No long-lived GET event stream or DELETE session is offered.
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'unsupported_media_type' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid_json_or_body_too_large' }); }
      if (activeMcp >= 4) return json(res, 429, { error: 'server_busy' });
      activeMcp++;
      const mcp = mailFactory(config, record);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let closed = false;
      const cleanup = () => {
        if (closed) return; closed = true; activeMcp--;
        transport.close().catch(() => {}); mcp.close().catch(() => {});
      };
      res.once('close', cleanup);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) { cleanup(); throw error; }
    } catch {
      // Do not log provider errors, tokens, request URLs/bodies, addresses or mailbox content.
      console.error('Email MCP request failed');
      if (!res.headersSent) json(res, 500, { error: 'internal_server_error' });
      else res.end();
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.timeout = 120000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const server = createApp(config);
  server.listen(config.port, config.host, () => console.log(`Email MCP listening on loopback port ${config.port}; HTTPS proxy required`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

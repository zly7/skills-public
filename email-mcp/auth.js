import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
export async function readBody(req, max = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function form(req, body) {
  if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw new Error('Expected form encoding');
  const p = new URLSearchParams(body);
  for (const k of p.keys()) if (p.getAll(k).length !== 1) throw new Error('Duplicate parameter');
  return Object.fromEntries(p);
}

export function createAuth(config) {
  const file = join(config.dataDir, 'oauth-state.json');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  let state = { version: 1, binding: config.binding, clients: {}, access: {}, refresh: {} };
  if (existsSync(file)) {
    state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.version !== 1 || state.binding !== config.binding || !state.clients || !state.access || !state.refresh) {
      throw new Error('OAuth state does not match this configuration. Stop, revoke old grants and move the old state aside before changing owner/mailbox/issuer/scopes.');
    }
    chmodSync(file, 0o600);
  }
  const save = () => {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temp, 0o600); renameSync(temp, file); chmodSync(file, 0o600);
  };
  const pending = new Map(); const codes = new Map(); const limits = new Map();
  const now = () => Math.floor(Date.now() / 1000);
  function prune() {
    const t = now();
    for (const table of [state.access, state.refresh]) {
      for (const [key, item] of Object.entries(table)) if (item.exp <= t) delete table[key];
    }
    for (const table of [pending, codes]) for (const [key, item] of table) if (item.exp <= t) table.delete(key);
  }
  function recycleUnapprovedClients() {
    const inUse = new Set([
      ...Object.values(state.access), ...Object.values(state.refresh), ...pending.values(), ...codes.values(),
    ].map(item => item.clientId));
    const unused = Object.entries(state.clients).filter(([id]) => !inUse.has(id)).sort((a, b) => a[1].created - b[1].created);
    for (const [id, item] of unused) {
      if (item.created + 3600 <= now() || Object.keys(state.clients).length >= 64) delete state.clients[id];
    }
    // Persist reclamation too: unauthenticated DCR cannot permanently fill the registry.
    save();
  }
  function rate(key, count, seconds) {
    const t = now(); let item = limits.get(key);
    if (!item || item.until <= t) { item = { count: 0, until: t + seconds }; limits.set(key, item); }
    return ++item.count <= count;
  }
  function scopes(raw, fallback = ['mail.read']) {
    const out = raw ? [...new Set(raw.split(/\s+/).filter(Boolean))] : fallback;
    if (!out.length || out.some(s => !config.scopes.includes(s))) throw new Error('invalid_scope');
    return out;
  }
  function revokeFamily(family) {
    for (const table of [state.access, state.refresh]) {
      for (const [key, item] of Object.entries(table)) if (item.family === family) delete table[key];
    }
  }
  function issue(record, family = random(), familyExp = now() + REFRESH_TTL) {
    if (Object.keys(state.refresh).length >= 5000) throw new Error('Token capacity reached');
    const access = random(); const refresh = random();
    const base = { clientId: record.clientId, scopes: record.scopes, resource: config.resource, family, familyExp };
    state.access[hash(access)] = { ...base, exp: now() + ACCESS_TTL };
    state.refresh[hash(refresh)] = { ...base, exp: familyExp, used: false };
    save();
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL, scope: record.scopes.join(' ') };
  }
  function bearer(req) {
    prune();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    const item = match && own(state.access, hash(match[1]));
    return item && item.exp > now() && item.resource === config.resource ? item : null;
  }
  function page(res, status, record, requestId, nonce, error = '') {
    const callbackOrigin = new URL(record.redirectUri).origin;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'` });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email MCP 授权</title><style>body{font-family:system-ui;max-width:36rem;margin:4rem auto;padding:1rem;line-height:1.6}input,button{padding:.7rem;margin:.5rem 0;box-sizing:border-box;width:100%}code{overflow-wrap:anywhere}</style><h1>授权此客户端访问你的邮箱</h1><p>这是你自行部署的单邮箱实例。仅授权你信任的客户端。</p><p>客户端：${escape(record.clientName)}<br>回调：<code>${escape(record.redirectUri)}</code></p><p>本次权限：${escape(record.scopes.join(', '))}</p><p>${escape(error)}</p><form method="post" action="${config.publicBase}/authorize"><input type="hidden" name="request_id" value="${requestId}"><input type="hidden" name="csrf" value="${nonce}"><label for="owner">实例的独立 OWNER_PASSWORD（不是 QQ 密码或邮箱授权码）</label><input id="owner" type="password" name="owner_password" required autocomplete="current-password"><button type="submit">同意并连接</button></form></html>`);
  }
  function redirect(res, record, values) {
    const url = new URL(record.redirectUri);
    for (const [key, value] of Object.entries({ ...values, state: record.state, iss: config.publicBase })) if (value) url.searchParams.set(key, value);
    res.writeHead(303, { location: url.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
  }
  async function handle(req, res, url) {
    prune();
    const path = url.pathname;
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, 200, { issuer: config.publicBase, authorization_endpoint: `${config.publicBase}/authorize`,
        token_endpoint: `${config.publicBase}/token`, registration_endpoint: `${config.publicBase}/register`,
        revocation_endpoint: `${config.publicBase}/revoke`, response_types_supported: ['code'], response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], scopes_supported: config.scopes, authorization_response_iss_parameter_supported: true }); return true;
    }
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
      json(res, 200, { resource: config.resource, authorization_servers: [config.publicBase], scopes_supported: config.scopes, bearer_methods_supported: ['header'] }); return true;
    }
    if (req.method === 'POST' && path === '/register') {
      if (!rate('register', 20, 60)) { json(res, 429, { error: 'registration_limit' }); return true; }
      recycleUnapprovedClients();
      if (Object.keys(state.clients).length >= 64) { json(res, 429, { error: 'registration_limit' }); return true; }
      let p;
      try {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error();
        p = JSON.parse(await readBody(req));
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error();
      } catch { json(res, 400, { error: 'invalid_client_metadata' }); return true; }
      if (!Array.isArray(p.redirect_uris) || !p.redirect_uris.length || p.redirect_uris.length > 16
        || p.redirect_uris.some(uri => !config.redirectUris.includes(uri))) {
        json(res, 400, { error: 'invalid_redirect_uri' }); return true;
      }
      if ((p.token_endpoint_auth_method && p.token_endpoint_auth_method !== 'none')
        || (p.grant_types && (!Array.isArray(p.grant_types) || p.grant_types.some(t => !['authorization_code', 'refresh_token'].includes(t))))
        || (p.response_types && (!Array.isArray(p.response_types) || p.response_types.some(t => t !== 'code')))
        || (p.client_name !== undefined && (typeof p.client_name !== 'string' || p.client_name.length > 120))) {
        json(res, 400, { error: 'invalid_client_metadata' }); return true;
      }
      const id = random(); const created = now();
      state.clients[id] = { clientName: p.client_name || 'MCP Client', redirectUris: [...new Set(p.redirect_uris)], created };
      save();
      json(res, 201, { client_id: id, client_id_issued_at: created, client_name: state.clients[id].clientName,
        redirect_uris: state.clients[id].redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }); return true;
    }
    if (req.method === 'GET' && path === '/authorize') {
      if (!rate('authorize', 60, 60) || pending.size >= 128) { json(res, 429, { error: 'authorization_limit' }); return true; }
      const p = Object.fromEntries(url.searchParams);
      if ([...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) { json(res, 400, { error: 'invalid_request' }); return true; }
      const client = own(state.clients, p.client_id);
      if (!client || !client.redirectUris.includes(p.redirect_uri) || !config.redirectUris.includes(p.redirect_uri)) {
        json(res, 400, { error: 'invalid_request' }); return true;
      }
      const record = { clientId: p.client_id, clientName: client.clientName, redirectUri: p.redirect_uri, state: p.state || '' };
      if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || '') || record.state.length > 2048) {
        redirect(res, record, { error: 'invalid_request' }); return true;
      }
      if (p.resource !== config.resource) { redirect(res, record, { error: 'invalid_target' }); return true; }
      try { record.scopes = scopes(p.scope); } catch { redirect(res, record, { error: 'invalid_scope' }); return true; }
      const requestId = random(); const nonce = random();
      Object.assign(record, { codeChallenge: p.code_challenge, exp: now() + 600, nonce: hash(nonce) });
      pending.set(hash(requestId), record); page(res, 200, record, requestId, nonce); return true;
    }
    if (req.method === 'POST' && path === '/authorize') {
      // Browser POST must originate at this issuer; proxy headers are not trusted as authorization.
      if (req.headers.origin !== config.publicBase) { json(res, 403, { error: 'invalid_origin' }); return true; }
      if (!rate('owner-password', 10, 300)) { json(res, 429, { error: 'try_later' }); return true; }
      let p;
      try { p = form(req, await readBody(req)); } catch { json(res, 400, { error: 'invalid_request' }); return true; }
      const key = hash(p.request_id || ''); const record = pending.get(key);
      if (!record || record.exp <= now() || !equal(hash(p.csrf || ''), record.nonce)) { json(res, 400, { error: 'invalid_request' }); return true; }
      if (!equal(p.owner_password || '', config.ownerPassword)) {
        const nonce = random(); record.nonce = hash(nonce); page(res, 401, record, p.request_id, nonce, '口令不正确。'); return true;
      }
      pending.delete(key);
      if (codes.size >= 128) { json(res, 429, { error: 'authorization_limit' }); return true; }
      const code = random(); codes.set(hash(code), { ...record, exp: now() + 300 });
      redirect(res, record, { code }); return true;
    }
    if (req.method === 'POST' && ['/token', '/revoke'].includes(path)) {
      if (!rate('tokens', 240, 60)) { json(res, 429, { error: 'try_later' }); return true; }
      let p;
      try { p = form(req, await readBody(req)); } catch { json(res, 400, { error: 'invalid_request' }); return true; }
      if (!own(state.clients, p.client_id)) { json(res, 401, { error: 'invalid_client' }); return true; }
      if (path === '/revoke') {
        const key = hash(p.token || ''); const record = own(state.refresh, key) || own(state.access, key);
        if (record?.clientId === p.client_id) { revokeFamily(record.family); save(); }
        json(res, 200, {}); return true;
      }
      if (p.resource !== config.resource) { json(res, 400, { error: 'invalid_target' }); return true; }
      if (p.grant_type === 'authorization_code') {
        const key = hash(p.code || ''); const record = codes.get(key);
        if (!record || record.exp <= now() || record.clientId !== p.client_id || record.redirectUri !== p.redirect_uri
          || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') || !equal(hash(p.code_verifier), record.codeChallenge)) {
          json(res, 400, { error: 'invalid_grant' }); return true;
        }
        codes.delete(key); json(res, 200, issue(record)); return true;
      }
      if (p.grant_type === 'refresh_token') {
        const key = hash(p.refresh_token || ''); const record = own(state.refresh, key);
        if (!record || record.exp <= now() || record.clientId !== p.client_id || record.resource !== p.resource) {
          json(res, 400, { error: 'invalid_grant' }); return true;
        }
        if (record.used) { revokeFamily(record.family); save(); json(res, 400, { error: 'invalid_grant' }); return true; }
        let requested;
        try {
          requested = scopes(p.scope, record.scopes);
          if (requested.some(s => !record.scopes.includes(s))) throw new Error();
        } catch { json(res, 400, { error: 'invalid_scope' }); return true; }
        // Keep the used hash until family expiry, so a replay revokes the replacement tokens too.
        record.used = true;
        json(res, 200, issue({ ...record, scopes: requested }, record.family, record.familyExp)); return true;
      }
      json(res, 400, { error: 'unsupported_grant_type' }); return true;
    }
    return false;
  }
  return { handle, bearer, rate };
}

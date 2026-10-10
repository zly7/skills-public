import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { loadConfig } from '../config.js';
import { createApp } from '../index.js';
import { createMailServer } from '../mail.js';
import { hash } from '../auth.js';

function env(dir, extra = {}) {
  return { PUBLIC_BASE_URL: 'https://mail-mcp.example.com', EMAIL_ADDRESS: 'synthetic-test@qq.com',
    EMAIL_AUTH_CODE: randomBytes(12).toString('hex'), OWNER_PASSWORD: randomBytes(32).toString('hex'),
    ALLOWED_REDIRECT_URIS: 'https://client.example.com/callback', DATA_DIR: dir, ...extra };
}
async function harness(t, extra = {}, dependencies) {
  const dir = mkdtempSync(join(tmpdir(), 'email-mcp-test-'));
  const config = loadConfig(env(dir, extra));
  let server;
  async function start() {
    server = createApp(config, dependencies ? { mailFactory: (c, r) => createMailServer(c, r, dependencies) } : {});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  await start();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { host: 'mail-mcp.example.com', ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let data; try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: response.statusCode, headers: { get: key => response.headers[key] }, data, text });
        });
      });
      req.on('error', reject); if (body) req.write(String(body)); req.end();
    });
  }

  const form = (path, body, headers = {}) => request(path, { method: 'POST', body: new URLSearchParams(body), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  async function register(overrides = {}) {
    return request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: config.redirectUris, client_name: 'Synthetic test client', ...overrides }) });
  }
  async function authorize(clientId, scope = 'mail.read', overrides = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const response = await request('/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: config.redirectUris[0],
      response_type: 'code', code_challenge: hash(verifier), code_challenge_method: 'S256', resource: config.resource, scope,
      state: 'test-state', ...overrides }));
    const requestId = /name="request_id" value="([^"]+)"/.exec(response.text)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(response.text)?.[1];
    return { response, verifier, requestId, csrf };
  }
  async function grant(scope = 'mail.read') {
    const r = await register(); assert.equal(r.status, 201);
    const clientId = r.data.client_id;
    const a = await authorize(clientId, scope); assert.equal(a.response.status, 200);
    const approved = await form('/authorize', { request_id: a.requestId, csrf: a.csrf, owner_password: config.ownerPassword }, { origin: config.publicBase });
    assert.equal(approved.status, 303);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const exchange = { client_id: clientId, resource: config.resource, grant_type: 'authorization_code', redirect_uri: config.redirectUris[0], code, code_verifier: a.verifier };
    const tokens = await form('/token', exchange); assert.equal(tokens.status, 200);
    return { clientId, tokens: tokens.data, exchange };
  }
  const mcp = (access, method, params = {}) => request('/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}`, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { dir, config, request, form, register, authorize, grant, mcp,
    restart: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await start(); } };
}

test('configuration fails closed and defaults to read-only', () => {
  const good = env('/tmp/synthetic-email-config');
  assert.deepEqual(loadConfig(good).scopes, ['mail.read']);
  for (const change of [ { PUBLIC_BASE_URL: 'http://mail-mcp.example.com' }, { PUBLIC_BASE_URL: 'https://mail-mcp.example.com/subpath' },
    { ALLOWED_REDIRECT_URIS: 'http://localhost/callback' }, { ALLOWED_REDIRECT_URIS: 'https://client.example.com/*' },
    { OWNER_PASSWORD: 'short' }, { EMAIL_AUTH_CODE: 'REPLACE_WITH_A_SECRET' }, { HOST: '0.0.0.0' }, { ENABLE_WRITE_TOOLS: 'yes' }, { EMAIL_ADDRESS: 'owner@example.com' } ]) {
    assert.throws(() => loadConfig({ ...good, ...change }));
  }
});

test('discovery, unauthenticated requests, host/origin restrictions', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/.well-known/oauth-authorization-server')).data.issuer, h.config.publicBase);
  assert.equal((await h.request('/.well-known/oauth-protected-resource/mcp')).data.resource, h.config.resource);
  const unauthorized = await h.request('/mcp');
  assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata/);
  assert.equal((await h.request('/', { headers: { host: 'attacker.example.com' } })).status, 403);
  assert.equal((await h.request('/', { headers: { origin: 'https://attacker.example.com' } })).status, 403);
});

test('DCR only accepts exact allowlisted redirects and public client metadata', async t => {
  const h = await harness(t);
  for (const uri of ['https://attacker.example.com/callback', 'https://client.example.com/callback/', 'https://client.example.com/callback#fragment', 'http://client.example.com/callback']) {
    assert.equal((await h.register({ redirect_uris: [uri] })).status, 400);
  }
  assert.equal((await h.register({ token_endpoint_auth_method: 'client_secret_post' })).status, 400);
  assert.equal((await h.register({ client_name: { bad: true } })).status, 400);
});

test('authorization requires PKCE/resource/scope, owner password, CSRF and issuer Origin', async t => {
  const h = await harness(t); const clientId = (await h.register()).data.client_id;
  for (const change of [{ resource: 'https://other.example.com/mcp' }, { code_challenge_method: 'plain' }, { code_challenge: 'bad' }, { scope: 'mail.send' }]) {
    const a = await h.authorize(clientId, 'mail.read', change);
    assert.equal(a.response.status, 303); assert.ok(new URL(a.response.headers.get('location')).searchParams.has('error'));
  }
  const a = await h.authorize(clientId);
  const data = { request_id: a.requestId, csrf: a.csrf, owner_password: h.config.ownerPassword };
  assert.equal((await h.form('/authorize', data)).status, 403);
  assert.equal((await h.form('/authorize', { ...data, csrf: 'wrong' }, { origin: h.config.publicBase })).status, 400);
  const wrong = await h.form('/authorize', { ...data, owner_password: 'wrong' }, { origin: h.config.publicBase });
  assert.equal(wrong.status, 401);
});

test('code is one-use and bound to client, redirect, verifier and resource', async t => {
  const h = await harness(t); const r = await h.register(); const clientId = r.data.client_id;
  const other = (await h.register()).data.client_id; const a = await h.authorize(clientId);
  const approval = await h.form('/authorize', { request_id: a.requestId, csrf: a.csrf, owner_password: h.config.ownerPassword }, { origin: h.config.publicBase });
  const callback = new URL(approval.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'test-state');
  const good = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: h.config.redirectUris[0], code: callback.searchParams.get('code'), code_verifier: a.verifier, resource: h.config.resource };
  for (const change of [{ client_id: other }, { redirect_uri: 'https://client.example.com/wrong' }, { code_verifier: 'x'.repeat(43) }, { resource: 'https://other.example.com/mcp' }]) assert.equal((await h.form('/token', { ...good, ...change })).status, 400);
  assert.equal((await h.form('/token', good)).status, 200); assert.equal((await h.form('/token', good)).status, 400);
  assert.equal((await h.form('/authorize', { request_id: a.requestId, csrf: a.csrf, owner_password: h.config.ownerPassword }, { origin: h.config.publicBase })).status, 400);
});

test('refresh narrows scopes, rejects cross-client use, rotates and revokes family on replay', async t => {
  const h = await harness(t, { ENABLE_WRITE_TOOLS: 'true' }); const g = await h.grant('mail.read mail.send');
  const other = (await h.register()).data.client_id;
  const req = { grant_type: 'refresh_token', client_id: g.clientId, resource: h.config.resource, refresh_token: g.tokens.refresh_token };
  assert.equal((await h.form('/token', { ...req, client_id: other })).status, 400);
  assert.equal((await h.form('/token', { ...req, scope: 'mail.delete' })).status, 400);
  const rotated = await h.form('/token', { ...req, scope: 'mail.read' }); assert.equal(rotated.status, 200); assert.equal(rotated.data.scope, 'mail.read');
  assert.equal((await h.mcp(rotated.data.access_token, 'tools/list')).status, 200);
  assert.equal((await h.form('/token', req)).status, 400);
  assert.equal((await h.mcp(rotated.data.access_token, 'tools/list')).status, 401);
  assert.equal((await h.mcp(g.tokens.access_token, 'tools/list')).status, 401);
});

test('state persists hashes, restart preserves tokens, and revocation requires matching client', async t => {
  const h = await harness(t); const g = await h.grant();
  const file = join(h.dir, 'oauth-state.json'); const raw = readFileSync(file, 'utf8');
  for (const secret of [g.tokens.access_token, g.tokens.refresh_token, h.config.email, h.config.authCode, h.config.ownerPassword]) assert.ok(!raw.includes(secret));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await h.restart(); assert.equal((await h.mcp(g.tokens.access_token, 'tools/list')).status, 200);
  const other = (await h.register()).data.client_id;
  await h.form('/revoke', { token: g.tokens.access_token, client_id: other });
  assert.equal((await h.mcp(g.tokens.access_token, 'tools/list')).status, 200);
  await h.form('/revoke', { token: g.tokens.access_token, client_id: g.clientId });
  assert.equal((await h.mcp(g.tokens.access_token, 'tools/list')).status, 401);
  assert.throws(() => createApp({ ...h.config, binding: 'different-owner' }), /does not match/);
});

test('MCP initialize/profile/tools work; read-only tokens do not expose or invoke writes', async t => {
  const h = await harness(t); const g = await h.grant();
  const init = await h.mcp(g.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200); assert.equal(init.data.result.serverInfo.name, 'email-mcp');
  const list = await h.mcp(g.tokens.access_token, 'tools/list');
  assert.equal(list.data.result.tools.length, 6); assert.ok(list.data.result.tools.every(x => x.annotations.readOnlyHint));
  const profile = await h.mcp(g.tokens.access_token, 'tools/call', { name: 'qq_profile', arguments: {} });
  assert.equal(profile.data.result.structuredContent.email, h.config.email);
  const send = await h.mcp(g.tokens.access_token, 'tools/call', { name: 'qq_send_email', arguments: { to: ['owner@example.com'], subject: 'test', confirmSend: true } });
  assert.equal(send.data.result.isError, true);
});

test('runtime input validation blocks file/URL injection and invalid UIDs before provider access', async t => {
  let touched = 0;
  const h = await harness(t, { ENABLE_WRITE_TOOLS: 'true', ENABLE_DELETE_TOOL: 'true' }, { imapFactory: () => { touched++; throw new Error('No real IMAP'); }, smtpFactory: () => { touched++; throw new Error('No real SMTP'); } });
  const g = await h.grant('mail.read mail.send mail.modify mail.delete');
  const cases = [
    ['qq_send_email', { to: ['owner@example.com'], subject: 'test', html: { path: '/etc/passwd' }, confirmSend: true }],
    ['qq_send_email', { to: ['owner@example.com'], subject: 'test', text: { href: 'https://attacker.example.com' }, confirmSend: true }],
    ['qq_delete_email', { uid: -1, confirmDelete: true }], ['qq_delete_email', { uid: '1', confirmDelete: true }],
    ['qq_move_email', { uid: 1.5, destination: 'Trash', confirmMove: true }], ['qq_set_flags', { uid: 0, seen: true }],
    ['qq_send_email', { to: ['owner@example.com\r\nBcc: injected@example.com'], subject: 'test', confirmSend: true }],
    ['qq_get_email', { uid: 1, account: 'another-owner' }], ['qq_search_emails', { since: '2026-02-31' }],
  ];
  for (const [name, args] of cases) {
    const result = await h.mcp(g.tokens.access_token, 'tools/call', { name, arguments: args });
    assert.equal(result.data.result.isError, true, name);
  }
  assert.equal(touched, 0);
});

test('oversized source is rejected before downloading source; IMAP lock and logout cleaned', async t => {
  let sourceFetched = false; let released = 0; let loggedOut = 0;
  const client = { connect: async () => {}, getMailboxLock: async () => ({ release: () => released++ }), logout: async () => loggedOut++,
    fetchOne: async (_uid, query) => { if (query.source) sourceFetched = true; return { uid: 1, size: 20 * 1024 * 1024 }; } };
  const h = await harness(t, {}, { imapFactory: () => client }); const g = await h.grant();
  const result = await h.mcp(g.tokens.access_token, 'tools/call', { name: 'qq_get_email', arguments: { uid: 1 } });
  assert.equal(result.data.result.isError, true); assert.equal(sourceFetched, false); assert.equal(released, 1); assert.equal(loggedOut, 1);
});

test('IMAP mutations require safe capabilities and do not report upstream false as success', async t => {
  let mutations = 0;
  const client = { capabilities: new Map(), connect: async () => {}, logout: async () => {}, getMailboxLock: async () => ({ release() {} }),
    messageDelete: async () => { mutations++; return false; }, messageMove: async () => { mutations++; return false; },
    messageFlagsAdd: async () => { mutations++; return false; }, messageFlagsRemove: async () => { mutations++; return false; } };
  const h = await harness(t, { ENABLE_WRITE_TOOLS: 'true', ENABLE_DELETE_TOOL: 'true' }, { imapFactory: () => client });
  const g = await h.grant('mail.read mail.modify mail.delete');
  for (const [name, args] of [['qq_delete_email', { uid: 1, confirmDelete: true }], ['qq_move_email', { uid: 1, destination: 'Trash', confirmMove: true }], ['qq_move_to_spam', { uid: 1, spamFolder: 'Junk', confirmMove: true }]]) {
    const r = await h.mcp(g.tokens.access_token, 'tools/call', { name, arguments: args }); assert.equal(r.data.result.isError, true);
  }
  assert.equal(mutations, 0);
  client.capabilities.set('UIDPLUS', true);
  for (const [name, args] of [['qq_delete_email', { uid: 1, confirmDelete: true }], ['qq_move_email', { uid: 1, destination: 'Trash', confirmMove: true }], ['qq_set_flags', { uid: 1, seen: true }]]) {
    const r = await h.mcp(g.tokens.access_token, 'tools/call', { name, arguments: args }); assert.equal(r.data.result.isError, true);
  }
  assert.equal(mutations, 3);
});

test('source fetch itself is bounded, and ordinary SMTP send uses fixed owner and safety flags', async t => {
  let sourceQuery; let sent;
  const source = Buffer.from('From: sender@example.com\r\nTo: owner@example.com\r\nSubject: synthetic\r\n\r\nTest body');
  const client = { connect: async () => {}, logout: async () => {}, getMailboxLock: async () => ({ release() {} }),
    fetchOne: async (_uid, query) => { if (query.source) { sourceQuery = query.source; return { uid: 1, source }; } return { uid: 1, size: source.length }; } };
  const h = await harness(t, { ENABLE_WRITE_TOOLS: 'true' }, { imapFactory: () => client, smtpFactory: () => ({ sendMail: async message => { sent = message; return { messageId: 'synthetic', accepted: ['owner@example.com'], rejected: [] }; } }) });
  const g = await h.grant('mail.read mail.send');
  const read = await h.mcp(g.tokens.access_token, 'tools/call', { name: 'qq_get_email', arguments: { uid: 1 } }); assert.ok(!read.data.result.isError);
  assert.deepEqual(sourceQuery, { start: 0, maxLength: 12 * 1024 * 1024 + 1 });
  const send = await h.mcp(g.tokens.access_token, 'tools/call', { name: 'qq_send_email', arguments: { to: ['owner@example.com'], subject: 'test', text: 'test', confirmSend: true } });
  assert.ok(!send.data.result.isError); assert.equal(sent.from, h.config.email); assert.equal(sent.disableFileAccess, true); assert.equal(sent.disableUrlAccess, true);
});

test('registration churn cannot permanently fill the registry or evict active grants', async t => {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const h = await harness(t); const g = await h.grant();
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 0) time += 61000;
    const r = await h.register({ client_name: `Synthetic client ${i}` }); assert.equal(r.status, 201);
  }
  const state = JSON.parse(readFileSync(join(h.dir, 'oauth-state.json'), 'utf8'));
  assert.ok(Object.keys(state.clients).length <= 64); assert.ok(state.clients[g.clientId]);
  assert.equal((await h.mcp(g.tokens.access_token, 'tools/list')).status, 200);
});

test('expired authorization transactions/codes and duplicate request fields fail closed', async t => {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const h = await harness(t); const clientId = (await h.register()).data.client_id;
  const a = await h.authorize(clientId);
  time += 601000;
  assert.equal((await h.form('/authorize', { request_id: a.requestId, csrf: a.csrf, owner_password: h.config.ownerPassword }, { origin: h.config.publicBase })).status, 400);
  const b = await h.authorize(clientId);
  const approved = await h.form('/authorize', { request_id: b.requestId, csrf: b.csrf, owner_password: h.config.ownerPassword }, { origin: h.config.publicBase });
  time += 301000;
  assert.equal((await h.form('/token', { client_id: clientId, resource: h.config.resource, redirect_uri: h.config.redirectUris[0], grant_type: 'authorization_code', code: new URL(approved.headers.get('location')).searchParams.get('code'), code_verifier: b.verifier })).status, 400);
  assert.equal((await h.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=a&client_id=b' })).status, 400);
});

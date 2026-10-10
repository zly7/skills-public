import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

function httpsUrl(raw, label, originOnly = false) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (originOnly && (url.pathname !== '/' || url.search))) {
    throw new Error(`${label} must be HTTPS without credentials, fragments${originOnly ? ', a path or a query' : ''}`);
  }
  return originOnly ? url.origin : url.href;
}

export function loadConfig(env = process.env) {
  const publicBase = httpsUrl(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', true);
  const email = String(env.EMAIL_ADDRESS || '').trim().toLowerCase();
  if (!/^[^\s@]+@qq\.com$/.test(email)) throw new Error('EMAIL_ADDRESS must be your @qq.com address');
  const authCode = env.EMAIL_AUTH_CODE || '';
  if (authCode.length < 8 || authCode.length > 128 || /^(replace|change|example)/i.test(authCode)) throw new Error('Set EMAIL_AUTH_CODE privately');
  const ownerPassword = env.OWNER_PASSWORD || '';
  if (ownerPassword.length < 24 || ownerPassword.length > 256 || /^(replace|change|example)/i.test(ownerPassword)) {
    throw new Error('OWNER_PASSWORD must be a separate random secret of at least 24 characters');
  }
  const redirects = (env.ALLOWED_REDIRECT_URIS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!redirects.length || redirects.length > 16) throw new Error('Set 1–16 exact ALLOWED_REDIRECT_URIS');
  const redirectUris = [...new Set(redirects.map(x => {
    const normalized = httpsUrl(x, 'ALLOWED_REDIRECT_URIS');
    if (x !== normalized || x.includes('*')) throw new Error('Redirect URIs must be exact canonical URLs, without wildcards');
    return x;
  }))];
  const allowedOrigins = [publicBase, ...(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => httpsUrl(x, 'ALLOWED_ORIGINS', true))];
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('HOST must be loopback; use an HTTPS reverse proxy');
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  for (const key of ['ENABLE_WRITE_TOOLS', 'ENABLE_DELETE_TOOL']) {
    if (env[key] && !['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false`);
  }
  const scopes = ['mail.read'];
  if (env.ENABLE_WRITE_TOOLS === 'true') scopes.push('mail.modify', 'mail.send');
  if (env.ENABLE_DELETE_TOOL === 'true') scopes.push('mail.delete');
  return {
    publicBase, resource: `${publicBase}/mcp`, metadataUrl: `${publicBase}/.well-known/oauth-protected-resource/mcp`,
    email, authCode, ownerPassword, redirectUris, allowedOrigins, host, port, scopes,
    dataDir: resolve(env.DATA_DIR || './data'),
    // Changing the owner/mailbox/issuer invalidates old grants instead of silently crossing account boundaries.
    binding: createHash('sha256').update(JSON.stringify([publicBase, email, authCode, ownerPassword, scopes])).digest('hex'),
  };
}

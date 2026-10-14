import { createHash } from 'node:crypto';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  providerId: string;
  name: string;
  callbackURL: string;
  origins: string[];
  allowHTTP: boolean;
  autoProvision: boolean;
  emailDomains: string[];
  tokenAuthMethod: 'client_secret_basic' | 'client_secret_post';
}

export function readOidcSettings(env: NodeJS.ProcessEnv = process.env): OidcSettings | null {
  if (env.OIDC_ENABLED !== 'true') return null;
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when OIDC is enabled`);
    return value;
  };
  const issuer = new URL(required('OIDC_ISSUER_URL'));
  const allowHTTP = env.NODE_ENV !== 'production' && env.OIDC_ALLOW_HTTP === 'true';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
  if (issuer.username || issuer.password || issuer.search || issuer.hash ||
      (issuer.protocol !== 'https:' && !(allowHTTP && loopback && issuer.protocol === 'http:'))) {
    throw new Error('OIDC issuer must use HTTPS (HTTP is allowed only for explicit loopback development)');
  }
  const base = new URL(required('AUTH_BASE_URL'));
  const origins = required('AUTH_TRUST_ORIGINS').split(',').map(value => {
    const url = new URL(value.trim());
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !['http:', 'https:'].includes(url.protocol) ||
        (env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
      throw new Error('AUTH_TRUST_ORIGINS must contain exact web origins; production requires HTTPS');
    }
    return url.origin;
  });
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      !['http:', 'https:'].includes(base.protocol) ||
      (env.NODE_ENV === 'production' && base.protocol !== 'https:')) {
    throw new Error('AUTH_BASE_URL must be the public API origin; production requires HTTPS');
  }
  const tokenAuthMethod = env.OIDC_TOKEN_AUTH_METHOD || 'client_secret_basic';
  if (!['client_secret_basic', 'client_secret_post'].includes(tokenAuthMethod)) {
    throw new Error('Invalid OIDC_TOKEN_AUTH_METHOD');
  }
  return {
    issuer: issuer.href,
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    providerId: `oidc:${createHash('sha256').update(issuer.href).digest('hex')}`,
    name: env.OIDC_DISPLAY_NAME?.trim() || 'SSO',
    callbackURL: new URL('/api/auth/oidc/callback', base).href,
    origins,
    allowHTTP: allowHTTP && loopback && issuer.protocol === 'http:',
    autoProvision: env.OIDC_AUTO_PROVISION !== 'false',
    emailDomains: (env.OIDC_EMAIL_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    tokenAuthMethod: tokenAuthMethod as OidcSettings['tokenAuthMethod'],
  };
}

/** Only the fixed app landing pages can be selected, never an arbitrary redirect. */
export function oidcDestination(settings: OidcSettings, callbackURL: string, link = false) {
  const url = new URL(callbackURL);
  if (!settings.origins.includes(url.origin) || url.pathname !== (link ? '/settings' : '/dashboard') || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid OIDC callback destination');
  }
  return {
    success: link ? `${url.origin}/settings?tab=security&oidc_linked=1` : url.href,
    error: `${url.origin}${link ? '/settings?tab=security&' : '/login?'}oidc_error=1`,
    mfa: `${url.origin}/login?oidc_mfa=1`,
  };
}

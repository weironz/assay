import { readFileSync } from 'node:fs';

export interface DirectorySettings {
  url: string; baseDN: string; bindDN: string; passwordFile: string; caFile: string;
  domain: string; sambaDomain: string; providerId: string; name: string; autoProvision: boolean; origins: string[];
}
export function readDirectorySettings(env: NodeJS.ProcessEnv = process.env): DirectorySettings | null {
  if (env.DIRECTORY_AUTH_ENABLED !== 'true') return null;
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required when directory login is enabled`);
    return value;
  };
  const url = new URL(required('DIRECTORY_LDAP_URL'));
  if (url.protocol !== 'ldaps:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Directory authentication requires an LDAPS origin');
  const domain = required('DIRECTORY_DOMAIN').toLowerCase();
  if (domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid directory domain');
  const sambaDomain = env.DIRECTORY_NETBIOS_DOMAIN?.trim().toUpperCase() || domain.split('.')[0].toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,14}$/.test(sambaDomain)) throw new Error('Invalid NetBIOS domain');
  const origins = required('AUTH_TRUST_ORIGINS').split(',').map(value => {
    const origin = new URL(value.trim());
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !['http:', 'https:'].includes(origin.protocol) || (env.NODE_ENV === 'production' && origin.protocol !== 'https:'))
      throw new Error('Directory login requires exact trusted web origins');
    return origin.origin;
  });
  return {
    url: url.href.replace(/\/$/, ''), baseDN: required('DIRECTORY_BASE_DN'), bindDN: required('DIRECTORY_BIND_DN'),
    passwordFile: required('DIRECTORY_BIND_PASSWORD_FILE'), caFile: required('DIRECTORY_CA_FILE'),
    domain, sambaDomain, providerId: `ad:${domain}`, name: env.DIRECTORY_DISPLAY_NAME?.trim() || '公司账号',
    autoProvision: env.DIRECTORY_AUTO_PROVISION !== 'false', origins,
  };
}
export const directorySecret = (path: string) => readFileSync(path, 'utf8').replace(/\r?\n$/, '');
export const adDomainDN = (domain: string) => domain.split('.').map(label => `DC=${label}`).join(',');
export const normalizedDomainDN = (dn: string) => dn.split(',').map(part => part.trim().toLowerCase()).join(',');

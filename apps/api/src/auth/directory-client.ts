import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AndFilter, OrFilter, Client, EqualityFilter, type Entry, type Filter } from 'ldapts';
import { directorySecret, type DirectorySettings } from './directory-config';

export interface DirectoryProfile {
  id: string; accountName: string; dn: string; name: string; email: string | null;
  groupSids: string[]; securityStamp: string;
}
export class DirectoryRejected extends Error { constructor() { super('DIRECTORY_CREDENTIALS_REJECTED'); } }
export class DirectoryUnavailable extends Error { constructor() { super('DIRECTORY_UNAVAILABLE'); } }
export function sidString(raw: Buffer): string {
  if (raw.length < 8 || raw[0] !== 1 || raw[1] > 15 || raw.length !== 8 + raw[1] * 4) throw new DirectoryRejected();
  let authority = 0n;
  for (const b of raw.subarray(2, 8)) authority = (authority << 8n) | BigInt(b);
  return `S-1-${authority}` + Array.from({ length: raw[1] }, (_, i) => `-${raw.readUInt32LE(8 + i * 4)}`).join('');
}
function values(entry: Entry, key: string): (string | Buffer)[] {
  const actual = Object.keys(entry).find(k => k.toLowerCase() === key.toLowerCase());
  const value = actual ? entry[actual] : undefined;
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
const string = (entry: Entry, key: string) => values(entry, key)[0]?.toString() || '';
export function directoryProfile(entry: Entry): DirectoryProfile {
  const guid = values(entry, 'objectGUID')[0];
  const control = Number(string(entry, 'userAccountControl'));
  const computed = Number(string(entry, 'msDS-User-Account-Control-Computed') || 0);
  const expires = BigInt(string(entry, 'accountExpires') || 0);
  const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
  if (!Buffer.isBuffer(guid) || guid.length !== 16 || !Number.isInteger(control) || !control ||
      control & 2 || computed & (16 | 8388608) ||
      (expires !== 0n && expires !== 9223372036854775807n && expires <= now)) throw new DirectoryRejected();
  const accountName = string(entry, 'sAMAccountName');
  const pwdLastSet = string(entry, 'pwdLastSet');
  if (!accountName || accountName.endsWith('$') || !pwdLastSet || pwdLastSet === '0') throw new DirectoryRejected();
  const groupSids = values(entry, 'tokenGroups').map(v => {
    if (!Buffer.isBuffer(v)) throw new DirectoryRejected();
    return sidString(v);
  }).sort();
  if (!groupSids.length) throw new DirectoryRejected();
  const email = string(entry, 'mail').trim().toLowerCase();
  return {
    id: guid.toString('hex'), accountName, dn: entry.dn,
    name: string(entry, 'displayName') || accountName,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    groupSids,
    securityStamp: createHash('sha256').update(JSON.stringify([guid.toString('hex'), pwdLastSet, control])).digest('hex'),
  };
}
const attributes = ['objectGUID', 'sAMAccountName', 'displayName', 'mail', 'userAccountControl', 'msDS-User-Account-Control-Computed', 'pwdLastSet', 'accountExpires', 'tokenGroups'];
export class DirectoryClient {
  constructor(readonly settings: DirectorySettings) {}
  private client() {
    return new Client({ url: this.settings.url, connectTimeout: 5000, timeout: 8000,
      tlsOptions: { ca: [readFileSync(this.settings.caFile)], rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
  }
  private async reader<T>(action: (client: Client) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    try {
      client = this.client();
      const secret = directorySecret(this.settings.passwordFile);
      if (!secret) throw new DirectoryUnavailable();
      await client.bind(this.settings.bindDN, secret);
      return await action(client);
    } catch (e) {
      if (e instanceof DirectoryRejected) throw e;
      throw new DirectoryUnavailable();
    } finally { await client?.unbind().catch(() => {}); }
  }
  private async lookup(filter: Filter): Promise<DirectoryProfile> {
    return this.reader(async client => {
      // tokenGroups is a constructed attribute: fetch it with a base-object search.
      const result = await client.search(this.settings.baseDN, { scope: 'sub', filter: new AndFilter({ filters: [
        new EqualityFilter({ attribute: 'objectCategory', value: 'person' }),
        new EqualityFilter({ attribute: 'objectClass', value: 'user' }), filter,
      ] }), attributes: ['1.1'], sizeLimit: 2, timeLimit: 5 });
      if (result.searchEntries.length !== 1) throw new DirectoryRejected();
      const entry = await client.search(result.searchEntries[0].dn, { scope: 'base', filter: '(objectClass=user)', attributes, explicitBufferAttributes: ['objectGUID', 'tokenGroups'], timeLimit: 5 });
      if (entry.searchEntries.length !== 1) throw new DirectoryRejected();
      return directoryProfile(entry.searchEntries[0]);
    });
  }
  async profile(id: string) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new DirectoryRejected();
    // Preserve arbitrary GUID octets; parsing escaped bytes as a UTF-8 string is lossy.
    return this.lookup(new EqualityFilter({ attribute: 'objectGUID', value: Buffer.from(id, 'hex') }));
  }
  async findAccount(username: string) {
    let name = username.trim();
    if (name.includes('\\')) {
      const parts = name.split('\\');
      if (parts.length !== 2 || ![this.settings.domain, this.settings.sambaDomain.toLowerCase()].includes(parts[0].toLowerCase())) throw new DirectoryRejected();
      name = parts[1];
    }
    if (!name || name.length > 254 || /[\x00-\x1f\x7f]/.test(name)) throw new DirectoryRejected();
    return this.lookup(name.includes('@') ? new OrFilter({ filters: [
      new EqualityFilter({ attribute: 'userPrincipalName', value: name }), new EqualityFilter({ attribute: 'mail', value: name }),
    ] }) : new EqualityFilter({ attribute: 'sAMAccountName', value: name }));
  }
  async authenticate(username: string, password: string) {
    return this.verify(await this.findAccount(username), password);
  }
  async verify(profile: DirectoryProfile, password: string) {
    if (!password || password.length > 512 || password.includes('\0')) throw new DirectoryRejected();
    let client: Client | undefined;
    try {
      client = this.client(); await client.bind(profile.dn, password);
      const result = await client.search(profile.dn, { scope: 'base', filter: '(objectClass=user)', attributes, explicitBufferAttributes: ['objectGUID', 'tokenGroups'], timeLimit: 5 });
      if (result.searchEntries.length !== 1) throw new DirectoryRejected();
      const verified = directoryProfile(result.searchEntries[0]);
      if (verified.id !== profile.id) throw new DirectoryRejected();
      return verified;
    }
    catch (e: any) { if (e instanceof DirectoryRejected || e?.code === 49) throw new DirectoryRejected(); throw new DirectoryUnavailable(); }
    finally { await client?.unbind().catch(() => {}); }
  }
  async groups() {
    return this.reader(async client => {
      const result = await client.search(this.settings.baseDN, { scope: 'sub', filter: '(objectClass=group)', attributes: ['objectSid', 'sAMAccountName'], explicitBufferAttributes: ['objectSid'], paged: { pageSize: 200 }, sizeLimit: 2000, timeLimit: 5 });
      return result.searchEntries.map(e => {
        const sid = values(e, 'objectSid')[0];
        if (!Buffer.isBuffer(sid)) throw new DirectoryRejected();
        return { sid: sidString(sid), name: string(e, 'sAMAccountName') };
      }).sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}

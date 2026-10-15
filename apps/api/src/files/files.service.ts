import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { authRedis } from '../auth/auth-redis';
import { webSessionScopes } from '../auth/web-session-scope';
import type { AuthUser } from '../auth/auth.types';
import { SambaService } from '../samba/samba.service';
import { PrismaService } from '../prisma/prisma.service';
import { enabledModules, fileCommandSchema, locationSchema, loginSchema } from './contracts';

interface Capability { token: string; id: string; domain: string; policies: Record<string, string> }
@Injectable()
export class FilesService {
  constructor(private readonly samba: SambaService, private readonly prisma: PrismaService) {}
  private scope(req: Request, user: AuthUser) {
    if (!enabledModules().files) throw new ServiceUnavailableException('员工文件模块未启用');
    const scope = webSessionScopes.get(req);
    if (user.authType !== 'session' || !scope || !Number.isFinite(scope.expiresAt) || scope.expiresAt <= Date.now()) throw new ForbiddenException('请使用 Assay Web 登录访问文件');
    return scope;
  }
  private csrf(req: Request) {
    const origins = (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
    if (!req.headers.origin || !origins.includes(req.headers.origin)) throw new ForbiddenException('文件操作来源校验失败');
  }
  private key(owner: string) { return `assay:files:session:${owner}`; }
  private async stored(owner: string): Promise<Capability | null> {
    const raw = await authRedis.get(this.key(owner));
    return raw ? JSON.parse(raw) : null;
  }
  private gatewayConfig() {
    try {
      const url = new URL(process.env.FILES_GATEWAY_URL || '');
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['file-gateway', 'localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error();
      const token = readFileSync(process.env.FILES_GATEWAY_TOKEN_FILE || '', 'utf8').trim();
      if (token.length < 32) throw new Error();
      return { address: url.toString().replace(/\/$/, ''), token };
    } catch { throw new ServiceUnavailableException('文件服务未配置'); }
  }
  private async gateway(path: string, owner: string, cap: Capability | null, init: RequestInit = {}) {
    const c = this.gatewayConfig();
    try {
      return await fetch(c.address + path, { ...init, redirect: 'error', headers: {
        Authorization: `Bearer ${c.token}`, 'X-File-Owner': owner,
        ...(cap ? { 'X-File-Session': cap.token } : {}), ...init.headers,
      }, signal: init.signal || AbortSignal.timeout(45000) });
    } catch { throw new ServiceUnavailableException('文件服务连接失败；写操作请先刷新核对结果'); }
  }
  private async json(response: globalThis.Response, owner: string) {
    if (!response.ok) {
      if (response.status === 410) await this.revoke(owner);
      const allowed = [400, 403, 404, 409, 410, 413, 422, 429];
      const status = allowed.includes(response.status) ? response.status : 502;
      // Only gateway's fixed error strings, never authentication payloads or raw protocol errors.
      const body = await response.json().catch(() => ({})) as any;
      throw new HttpException(body.error || '文件请求失败，请重新验证或刷新后重试', status);
    }
    return response.json() as Promise<any>;
  }
  async revoke(owner: string, closed = false) {
    if (closed) await authRedis.set(`assay:files:closed:${owner}`, '1', { EX: 3700 });
    const raw = await authRedis.getDel(this.key(owner));
    if (!raw) return;
    const cap: Capability = JSON.parse(raw);
    try { await this.gateway('/v1/session', owner, cap, { method: 'DELETE', signal: AbortSignal.timeout(10000) }); }
    catch { /* No usable API capability remains. Gateway independently expires the connection. */ }
  }
  private async context(req: Request, user: AuthUser, share?: string) {
    const scope = this.scope(req, user);
    const cap = await this.stored(scope.fingerprint);
    if (!cap) throw new HttpException('请先验证自己的 AD 密码', 410);
    let identity: Awaited<ReturnType<SambaService['fileIdentity']>>;
    try { identity = await this.samba.fileIdentity(user); }
    catch (e) { await this.revoke(scope.fingerprint); throw e; }
    if (!identity || identity.identity.id !== cap.id || identity.domain !== cap.domain || this.policiesChanged(cap, identity.sharePolicies)) {
      await this.revoke(scope.fingerprint);
      throw new HttpException('身份关联或共享配置已变化，请重新验证', 410);
    }
    // An arbitrary GET share parameter must not revoke a valid employee session.
    if (share && (!identity.shares.includes(share) || !Object.hasOwn(cap.policies, share))) throw new ForbiddenException('无权访问该共享目录');
    return { owner: scope.fingerprint, cap };
  }
  private policiesChanged(cap: Capability, current: Record<string, string>) {
    return !cap.policies || Object.entries(cap.policies).some(([share, revision]) => current[share] !== revision);
  }
  async status(req: Request, user: AuthUser) {
    const scope = this.scope(req, user);
    const linked = await this.samba.fileIdentity(user);
    const identity = linked ? { accountName: linked.identity.name, domain: linked.domain } : null;
    if (!linked) { await this.revoke(scope.fingerprint); return { enabled: true, connected: false, identity }; }
    const cap = await this.stored(scope.fingerprint);
    if (!cap) return { enabled: true, connected: false, identity };
    if (cap.id !== linked.identity.id || cap.domain !== linked.domain || this.policiesChanged(cap, linked.sharePolicies)) { await this.revoke(scope.fingerprint); return { enabled: true, connected: false, identity }; }
    try {
      const data = await this.json(await this.gateway('/v1/session', scope.fingerprint, cap), scope.fingerprint);
      return { enabled: true, connected: true, identity, ...data, shares: data.shares.filter((s: string) => linked.shares.includes(s)) };
    } catch (e) { if (e instanceof HttpException && e.getStatus() === 410) return { enabled: true, connected: false, identity }; throw e; }
  }
  async login(req: Request, user: AuthUser, body: unknown) {
    const scope = this.scope(req, user); this.csrf(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请输入自己的 AD 密码');
    const attemptKey = `assay:files:attempt:${user.id}`;
    const attempts = Number(await authRedis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n", { keys: [attemptKey], arguments: [] }));
    if (attempts > 5) throw new HttpException('AD 验证次数过多，请 15 分钟后重试', 429);
    const lock = `assay:files:login:${scope.fingerprint}`;
    const lockId = randomUUID();
    if (!await authRedis.set(lock, lockId, { NX: true, EX: 120 })) throw new HttpException('正在验证，请稍后重试', 409);
    let newCap: Capability | null = null;
    try {
      const linked = await this.samba.fileIdentity(user);
      if (!linked) throw new ForbiddenException('请先由管理员关联你的 AD 员工账号');
      await this.revoke(scope.fingerprint);
      const ttl = Math.min(3600, Math.floor((scope.expiresAt - Date.now()) / 1000));
      if (ttl <= 0) throw new ForbiddenException('Assay 会话已到期');
      const data = await this.json(await this.gateway('/v1/session', scope.fingerprint, null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: scope.fingerprint, identity: linked.identity, shares: linked.shares, password: parsed.data.password, ttl }) }), scope.fingerprint);
      newCap = { token: data.token, id: linked.identity.id, domain: linked.domain, policies: Object.fromEntries(data.shares.map((share: string) => [share, linked.sharePolicies[share]])) };
      const stored = await authRedis.eval("if redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1", {
        keys: [this.key(scope.fingerprint), `assay:files:closed:${scope.fingerprint}`], arguments: [JSON.stringify(newCap), String(ttl)],
      });
      if (!stored) throw new HttpException('Assay 会话已退出，请重新登录', 410);
      await authRedis.eval("local n=tonumber(redis.call('GET',KEYS[1]) or '0'); if n>0 then return redis.call('DECR',KEYS[1]) end; return 0", { keys: [attemptKey], arguments: [] });
      return { enabled: true, connected: true, identity: { accountName: linked.identity.name, domain: linked.domain }, shares: data.shares, expiresAt: data.expiresAt, maxFileBytes: data.maxFileBytes };
    } catch (e) {
      if (newCap) { try { await this.gateway('/v1/session', scope.fingerprint, newCap, { method: 'DELETE' }); } catch {} }
      throw e;
    } finally {
      parsed.data.password = '';
      if (body && typeof body === 'object' && 'password' in body) (body as any).password = '';
      await authRedis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", { keys: [lock], arguments: [lockId] });
    }
  }
  async logout(req: Request, user: AuthUser) { const scope = this.scope(req, user); this.csrf(req); await this.revoke(scope.fingerprint); return { ok: true }; }
  private location(input: unknown) { const p = locationSchema.safeParse(input); if (!p.success) throw new BadRequestException('文件路径无效'); return p.data; }
  async list(req: Request, user: AuthUser, input: unknown) {
    const loc = this.location(input); const { owner, cap } = await this.context(req, user, loc.share);
    return this.json(await this.gateway('/v1/list?' + new URLSearchParams(loc), owner, cap), owner);
  }
  private async audit(user: AuthUser, action: string, metadata: Record<string, string>) {
    return this.prisma.sambaOperation.create({ data: { id: randomUUID(), actorId: user.id, actorName: user.name, action: `file.${action}`, requestHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'), metadata } });
  }
  private async finish(id: string, succeeded: boolean) { await this.prisma.sambaOperation.update({ where: { id }, data: { state: succeeded ? 'succeeded' : 'uncertain', result: { message: succeeded ? '已完成' : '未确认完成，请刷新核对；不要自动重试写操作' } } }); }
  async command(req: Request, user: AuthUser, input: unknown) {
    this.csrf(req); const p = fileCommandSchema.safeParse(input); if (!p.success) throw new BadRequestException('文件操作参数无效');
    const c = p.data; const { owner, cap } = await this.context(req, user, c.share);
    const op = await this.audit(user, c.action, { share: c.share, path: c.path, destination: c.destination || '' });
    try {
      const data = await this.json(await this.gateway('/v1/commands', owner, cap, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }), owner);
      await this.finish(op.id, true); return data;
    } catch (e) { await this.finish(op.id, false); throw e; }
  }
  async transfer(req: Request, res: ExpressResponse, user: AuthUser, input: unknown, upload: boolean) {
    if (upload) this.csrf(req);
    const loc = this.location(input); if (!loc.path) throw new BadRequestException('请选择文件');
    const { owner, cap } = await this.context(req, user, loc.share);
    const length = req.headers['content-length'];
    if (upload && (req.headers['content-type'] !== 'application/octet-stream' || !length || !/^\d+$/.test(length) || Number(length) > 512 * 1024 * 1024)) throw new BadRequestException('上传格式或文件大小无效');
    const op = await this.audit(user, upload ? 'upload' : 'download', loc);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 600000);
    const cancel = () => { if (!res.writableFinished) abort.abort(); };
    req.once('aborted', cancel); res.once('close', cancel);
    try {
      const init: RequestInit & { duplex?: 'half' } = { method: upload ? 'PUT' : 'GET', signal: abort.signal };
      if (upload) { init.headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': length! }; init.body = Readable.toWeb(req) as ReadableStream; init.duplex = 'half'; }
      const upstream = await this.gateway('/v1/content?' + new URLSearchParams(loc), owner, cap, init);
      if (!upstream.ok) await this.json(upstream, owner);
      for (const h of ['content-type', 'content-length', 'content-disposition']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!upstream.body) throw new ServiceUnavailableException('文件响应为空');
      await pipeline(Readable.fromWeb(upstream.body as any), res);
      await this.finish(op.id, true);
    } catch (e) {
      await this.finish(op.id, false);
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
      throw e;
    } finally { clearTimeout(timer); req.off('aborted', cancel); res.off('close', cancel); }
  }
}

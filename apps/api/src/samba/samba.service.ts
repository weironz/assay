import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { actions, bindingSchema, commandSchema, directoryPath, metadata, selfPasswordSchema } from './contracts';

@Injectable()
export class SambaService {
  constructor(private readonly prisma: PrismaService) {}
  private config() {
    if (process.env.SAMBA_ENABLED !== 'true') throw new ServiceUnavailableException('Samba 管理未启用');
    const address = process.env.SAMBA_AGENT_URL || '';
    const url = new URL(address);
    // HTTP is permitted only on the explicitly isolated Compose service / loopback.
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['agent', '127.0.0.1', 'localhost'].includes(url.hostname)))) throw new ServiceUnavailableException('Agent 地址必须使用 HTTPS 或隔离 Compose 网络');
    const token = readFileSync(process.env.SAMBA_AGENT_TOKEN_FILE || '', 'utf8').trim();
    if (token.length < 32) throw new ServiceUnavailableException('Agent 凭据未配置');
    return { address: address.replace(/\/$/, ''), token };
  }
  private async agent(path: string, body?: unknown) {
    const c = this.config();
    let response: Response;
    try { response = await fetch(c.address + path, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${c.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); }
    catch { throw new ServiceUnavailableException('Agent 连接失败；写操作请查看操作记录确认结果'); }
    const value = await response.json();
    if (!response.ok) throw new HttpException(value.error || 'Agent 请求失败', response.status === 401 ? 502 : 400);
    return value;
  }
  async snapshot() {
    if (process.env.SAMBA_ENABLED !== 'true') return { enabled: false };
    const data = await this.agent('/v1/snapshot');
    const [bindings, assayUsers] = await Promise.all([
      this.prisma.sambaIdentity.findMany(),
      this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
    ]);
    return { enabled: true, ...data, bindings, assayUsers };
  }
  async directories(input: unknown, acl = false) {
    const parsed = directoryPath.safeParse(input);
    if (!parsed.success) throw new BadRequestException('目录参数无效');
    return this.agent(`/v1/${acl ? 'acl' : 'directories'}?${new URLSearchParams(parsed.data).toString()}`);
  }
  async history() {
    return this.prisma.sambaOperation.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, actorName: true, action: true, metadata: true, state: true, result: true, createdAt: true } });
  }
  async operation(id: string) {
    const op = await this.prisma.sambaOperation.findUnique({ where: { id } });
    if (!op) throw new BadRequestException('操作不存在');
    if (['pending', 'queued', 'running', 'uncertain'].includes(op.state) && !op.action.startsWith('identity.') && !op.action.startsWith('file.')) {
      try {
        const r = await this.agent(`/v1/operations/${encodeURIComponent(id)}`);
        await this.prisma.sambaOperation.update({ where: { id }, data: { state: r.state, result: r } });
      } catch { /* Retain uncertainty; never replay an external write automatically. */ }
    }
    return this.prisma.sambaOperation.findUnique({ where: { id } });
  }
  async ownOperation(user: AuthUser, id: string) {
    const op = await this.prisma.sambaOperation.findUnique({ where: { id } });
    if (!op || op.actorId !== user.id) throw new ForbiddenException('不可访问该操作');
    return this.operation(id);
  }
  private async submit(user: AuthUser, requestId: string, action: string, args: Record<string, unknown>) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new ServiceUnavailableException('操作签名密钥未配置');
    const hash = createHmac('sha256', secret).update(JSON.stringify({ actorId: user.id, action, args })).digest('hex');
    const previous = await this.prisma.sambaOperation.findUnique({ where: { id: requestId } });
    if (previous) {
      if (previous.requestHash !== hash) throw new ConflictException('操作编号已用于其他请求');
      const reconciled = await this.operation(requestId);
      if (!reconciled || reconciled.state !== 'succeeded') throw new ConflictException({ message: '先前操作未确认成功，请核对操作记录', operationId: requestId, state: reconciled?.state });
      return reconciled;
    }
    try {
      await this.prisma.sambaOperation.create({ data: { id: requestId, actorId: user.id, actorName: user.name, action, requestHash: hash, metadata: metadata(args) as any } });
    } catch (e: any) { if (e.code === 'P2002') throw new ConflictException('操作已提交，请查看操作记录'); throw e; }
    let result: any;
    try { result = await this.agent('/v1/commands', { request_id: requestId, action, args }); }
    catch (e) {
      await this.prisma.sambaOperation.update({ where: { id: requestId }, data: { state: 'uncertain', result: { error: '未收到执行结果，请核对操作记录与资源状态' } } });
      throw e;
    }
    const op = await this.prisma.sambaOperation.update({ where: { id: requestId }, data: { state: result.state, result } });
    if (!['succeeded', 'queued', 'running'].includes(result.state)) throw new BadRequestException({ message: result.error || '操作未完成', operationId: requestId, state: result.state });
    return op;
  }
  async command(user: AuthUser, input: unknown) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('操作参数无效');
    const { requestId, action, args } = parsed.data;
    const validated = actions[action].safeParse(args);
    if (!validated.success) throw new BadRequestException('操作参数无效');
    return this.submit(user, requestId, action, validated.data);
  }
  async bind(user: AuthUser, input: unknown) {
    const p = bindingSchema.safeParse(input);
    if (!p.success) throw new BadRequestException('绑定参数无效');
    const assayUser = await this.prisma.user.findUnique({ where: { id: p.data.userId } });
    if (p.data.adObjectId && (!assayUser || assayUser.status !== 'ACTIVE')) throw new BadRequestException('Assay 用户不可绑定');
    let identity: any = null;
    if (p.data.adObjectId) {
      const snapshot = await this.agent('/v1/snapshot');
      const account = snapshot.users.find((u: any) => u.id === p.data.adObjectId);
      if (!account || account.disabled) throw new BadRequestException('AD 用户不可绑定');
      identity = { adObjectId: account.id, domain: snapshot.domain, accountName: account.name, linkedBy: user.id };
    }
    try {
      return await this.prisma.$transaction(async tx => {
        if (identity) await tx.sambaIdentity.upsert({ where: { userId: p.data.userId }, create: { userId: p.data.userId, ...identity }, update: identity });
        else await tx.sambaIdentity.deleteMany({ where: { userId: p.data.userId } });
        await tx.sambaOperation.create({ data: { id: crypto.randomUUID(), actorId: user.id, actorName: user.name, action: identity ? 'identity.bind' : 'identity.unbind', requestHash: '-', state: 'succeeded', metadata: { userId: p.data.userId, adObjectId: p.data.adObjectId } } });
        return { linked: !!identity };
      });
    } catch (e: any) { if (e.code === 'P2002') throw new ConflictException('AD 账号已绑定其他 Assay 用户'); throw e; }
  }
  async identity(user: AuthUser) {
    if (process.env.SAMBA_ENABLED !== 'true') return { enabled: false, identity: null };
    return { enabled: true, identity: await this.prisma.sambaIdentity.findUnique({ where: { userId: user.id }, select: { accountName: true, domain: true } }) };
  }
  async fileIdentity(user: AuthUser) {
    const link = await this.prisma.sambaIdentity.findUnique({ where: { userId: user.id } });
    if (!link) return null;
    const data = await this.agent('/v1/snapshot');
    const account = data.users.find((u: any) => u.id === link.adObjectId && !u.disabled && u.manageable);
    if (!account || data.domain !== link.domain) throw new ForbiddenException('关联的 AD 员工账号不可用');
    return {
      identity: { id: account.id as string, name: account.name as string, dn: account.dn as string },
      domain: link.domain,
      // Restrict employee access to active shares explicitly managed by Assay.
      shares: data.shares.filter((s: any) => s.active && s.ready !== false).map((s: any) => s.name as string),
    };
  }
  async selfPassword(user: AuthUser, input: unknown) {
    const p = selfPasswordSchema.safeParse(input);
    if (!p.success) throw new BadRequestException('密码参数无效');
    const link = await this.prisma.sambaIdentity.findUnique({ where: { userId: user.id } });
    if (!link) throw new ForbiddenException('尚未绑定 AD 身份');
    const snapshot = await this.agent('/v1/snapshot');
    if (snapshot.domain !== link.domain || !snapshot.users.some((u: any) => u.id === link.adObjectId && !u.disabled)) throw new ForbiddenException('绑定身份不可用');
    return this.submit(user, p.data.requestId, 'user.change_password', { id: link.adObjectId, old_password: p.data.old_password, password: p.data.password });
  }
}

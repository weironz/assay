import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { actions, bindingSchema, bulkCreateSchema, commandSchema, directoryPath, metadata, selfPasswordSchema, renameSchema } from './contracts';
import { normalizedDomainDN } from '../auth/directory-config';

@Injectable()
export class SambaService implements OnModuleInit,OnModuleDestroy {
  private renameTimer?: ReturnType<typeof setInterval>;
  private reconciling=false;
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() { if(process.env.SAMBA_ENABLED==='true'){this.renameTimer=setInterval(()=>{void this.reconcileRenames()},10000);this.renameTimer.unref();void this.reconcileRenames();} }
  onModuleDestroy(){if(this.renameTimer)clearInterval(this.renameTimer)}
  private async reconcileRenames(){
    if(this.reconciling)return;this.reconciling=true;
    try{const rows=await this.prisma.sambaOperation.findMany({where:{action:{in:['user.rename','group.rename','share.rename']},state:{in:['pending','queued','running','uncertain']}},orderBy:{createdAt:'asc'},take:10});for(const row of rows)await this.operation(row.id).catch(()=>{});}catch{/* Durable operations are retried by reading Agent state; writes are never replayed. */}finally{this.reconciling=false}
  }
  async renamePreview(input:unknown){const p=renameSchema.safeParse(input);if(!p.success)throw new BadRequestException({code:'RENAME_INVALID_NAME',message:'重命名参数无效，请核对名称并刷新后重试'});return this.agent('/v1/rename-preview',p.data)}
  private async invalidateRenameProfile(providerId:string,id:string){const {authRedis}=await import('../auth/auth-redis');await authRedis.del(`assay:directory:profile:${createHash('sha256').update(`${providerId}:${id}`).digest('hex')}`)}
  /** 审计哈希链的固定编号，串行化并发追加，保证链头读取不竞争 */
  private static readonly CHAIN_LOCK_KEY = 918273645;
  private chainHash(previous: string | null, id: string, requestHash: string) {
    return createHash('sha256').update(`${previous ?? ''}|${id}|${requestHash}`).digest('hex');
  }
  /** 在事务内追加一条 SambaOperation 并接入哈希链 */
  private async appendOperation(tx: Prisma.TransactionClient, data: { id: string; actorId: string; actorName: string; action: string; requestHash: string; metadata: any; state?: string }) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SambaService.CHAIN_LOCK_KEY})`;
    const last = await tx.sambaOperation.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { chainHash: true } });
    return tx.sambaOperation.create({ data: { ...data, chainHash: this.chainHash(last?.chainHash ?? null, data.id, data.requestHash) } });
  }
  /** 校验审计哈希链：返回首个断点。迁移前的旧行为 NULL，作为未入链前缀跳过 */
  async audit() {
    const rows = await this.prisma.sambaOperation.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, requestHash: true, chainHash: true } });
    let previous = '';
    let brokenAt: string | null = null;
    for (const row of rows) {
      if (row.chainHash === null) continue;
      if (!brokenAt && row.chainHash !== this.chainHash(previous || null, row.id, row.requestHash)) brokenAt = row.id;
      previous = row.chainHash;
    }
    return { total: rows.length, chained: rows.filter(r => r.chainHash !== null).length, valid: !brokenAt, brokenAt };
  }
  private async recordResult(id:string,result:any){    const op=await this.prisma.sambaOperation.findUnique({where:{id}});
    if(op && result.state==='succeeded' && ['user.rename','group.rename','share.rename'].includes(op.action)){
      const r=result.result;const expected=op.metadata as any;
      if(!r || r.id!==expected.id || r.newName!==expected.name || r.kind!==expected.kind)throw new ServiceUnavailableException('重命名结果需要人工核对');
      const domain=typeof r.domain==='string'?normalizedDomainDN(r.domain):'';
      if(!/^dc=[^,]+(?:,dc=[^,]+)*$/.test(domain))throw new ServiceUnavailableException('重命名目录域需要核对');
      const providerId='ad:'+domain.split(',').map((v:string)=>v.slice(3)).join('.');
      // Clear only the renamed principal's cached AD profile. No credentials or roles change.
      if(r.kind==='user')await this.invalidateRenameProfile(providerId,r.id);
      return this.prisma.$transaction(async tx=>{
        if(r.kind==='user'){
          const bindings=await tx.sambaIdentity.findMany({where:{adObjectId:r.id}});
          const userIds=bindings.filter(binding=>normalizedDomainDN(binding.domain)===domain).map(binding=>binding.userId);
          await tx.sambaIdentity.updateMany({where:{userId:{in:userIds},adObjectId:r.id},data:{accountName:r.newName}});
          await tx.directoryIdentity.updateMany({where:{objectId:r.id,providerId},data:{accountName:r.newName,checkedAt:new Date()}});
        }
        if(r.kind==='group')await tx.directoryGroupRole.updateMany({where:{providerId,groupSid:r.sid},data:{groupName:r.newName}});
        return tx.sambaOperation.update({where:{id},data:{state:result.state,result}});
      });
    }
    return this.prisma.sambaOperation.update({where:{id},data:{state:result.state,result}});
  }
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
  private async agent(path: string, body?: unknown, timeout=45000) {
    const c = this.config();
    let response: Response;
    try { response = await fetch(c.address + path, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${c.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) }); }
    catch { throw new ServiceUnavailableException('Agent 连接失败；写操作请查看操作记录确认结果'); }
    const value = await response.json();
    if (!response.ok) throw new HttpException(value.error_code ? {code:value.error_code,message:'操作预检查失败，请核对名称、配置和资源状态'} : value.error || 'Agent 请求失败', response.status === 401 ? 502 : 400);
    return value;
  }
  async snapshot() {
    if (process.env.SAMBA_ENABLED !== 'true') return { enabled: false };
    await this.reconcileRenames();
    const data = await this.agent('/v1/snapshot');
    const [bindings, assayUsers, directoryIdentities] = await Promise.all([
      this.prisma.sambaIdentity.findMany(),
      this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
      process.env.DIRECTORY_AUTH_ENABLED === 'true' ? this.prisma.directoryIdentity.findMany({ select: { userId: true } }) : Promise.resolve<{ userId: string }[]>([]),
    ]);
    return { enabled: true, ...data, bindings: bindings.map(b => ({ ...b, directoryManaged: directoryIdentities.some(i => i.userId === b.userId) })), assayUsers };
  }
  async directories(input: unknown, acl = false) {
    const parsed = directoryPath.safeParse(input);
    if (!parsed.success) throw new BadRequestException('目录参数无效');
    return this.agent(`/v1/${acl ? 'acl' : 'directories'}?${new URLSearchParams(parsed.data).toString()}`);
  }
  async dns(zone?: string) {
    if (process.env.SAMBA_ENABLED !== 'true') throw new ServiceUnavailableException('Samba 管理未启用');
    return this.agent(zone ? `/v1/dns/records?zone=${encodeURIComponent(zone)}` : '/v1/dns/zones');
  }
  async sessions() {
    if (process.env.SAMBA_ENABLED !== 'true') throw new ServiceUnavailableException('Samba 管理未启用');
    return this.agent('/v1/sessions');
  }
  async history() {
    return this.prisma.sambaOperation.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, actorName: true, action: true, metadata: true, state: true, result: true, createdAt: true } });
  }
  async operation(id: string) {
    const op = await this.prisma.sambaOperation.findUnique({ where: { id } });
    if (!op) throw new BadRequestException('操作不存在');
    if (['pending', 'queued', 'running', 'uncertain'].includes(op.state) && !op.action.startsWith('identity.') && !op.action.startsWith('file.')) {
      try {
        const r = await this.agent(`/v1/operations/${encodeURIComponent(id)}`,undefined,5000);
        await this.recordResult(id,r);
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
    // Check deployment policy only for new writes; successful request IDs remain replayable.
    if (action === 'group.create') {
      const policy = await this.agent('/v1/snapshot');
      if (typeof policy.groupPrefix !== 'string' || !Array.isArray(policy.groups) || !Array.isArray(policy.users)) throw new ServiceUnavailableException({ code: 'SAMBA_GROUP_POLICY_UNAVAILABLE', message: '无法读取用户组命名规则' });
      if (!(args.name as string).startsWith(policy.groupPrefix)) throw new BadRequestException({ code: 'SAMBA_GROUP_PREFIX_REQUIRED', message: '用户组名称不符合配置的前缀要求', groupPrefix: policy.groupPrefix });
      if (policy.users.some((account: { name: string }) => account.name.toLowerCase() === (args.name as string).toLowerCase())) throw new ConflictException({ code: 'SAMBA_GROUP_ACCOUNT_NAME_EXISTS', message: '名称已被员工账号占用；AD 账号与用户组不能重名' });
      if (policy.groups.some((group: { name: string }) => group.name.toLowerCase() === (args.name as string).toLowerCase())) throw new ConflictException({ code: 'SAMBA_GROUP_NAME_EXISTS', message: '用户组名称已存在' });
    }
    try {
      await this.prisma.$transaction(tx => this.appendOperation(tx, { id: requestId, actorId: user.id, actorName: user.name, action, requestHash: hash, metadata: metadata(args) as any }));
    } catch (e: any) { if (e.code === 'P2002') throw new ConflictException('操作已提交，请查看操作记录'); throw e; }
    let result: any;
    try { result = await this.agent('/v1/commands', { request_id: requestId, action, args }); }
    catch (e) {
      await this.prisma.sambaOperation.update({ where: { id: requestId }, data: { state: 'uncertain', result: { error: '未收到执行结果，请核对操作记录与资源状态' } } });
      throw e;
    }
    const op = await this.recordResult(requestId,result);
    if (!['succeeded', 'queued', 'running'].includes(result.state)) throw new BadRequestException({ message: result.error || '操作未完成', code: result.error_code, operationId: requestId, state: result.state });
    return op;
  }
  /** 批量开户：逐行复用单条 command 流程，每行独立幂等键与审计记录，互不阻断 */
  async bulkCreate(user: AuthUser, input: unknown) {
    const p = bulkCreateSchema.safeParse(input);
    if (!p.success) throw new BadRequestException('批量导入参数无效（1–100 行，登录账号不能重复）');
    const results: { row: string; operationId: string; state: string; ok: boolean; error?: string }[] = [];
    for (const row of p.data.rows) {
      const requestId = crypto.randomUUID();
      try {
        const op = await this.command(user, { requestId, action: 'user.create', args: row });
        results.push({ row: row.name, operationId: requestId, state: op.state, ok: ['succeeded', 'queued', 'running'].includes(op.state) });
      } catch (e: any) {
        const message = e?.response?.message ?? e?.response?.data?.message ?? e?.message ?? '创建失败';
        results.push({ row: row.name, operationId: requestId, state: 'failed', ok: false, error: Array.isArray(message) ? message.join('；') : typeof message === 'string' ? message : JSON.stringify(message) });
      }
    }
    return { total: results.length, created: results.filter(r => r.ok).length, results };
  }
  async command(user: AuthUser, input: unknown) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('操作参数无效');
    const { requestId, action, args } = parsed.data;
    const validated = actions[action].safeParse(args);
    if (!validated.success) {
      if(action.endsWith('.rename'))throw new BadRequestException({code:'RENAME_INVALID_NAME',message:'重命名参数无效，请核对名称并刷新后重试'});
      if (action === 'group.create' && validated.error.issues.some(issue => issue.path[0] === 'name'))
        throw new BadRequestException({ code: 'SAMBA_GROUP_NAME_INVALID', message: '完整组名需为 2–48 个字符，以小写字母开头，仅包含小写字母、数字、下划线或短横线' });
      if (['user.create', 'user.password'].includes(action) && validated.error.issues.some(issue => issue.path[0] === 'password'))
        throw new BadRequestException('新的 AD 密码需为 8–512 个字符，且不能包含空字符。');
      throw new BadRequestException('操作参数无效');
    }
    if (action === 'group.create' && ['administrator', 'krbtgt', 'guest', 'domain_admins', 'sysvol', 'netlogon'].includes((validated.data as { name: string }).name))
      throw new BadRequestException({ code: 'SAMBA_GROUP_NAME_PROTECTED', message: '该名称为系统保留名，请使用其他用户组名称' });
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
        if (process.env.DIRECTORY_AUTH_ENABLED === 'true') {
          const directory = await tx.directoryIdentity.findUnique({ where: { userId: p.data.userId } });
          if (directory && directory.objectId !== p.data.adObjectId) throw new ConflictException('此账号已使用 AD 统一登录，不能直接解除或更换其文件身份');
        }
        if (identity) await tx.sambaIdentity.upsert({ where: { userId: p.data.userId }, create: { userId: p.data.userId, ...identity }, update: identity });
        else await tx.sambaIdentity.deleteMany({ where: { userId: p.data.userId } });
        await this.appendOperation(tx, { id: crypto.randomUUID(), actorId: user.id, actorName: user.name, action: identity ? 'identity.bind' : 'identity.unbind', requestHash: '-', state: 'succeeded', metadata: { userId: p.data.userId, adObjectId: p.data.adObjectId } });
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
    if (!account || normalizedDomainDN(data.domain) !== normalizedDomainDN(link.domain)) throw new ForbiddenException('关联的 AD 员工账号不可用');
    const active = data.shares.filter((s: any) => s.active && s.ready !== false && s.browseable !== false);
    return {
      identity: { id: account.id as string, name: account.name as string, dn: account.dn as string },
      domain: link.domain,
      // Restrict employee access to active shares explicitly managed by Assay.
      shares: active.map((s: any) => s.name as string),
      sharePolicies: Object.fromEntries(active.map((s: any) => [s.name, createHash('sha256').update(JSON.stringify({ groups: s.groups.map((name:string)=>data.groups?.find((group:any)=>group.name===name)?.sid||name).sort(), readOnly: s.read_only })).digest('hex')])) as Record<string, string>,
    };
  }
  async selfPassword(user: AuthUser, input: unknown) {
    const p = selfPasswordSchema.safeParse(input);
    if (!p.success) throw new BadRequestException('密码参数无效');
    const link = await this.prisma.sambaIdentity.findUnique({ where: { userId: user.id } });
    if (!link) throw new ForbiddenException('尚未绑定 AD 身份');
    const snapshot = await this.agent('/v1/snapshot');
    if (normalizedDomainDN(snapshot.domain) !== normalizedDomainDN(link.domain) || !snapshot.users.some((u: any) => u.id === link.adObjectId && !u.disabled)) throw new ForbiddenException('绑定身份不可用');
    return this.submit(user, p.data.requestId, 'user.change_password', { id: link.adObjectId, old_password: p.data.old_password, password: p.data.password });
  }
}

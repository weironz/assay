import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CurrentUser, RequirePermissions } from './decorators';
import type { AuthUser } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { StepUpService } from './step-up.service';
import { directoryClient, directorySettings, resolveDirectoryIdentity } from './directory-runtime';
import { DirectoryUnavailable } from './directory-client';
import { SYSTEM_ROLE_DESCRIPTIONS } from './role-policy';
import { DIRECTORY_MAPPABLE_ROLES, directoryRolesForGroups } from './directory-role-policy';

const mappingSchema = z.object({ groupSid: z.string().regex(/^S-1-\d+(?:-\d+){1,15}$/).max(200), roleName: z.enum(DIRECTORY_MAPPABLE_ROLES) }).strict();
@Controller('directory')
@RequirePermissions('user:manage')
export class DirectoryController {
  constructor(private readonly prisma: PrismaService, private readonly stepUp: StepUpService) {}
  @Get('settings') async settings() {
    const settings = directorySettings;
    return {
      enabled: !!settings, name: settings?.name || null, domain: settings?.domain || null,
      autoProvision: settings?.autoProvision || false,
      mappings: settings ? await this.prisma.directoryGroupRole.findMany({ where: { providerId: settings.providerId }, orderBy: [{ groupName: 'asc' }, { roleName: 'asc' }] }) : [],
      roles: DIRECTORY_MAPPABLE_ROLES.map(name => ({ name, label: SYSTEM_ROLE_DESCRIPTIONS[name] })),
      users: settings ? await this.prisma.user.findMany({ where: { status: 'ACTIVE', directoryIdentity: null }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }) : [],
    };
  }
  @Get('groups') async groups() {
    if (!directoryClient) return [];
    try { return await directoryClient.groups(); }
    catch { throw new ServiceUnavailableException('无法读取 AD 用户组，请核对目录连接配置'); }
  }
  @Post('identities') @RequirePermissions('role:manage')
  async link(@Req() req: Request, @CurrentUser() actor: AuthUser, @Body() body: unknown) {
    if (!directoryClient) throw new BadRequestException('AD 登录未启用');
    const parsed = z.object({ userId: z.string().min(1).max(128), username: z.string().trim().min(1).max(254) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('请选择业务账号并填写公司账号');
    let profile;
    try { profile = await directoryClient.findAccount(parsed.data.username); }
    catch (e) { if (e instanceof DirectoryUnavailable) throw new ServiceUnavailableException('目录暂时不可用'); throw new BadRequestException('公司账号不存在或不可用'); }
    await this.stepUp.consume(req, actor, 'roles');
    try { await resolveDirectoryIdentity(this.prisma, profile, { userId: parsed.data.userId, actorId: actor.id, actorName: actor.name }); }
    catch { throw new ConflictException('无法关联，请核对业务账号状态以及现有身份关联'); }
    return { ok: true };
  }
  @Post('mappings') @RequirePermissions('role:manage')
  async create(@Req() req: Request, @CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.change(req, actor, body, false); }
  @Delete('mappings') @RequirePermissions('role:manage')
  async remove(@Req() req: Request, @CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.change(req, actor, body, true); }
  private async change(req: Request, actor: AuthUser, body: unknown, remove: boolean) {
    if (!directorySettings || !directoryClient) throw new BadRequestException('AD 登录未启用');
    const parsed = mappingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('用户组或业务角色无效');
    const { groupSid, roleName } = parsed.data;
    let groupName = '';
    if (!remove) {
      let groups: { sid: string; name: string }[];
      try { groups = await directoryClient.groups(); }
      catch { throw new ServiceUnavailableException('目录暂时不可用'); }
      const group = groups.find(g => g.sid === groupSid);
      if (!group) throw new BadRequestException('AD 用户组不存在');
      groupName = group.name;
    }
    await this.stepUp.consume(req, actor, 'roles');
    const key = { providerId: directorySettings.providerId, groupSid, roleName };
    await this.prisma.$transaction(async tx => {
      if (remove) await tx.directoryGroupRole.deleteMany({ where: key });
      else await tx.directoryGroupRole.upsert({ where: { providerId_groupSid_roleName: key }, create: { ...key, groupName }, update: { groupName } });
      // Reflect revocations in directory-derived role displays/assignee lists immediately.
      const identities = await tx.directoryIdentity.findMany({ where: { providerId: key.providerId } });
      const mappings = await tx.directoryGroupRole.findMany({ where: { providerId: key.providerId } });
      for (const identity of identities) {
        const roleNames = directoryRolesForGroups(mappings, identity.groupSids);
        await tx.directoryIdentity.update({ where: { userId: identity.userId }, data: { roleNames } });
      }
      await tx.sambaOperation.create({ data: { id: randomUUID(), actorId: actor.id, actorName: actor.name, action: remove ? 'directory.role.unmap' : 'directory.role.map', requestHash: '-', metadata: key, state: 'succeeded' } });
    });
    return { ok: true };
  }
}

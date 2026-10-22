import { hasPrivilegedRole } from './role-policy';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { auth } from './auth';
import { AuthUser } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { verifyDirectoryPassword } from './directory-runtime';
import { getConfig } from '../config';
import {
  checkStepUpRate, consumeStepUp, issueStepUp, privilegedMfaMode,
  reserveTotpCode, releaseSuccessfulStepUpAttempt, StepUpPurpose, STEP_UP_TTL_SECONDS,
} from './step-up-store';

// Authorization comes from the active login session and current route RBAC,
// not a second password/TOTP challenge on each operation.
const SESSION_PURPOSES: StepUpPurpose[] = ['roles', 'api-tokens', 'samba', 'account', 'two-factor'];

@Injectable()
export class StepUpService {
  constructor(private readonly prisma: PrismaService) {}

  private async session(req: Request, user: AuthUser) {
    if (user.authType !== 'session' || req.headers.authorization) {
      throw new UnauthorizedException('安全验证仅支持网页登录会话');
    }
    const current = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!current?.session || current.user.id !== user.id) throw new UnauthorizedException('会话无效');
    return current.session;
  }

  async status(req: Request, user: AuthUser) {
    await this.session(req, user);
    const privileged = hasPrivilegedRole(user.roles);
    const enrollmentRequired = privileged && privilegedMfaMode() === 'enforce' && !user.twoFactorEnabled;
    return {
      privilegedMfaMode: privilegedMfaMode(),
      privileged,
      enrolled: user.twoFactorEnabled,
      passwordSource: user.passwordSource || 'local',
      enrollmentRequired,
      stepUpTtlSeconds: STEP_UP_TTL_SECONDS,
      purposes: ['roles', 'api-tokens', 'two-factor', 'account', 'samba'],
      stepUpExemptPurposes: !enrollmentRequired ? SESSION_PURPOSES : [],
    };
  }

  async issue(req: Request, user: AuthUser, body: { password: string; code?: string; purpose: StepUpPurpose }) {
    const session = await this.session(req, user);
    await checkStepUpRate(user.id);
    const headers = fromNodeHeaders(req.headers);
    try {
      if (user.passwordSource === 'directory') await verifyDirectoryPassword(this.prisma, user.id, body.password);
      else await auth.api.verifyPassword({ headers, body: { password: body.password } });
    } catch {
      throw new UnauthorizedException('安全验证失败');
    }
    await this.verifySecondFactor(req, user, body.code);
    await releaseSuccessfulStepUpAttempt(user.id);
    return {
      stepUpToken: await issueStepUp(user.id, session.token, body.purpose),
      expiresInSeconds: STEP_UP_TTL_SECONDS,
    };
  }

  // The AD self-change operation verifies the form's old password itself.
  // Keep Web-session, origin and throttling checks without asking
  // for the same password again (or for a separate local Assay password).
  async preparePasswordChange(req: Request, user: AuthUser, _code?: string) {
    await this.session(req, user);
    const origins = getConfig().auth.trustedOrigins;
    if (!req.headers.origin || !origins.includes(req.headers.origin)) {
      throw new ForbiddenException('密码修改来源校验失败');
    }
    await checkStepUpRate(user.id);
  }

  private async verifySecondFactor(req: Request, user: AuthUser, code?: string) {
    const headers = fromNodeHeaders(req.headers);
    const actual = await this.prisma.user.findUnique({
      where: { id: user.id }, select: { twoFactorEnabled: true, status: true },
    });
    if (!actual || actual.status !== 'ACTIVE') throw new UnauthorizedException('账号无效');
    if (privilegedMfaMode() === 'enforce' && hasPrivilegedRole(user.roles) && !actual.twoFactorEnabled) {
      throw new ForbiddenException('请先启用并验证 TOTP，之后才能执行敏感操作');
    }
    if (actual.twoFactorEnabled) {
      if (!code || !/^\d{6}$/.test(code)) throw new UnauthorizedException('需要六位 TOTP 验证码');
      const factor = await this.prisma.twoFactor.findUnique({ where: { userId: user.id }, select: { verified: true } });
      if (!factor?.verified) throw new ForbiddenException('TOTP 状态异常，请联系管理员');
      try {
        await auth.api.verifyTOTP({ headers, body: { code: code, trustDevice: false } });
      } catch {
        throw new UnauthorizedException('安全验证失败');
      }
      await reserveTotpCode(user.id, code);
    }
  }

  async consume(req: Request, user: AuthUser, purpose: StepUpPurpose) {
    const session = await this.session(req, user);
    if (req.headers['x-step-up-token'] === undefined) {
      // The session and current RBAC are checked by the guards. A trusted Origin
      // still prevents another site from submitting cookie-authenticated writes.
      const origins = getConfig().auth.trustedOrigins;
      if (!req.headers.origin || !origins.includes(req.headers.origin)) {
        throw new ForbiddenException('操作来源校验失败');
      }
      return;
    }
    // Existing clients that explicitly supply a proof keep the one-use contract.
    await consumeStepUp(req.headers['x-step-up-token'], user.id, session.token, purpose);
  }
}

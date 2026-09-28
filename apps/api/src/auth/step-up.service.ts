import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { auth } from './auth';
import { AuthUser } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkStepUpRate, consumeStepUp, issueStepUp, privilegedMfaMode,
  reserveTotpCode, StepUpPurpose, STEP_UP_TTL_SECONDS,
} from './step-up-store';

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
    const privileged = user.roles.some((role) => role === 'admin' || role === 'supervisor');
    return {
      privilegedMfaMode: privilegedMfaMode(),
      privileged,
      enrolled: user.twoFactorEnabled,
      enrollmentRequired: privileged && privilegedMfaMode() === 'enforce' && !user.twoFactorEnabled,
      stepUpTtlSeconds: STEP_UP_TTL_SECONDS,
      purposes: ['roles', 'api-tokens', 'two-factor', 'account'],
    };
  }

  async issue(req: Request, user: AuthUser, body: { password: string; code?: string; purpose: StepUpPurpose }) {
    const session = await this.session(req, user);
    await checkStepUpRate(user.id);
    const headers = fromNodeHeaders(req.headers);
    try {
      await auth.api.verifyPassword({ headers, body: { password: body.password } });
    } catch {
      throw new UnauthorizedException('安全验证失败');
    }
    const actual = await this.prisma.user.findUnique({
      where: { id: user.id }, select: { twoFactorEnabled: true, status: true },
    });
    if (!actual || actual.status !== 'ACTIVE') throw new UnauthorizedException('账号无效');
    if (privilegedMfaMode() === 'enforce' && user.roles.some((r) => r === 'admin' || r === 'supervisor') && !actual.twoFactorEnabled) {
      throw new ForbiddenException('请先启用并验证 TOTP，之后才能执行敏感操作');
    }
    if (actual.twoFactorEnabled) {
      if (!body.code || !/^\d{6}$/.test(body.code)) throw new UnauthorizedException('需要六位 TOTP 验证码');
      const factor = await this.prisma.twoFactor.findUnique({ where: { userId: user.id }, select: { verified: true } });
      if (!factor?.verified) throw new ForbiddenException('TOTP 状态异常，请联系管理员');
      try {
        await auth.api.verifyTOTP({ headers, body: { code: body.code, trustDevice: false } });
      } catch {
        throw new UnauthorizedException('安全验证失败');
      }
      await reserveTotpCode(user.id, body.code);
    }
    return {
      stepUpToken: await issueStepUp(user.id, session.token, body.purpose),
      expiresInSeconds: STEP_UP_TTL_SECONDS,
    };
  }

  async consume(req: Request, user: AuthUser, purpose: StepUpPurpose) {
    const session = await this.session(req, user);
    await consumeStepUp(req.headers['x-step-up-token'], user.id, session.token, purpose);
  }
}

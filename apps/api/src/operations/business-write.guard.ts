import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PlatformService } from './platform.service';

/** Check business access before Multer receives a potentially large upload. */
@Injectable()
export class BusinessWriteGuard implements CanActivate {
  constructor(private readonly platform: PlatformService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    await this.platform.subject(
      request.user,
      request.params.kind,
      request.params.id,
      true,
    );
    return true;
  }
}

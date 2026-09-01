import { Module } from '@nestjs/common';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const MAX_BYTES = 2 * 1024 * 1024;
/** 只允许 {userId}.{ext} 形式，避免路径穿越 */
const FILE_RE = /^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/;

@Controller()
class ProfileController {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  /** 上传/更换头像；返回 URL，由前端再调 better-auth updateUser 写入 user.image */
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('未收到文件');
    const ext = EXT_BY_MIME[file.mimetype];
    if (!ext) throw new BadRequestException('仅支持 PNG / JPG / GIF / WEBP 图片');
    if (file.size > MAX_BYTES) throw new BadRequestException('头像不能超过 2MB');

    const fileName = `${user.id}.${ext}`;
    await this.storage.put({
      key: `avatars/${fileName}`,
      body: file.buffer,
      contentType: file.mimetype,
    });
    // 加版本号避免浏览器缓存旧头像
    return { url: `/api/avatars/${fileName}?v=${Date.now()}` };
  }

  @Get('avatars/:file')
  async serve(@Param('file') file: string, @Res() res: Response) {
    if (!FILE_RE.test(file)) throw new BadRequestException('非法的头像地址');
    const ext = file.split('.').pop()!;
    let body: Buffer;
    try {
      body = await this.storage.get(`avatars/${file}`);
    } catch {
      throw new NotFoundException('头像不存在');
    }
    res.setHeader('Content-Type', MIME_BY_EXT[ext]);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(body);
  }
}

@Module({
  controllers: [ProfileController],
})
export class ProfileModule {}

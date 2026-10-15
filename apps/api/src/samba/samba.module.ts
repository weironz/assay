import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SambaController } from './samba.controller';
import { SambaService } from './samba.service';
@Module({ imports: [AuthModule], controllers: [SambaController], providers: [SambaService], exports: [SambaService] })
export class SambaModule {}

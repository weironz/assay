import { Module } from '@nestjs/common';
import { SambaModule } from '../samba/samba.module';
import { FilesController, ModulesController } from './files.controller';
import { FilesService } from './files.service';
@Module({ imports: [SambaModule], controllers: [FilesController, ModulesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}

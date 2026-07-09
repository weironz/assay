import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthBootstrapService } from './auth-bootstrap.service';

@Global()
@Module({
  providers: [AuthService, AuthBootstrapService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}

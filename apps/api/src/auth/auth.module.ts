import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthBootstrapService } from './auth-bootstrap.service';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

@Global()
@Module({
  imports: [ApiTokensModule],
  providers: [AuthService, AuthBootstrapService, StepUpService],
  controllers: [AuthController, StepUpController],
  exports: [AuthService, StepUpService],
})
export class AuthModule {}

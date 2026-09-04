import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

/**
 * `toUserDto` is imported directly from `UsersService`'s module file as a
 * plain function (not a Nest provider), so this module has no DI dependency
 * on `UsersModule` — importing it here would only add coupling risk with no
 * benefit.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService],
})
export class AuthModule {}

import { randomBytes } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  loginSchema,
  mfaExchangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshTokenSchema,
  registerSchema,
} from '@audio-book/contracts';
import type { ApiConfig } from '@audio-book/config';
import { AuthenticationError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_CONFIG } from '../common/tokens.js';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { toUserDto } from '../users/users.service.js';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearedCookie,
  parseCookies,
  serializeCookie,
} from './cookies.js';
import { decodeSessionId } from './token.service.js';
import { AuthService, type LoginBody, type RegisterBody } from './auth.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

const CSRF_HEADER = 'x-csrf-token';

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * `api-specification.md` §16.1 — token issuance. Unauthenticated by design
 * (these endpoints *establish* identity), so `JwtAuthGuard` never appears in
 * this controller's guard list except on `/logout`, which acts on an
 * already-authenticated principal's own session.
 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('register')
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  async register(
    @Body(new AjvValidationPipe(registerSchema)) body: RegisterBody,
  ): Promise<unknown> {
    const result = await this.auth.register(body);
    if (result.status === 'REGISTRATION_PENDING') {
      // §16.1 enumeration protection: identical shape/status whether the
      // email was new or already registered — see AuthService.register.
      return { data: { status: 'REGISTRATION_PENDING' } };
    }
    return { data: { user: toUserDto(result.user), tenant_id: result.tenantId } };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new AjvValidationPipe(loginSchema)) body: LoginBody,
  ): Promise<unknown> {
    const result = await this.auth.login(body, requestMeta(request));
    if (result.status === 'MFA_REQUIRED') {
      return { data: { status: 'MFA_REQUIRED', mfa_token: result.mfaToken } };
    }
    return this.respondAuthenticated(reply, body.client_type, result);
  }

  @Post('mfa')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async mfa(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new AjvValidationPipe(mfaExchangeSchema)) body: { mfa_token: string; code: string },
  ): Promise<unknown> {
    const result = await this.auth.exchangeMfa(body.mfa_token, body.code, requestMeta(request));
    // The exchanged session's client type was recorded at /auth/login time;
    // this endpoint always issues bearer tokens in the body, matching the
    // API-client shape, since a cookie-based browser session already
    // completed its cookie exchange at /auth/login before MFA (this
    // deployment's MFA is unreachable today — see totp.ts — so there is no
    // real client to diverge on).
    return this.respondAuthenticated(reply, 'API', result);
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new AjvValidationPipe(refreshTokenSchema)) body: { refresh_token?: string },
  ): Promise<unknown> {
    const cookies = parseCookies(request.headers.cookie);
    const cookieRefreshToken = cookies[SESSION_COOKIE_NAME];

    let clientType: 'API' | 'BROWSER';
    let refreshTokenPlain: string;
    if (body.refresh_token) {
      clientType = 'API';
      refreshTokenPlain = body.refresh_token;
    } else if (cookieRefreshToken) {
      assertCsrf(request, cookies);
      clientType = 'BROWSER';
      refreshTokenPlain = cookieRefreshToken;
    } else {
      throw new AuthenticationError({ message: 'No refresh token presented.' });
    }

    const result = await this.auth.refresh(refreshTokenPlain);
    return this.respondAuthenticated(reply, clientType, result);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  async logout(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const principal = request.principal;
    if (!principal) throw new AuthenticationError({ message: 'Missing bearer token.' });
    const bearer = authorization?.slice('Bearer '.length);
    const sessionId = bearer ? decodeSessionId(bearer) : undefined;
    await this.auth.logout(principal.sub, sessionId);

    const secure = this.config.app.nodeEnv === 'production';
    void reply.header('Set-Cookie', clearedCookie(SESSION_COOKIE_NAME, { secure }));
    void reply.header('Set-Cookie', clearedCookie(CSRF_COOKIE_NAME, { secure }));
  }

  @Post('password-reset')
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  async requestPasswordReset(
    @Body(new AjvValidationPipe(passwordResetRequestSchema)) body: { email: string },
  ): Promise<unknown> {
    await this.auth.requestPasswordReset(body.email);
    return { data: { status: 'ACCEPTED' } };
  }

  @Post('password-reset/confirm')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  async confirmPasswordReset(
    @Body(new AjvValidationPipe(passwordResetConfirmSchema))
    body: { reset_token: string; new_password: string },
  ): Promise<void> {
    await this.auth.confirmPasswordReset(body.reset_token, body.new_password);
  }

  private respondAuthenticated(
    reply: FastifyReply,
    clientType: 'API' | 'BROWSER',
    result: { accessToken: string; expiresIn: number; refreshToken: string },
  ): unknown {
    if (clientType === 'BROWSER') {
      const secure = this.config.app.nodeEnv === 'production';
      const maxAgeSeconds = this.config.authPolicy.refreshTokenTtlSeconds;
      void reply.header(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE_NAME, result.refreshToken, { httpOnly: true, secure, maxAgeSeconds }),
      );
      void reply.header(
        'Set-Cookie',
        serializeCookie(CSRF_COOKIE_NAME, randomToken(), { httpOnly: false, secure, maxAgeSeconds }),
      );
      // §16.1: "No tokens in the body" for BROWSER clients.
      return { data: { status: 'AUTHENTICATED' } };
    }
    return {
      data: {
        status: 'AUTHENTICATED',
        access_token: result.accessToken,
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        token_type: 'Bearer' as const,
      },
    };
  }
}

function requestMeta(request: FastifyRequest): { userAgentFamily?: string; ipCountry?: string } {
  const ua = request.headers['user-agent'];
  return {
    // A coarse family, not the raw string — §16.2's session listing is
    // explicit that raw user-agent/IP are never stored, only derived,
    // low-cardinality fields.
    userAgentFamily: typeof ua === 'string' ? ua.split('/')[0]?.slice(0, 64) : undefined,
    ipCountry: undefined, // No IP geolocation service is wired into this deployment.
  };
}

/** Double-submit CSRF check for cookie-authenticated `/auth/refresh` (browser path only). */
function assertCsrf(request: FastifyRequest, cookies: Record<string, string>): void {
  const header = request.headers[CSRF_HEADER];
  const cookieValue = cookies[CSRF_COOKIE_NAME];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (!cookieValue || !headerValue || headerValue !== cookieValue) {
    throw new AuthenticationError({ code: 'CSRF_TOKEN_MISMATCH', message: 'Missing or invalid CSRF token.' });
  }
}

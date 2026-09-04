import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { ApiConfig } from '@audio-book/config';
import type { PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { AuthenticationError, ConflictError, QuotaExceededError, ValidationError } from '@audio-book/errors';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { Redis } from 'ioredis';
import { API_CONFIG, LOGGER, PRISMA, REDIS } from '../common/tokens.js';
import { AuditService } from '../common/audit.service.js';
import type { UserRow } from '../users/users.service.js';
import { TokenService } from './token.service.js';
import { verifyTotp } from './totp.js';

const PRODUCER = 'api';
const PRODUCER_VERSION = '1.0.0';
const MFA_TOKEN_TTL_SECONDS = 300;
const PASSWORD_RESET_TOKEN_TTL_SECONDS = 1800;
/**
 * A user with no credential (never should happen — every User row has a 1:1
 * UserCredential) or an unknown email still pays the cost of a hash
 * comparison, so that "unknown account" and "wrong password" take
 * indistinguishable time (`api-specification.md` §14.11/§16.1). The value
 * itself is meaningless; it is never a valid PHC string an attacker could
 * target.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface RegisterBody {
  email: string;
  password: string;
  display_name?: string | null;
}

export interface LoginBody {
  email: string;
  password: string;
  client_type: 'BROWSER' | 'API';
}

export interface RequestMeta {
  userAgentFamily?: string;
  ipCountry?: string;
}

export type AuthenticatedResult = {
  status: 'AUTHENTICATED';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  sessionId: string;
};

export type MfaRequiredResult = { status: 'MFA_REQUIRED'; mfaToken: string };

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

interface UserWithCredential {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  credential: {
    passwordHash: string;
    mfaEnrolled: boolean;
    mfaSecretRef: string | null;
    failedAttemptCount: number;
    lockedUntil: Date | null;
  } | null;
}

/**
 * Token *issuance* business logic — registration, login, MFA exchange,
 * refresh rotation, logout, and password reset
 * (`api-specification.md` §16.1). `JwtAuthGuard` remains the sole
 * *verification* path; nothing here changes how any existing route
 * authenticates a bearer token.
 *
 * Every table this touches (`user`, `user_credential`, `user_identity`,
 * `session`, `refresh_token`) already existed in the schema with zero
 * writers before this phase (`docs/qa/phase-8-report.md` P8-8) — this is
 * that writer.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `api-specification.md` §16.1. "No tokens are issued: registration and
   * login are separate." Enumeration protection (`configuration`, default
   * on) means a duplicate email must be **indistinguishable** from a new one
   * at the response level — not just "don't say which is which" but
   * genuinely the same status/shape either way, so a client cannot use this
   * endpoint to test whether an address has an account.
   */
  async register(
    body: RegisterBody,
  ): Promise<{ status: 'REGISTRATION_PENDING' } | { status: 'CREATED'; user: UserRow; tenantId: string }> {
    const email = normalizeEmail(body.email);
    if (body.password.length < this.config.authPolicy.passwordMinLength) {
      throw new ValidationError({
        message: `password must be at least ${this.config.authPolicy.passwordMinLength} characters.`,
        details: [{ field: 'password', issue: 'too_short' }],
      });
    }

    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) {
      if (this.config.authPolicy.enumerationProtection) {
        // Do the same shape of work a real registration would, so the
        // response is not distinguishable by timing either.
        await argon2Hash(body.password);
        return { status: 'REGISTRATION_PENDING' };
      }
      throw new ConflictError({
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'This email address is already registered.',
        details: [{ field: 'email', issue: 'duplicate' }],
      });
    }

    const passwordHash = await argon2Hash(body.password);
    const tenantId = generateId();
    const userId = generateId();
    const now = new Date();
    const displayName = body.display_name?.trim() || email;
    let createdUser: UserRow | undefined;

    try {
      await withTransaction(this.prisma, async (tx) => {
        await tx.tenant.create({
          data: { id: tenantId, name: displayName, status: 'ACTIVE', planCode: 'default' },
        });
        createdUser = await tx.user.create({
          data: {
            id: userId,
            tenantId,
            email,
            displayName,
            status: 'ACTIVE',
            roles: ['TENANT_OWNER'],
            preferences: {},
          },
        });
        await tx.userCredential.create({
          data: {
            id: generateId(),
            userId,
            passwordHash,
            passwordAlgorithm: 'argon2id',
            passwordUpdatedAt: now,
            mfaEnrolled: false,
            failedAttemptCount: 0,
          },
        });

        const correlationId = generateId();
        // `event-contracts.md`'s closed 36-event catalogue does not yet list
        // an auth-domain event, even though `context.md` §3.2.2 names
        // `user.registered` as an Auth Service output — a documented,
        // narrow gap (see docs/application/identity-and-account-architecture.md
        // and the Phase 10 report), not an invented replacement: this uses
        // the exact envelope/naming convention every other event already
        // uses, and `OutboxPublisher` already durably records and
        // acknowledges event types it has no downstream consumer for.
        await writeOutboxMessage(tx, {
          eventType: 'user.registered',
          schemaVersion: '1.0',
          tenantId,
          correlationId,
          causationId: correlationId,
          producer: PRODUCER,
          producerVersion: PRODUCER_VERSION,
          aggregateType: 'user',
          aggregateId: userId,
          payload: { user_id: userId, tenant_id: tenantId },
        });

        await this.audit.recordIn(tx, {
          principal: { sub: userId, tenantId, roles: ['TENANT_OWNER'], scopes: [] },
          action: 'USER_REGISTERED',
          resourceType: 'user',
          resourceId: userId,
          tenantId,
        });
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Lost a race with a concurrent registration of the same email.
        if (this.config.authPolicy.enumerationProtection) {
          return { status: 'REGISTRATION_PENDING' };
        }
        throw new ConflictError({
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'This email address is already registered.',
          details: [{ field: 'email', issue: 'duplicate' }],
        });
      }
      throw err;
    }

    if (!createdUser) {
      throw new Error('User row was not created within the registration transaction.');
    }
    return { status: 'CREATED', user: createdUser, tenantId };
  }

  /** `api-specification.md` §16.1 login. */
  async login(body: LoginBody, meta: RequestMeta): Promise<LoginResult> {
    const email = normalizeEmail(body.email);
    const user = (await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      include: { credential: true },
    })) as UserWithCredential | null;

    if (!user || !user.credential || user.status !== 'ACTIVE') {
      await argon2Verify(DUMMY_PASSWORD_HASH, body.password).catch(() => false);
      throw new AuthenticationError({ message: 'Invalid email or password.' });
    }

    if (user.credential.lockedUntil && user.credential.lockedUntil.getTime() > Date.now()) {
      throw new QuotaExceededError({
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed sign-in attempts. Try again later.',
        retryable: true,
      });
    }

    const valid = await argon2Verify(user.credential.passwordHash, body.password).catch(() => false);
    if (!valid) {
      await this.recordFailedAttempt(user.id, user.credential.failedAttemptCount);
      throw new AuthenticationError({ message: 'Invalid email or password.' });
    }

    await this.prisma.userCredential.update({
      where: { userId: user.id },
      data: { failedAttemptCount: 0, lockedUntil: null },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    if (user.credential.mfaEnrolled) {
      // Reachable only once a future phase adds MFA enrollment — no code
      // path in this deployment ever sets `mfaEnrolled: true` today. Kept
      // real rather than stubbed so `/auth/mfa` has a correct partner.
      const mfaToken = randomBytes(32).toString('base64url');
      await this.redis.set(
        `mfa:${sha256(mfaToken)}`,
        JSON.stringify({ userId: user.id, clientType: body.client_type }),
        'EX',
        MFA_TOKEN_TTL_SECONDS,
      );
      return { status: 'MFA_REQUIRED', mfaToken };
    }

    return this.issueSession(user.id, user.tenantId, user.roles, meta);
  }

  /** `api-specification.md` §16.1 MFA exchange — see `totp.ts` for why this is unreachable but real today. */
  async exchangeMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<AuthenticatedResult> {
    const raw = await this.redis.get(`mfa:${sha256(mfaToken)}`);
    if (!raw) throw new AuthenticationError({ code: 'MFA_FAILED', message: 'Invalid or expired MFA token.' });
    const { userId } = JSON.parse(raw) as { userId: string; clientType: string };

    const user = (await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { credential: true },
    })) as UserWithCredential | null;
    if (!user?.credential?.mfaSecretRef || !verifyTotp(user.credential.mfaSecretRef, code)) {
      throw new AuthenticationError({ code: 'MFA_FAILED', message: 'Invalid MFA code.' });
    }

    await this.redis.del(`mfa:${sha256(mfaToken)}`);
    return this.issueSession(user.id, user.tenantId, user.roles, meta);
  }

  /**
   * `api-specification.md` §16.1 refresh — rotation with reuse detection.
   * Any use of an already-rotated token revokes the whole family: it means
   * either a client retried a stale response (harmless but still rotates
   * safely) or a token was stolen and used after the legitimate client
   * already moved on (the dangerous case) — the protocol cannot tell these
   * apart, so it treats every reuse as the dangerous case.
   */
  async refresh(refreshTokenPlain: string): Promise<AuthenticatedResult> {
    const tokenHash = sha256(refreshTokenPlain);
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true, session: true },
    });
    if (!row || row.revokedAt || row.session.revokedAt) {
      throw new AuthenticationError({ code: 'TOKEN_REVOKED', message: 'Invalid refresh token.' });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AuthenticationError({ code: 'TOKEN_EXPIRED', message: 'Refresh token has expired.' });
    }
    if (row.rotatedAt) {
      await this.revokeFamily(row.familyId, 'REFRESH_TOKEN_REUSE_DETECTED');
      await this.audit.record({
        principal: { sub: row.userId, tenantId: row.user.tenantId, roles: row.user.roles, scopes: [] },
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        resourceType: 'user',
        resourceId: row.userId,
        outcome: 'FAILURE',
      });
      throw new AuthenticationError({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'This refresh token was already used. The session has been revoked for safety.',
      });
    }

    const newPlain = randomBytes(32).toString('base64url');
    const newTokenId = generateId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.authPolicy.refreshTokenTtlSeconds * 1000);

    await withTransaction(this.prisma, async (tx) => {
      await tx.refreshToken.create({
        data: {
          id: newTokenId,
          sessionId: row.sessionId,
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: sha256(newPlain),
          issuedAt: now,
          expiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { rotatedAt: now, rotatedToId: newTokenId },
      });
      await tx.session.update({ where: { id: row.sessionId }, data: { lastSeenAt: now } });
    });

    const issued = await this.tokens.issueAccessToken({
      sub: row.userId,
      tenantId: row.user.tenantId,
      roles: row.user.roles,
      scopes: [],
      sessionId: row.sessionId,
    });
    return {
      status: 'AUTHENTICATED',
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      refreshToken: newPlain,
      sessionId: row.sessionId,
    };
  }

  /** §16.1 logout — naturally idempotent (a missing/already-revoked session is a silent no-op, still `204`). */
  async logout(userId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId } });
    if (!session || session.revokedAt) return;

    const now = new Date();
    await withTransaction(this.prisma, async (tx) => {
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: now, revocationReason: 'LOGOUT' },
      });
      await tx.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    await this.audit.record({
      principal: { sub: userId, tenantId: session.tenantId, roles: [], scopes: [] },
      action: 'SESSION_REVOKED',
      resourceType: 'user',
      resourceId: userId,
      metadata: { session_id: sessionId, reason: 'LOGOUT' },
    });
  }

  /**
   * §16.1: "Request → 202 always, regardless of whether the address
   * exists." Email delivery is out of this deployment's reach — there is no
   * Notification Service integration anywhere in this codebase — so the
   * outbox event is written (durable, correct, matches every other
   * fire-and-forget domain event) but nothing sends mail yet. Documented as
   * a known limitation, not silently claimed complete: see the Phase 10
   * report.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findFirst({ where: { email: normalized, deletedAt: null } });
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    await this.redis.set(`pwreset:${sha256(token)}`, user.id, 'EX', PASSWORD_RESET_TOKEN_TTL_SECONDS);

    await withTransaction(this.prisma, (tx) => {
      const correlationId = generateId();
      return writeOutboxMessage(tx, {
        eventType: 'auth.password_reset_requested',
        schemaVersion: '1.0',
        tenantId: user.tenantId,
        correlationId,
        causationId: correlationId,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'user',
        aggregateId: user.id,
        // Never the token itself — see class docstring on secrets in events/audit.
        payload: { user_id: user.id },
      });
    });
  }

  /** §16.1 confirm — revokes every session/refresh token for the principal. */
  async confirmPasswordReset(resetToken: string, newPassword: string): Promise<void> {
    if (newPassword.length < this.config.authPolicy.passwordMinLength) {
      throw new ValidationError({
        message: `password must be at least ${this.config.authPolicy.passwordMinLength} characters.`,
        details: [{ field: 'new_password', issue: 'too_short' }],
      });
    }
    const key = `pwreset:${sha256(resetToken)}`;
    const userId = await this.redis.get(key);
    if (!userId) {
      throw new AuthenticationError({
        code: 'TOKEN_EXPIRED',
        message: 'Invalid or expired reset token.',
      });
    }

    const passwordHash = await argon2Hash(newPassword);
    const now = new Date();
    await withTransaction(this.prisma, async (tx) => {
      await tx.userCredential.update({
        where: { userId },
        data: {
          passwordHash,
          passwordAlgorithm: 'argon2id',
          passwordUpdatedAt: now,
          failedAttemptCount: 0,
          lockedUntil: null,
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revocationReason: 'PASSWORD_RESET' },
      });
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    });
    await this.redis.del(key);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.audit.record({
        principal: { sub: userId, tenantId: user.tenantId, roles: user.roles, scopes: [] },
        action: 'SESSION_REVOKED',
        resourceType: 'user',
        resourceId: userId,
        metadata: { reason: 'PASSWORD_RESET_ALL_SESSIONS' },
      });
    }
  }

  private async issueSession(
    userId: string,
    tenantId: string,
    roles: string[],
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const sessionId = generateId();
    const now = new Date();
    const refreshTtlMs = this.config.authPolicy.refreshTokenTtlSeconds * 1000;

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
        tenantId,
        expiresAt: new Date(now.getTime() + refreshTtlMs),
        userAgentFamily: meta.userAgentFamily,
        ipCountry: meta.ipCountry,
      },
    });

    const refreshPlain = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        id: generateId(),
        sessionId,
        userId,
        familyId: generateId(),
        tokenHash: sha256(refreshPlain),
        issuedAt: now,
        expiresAt: new Date(now.getTime() + refreshTtlMs),
      },
    });

    const issued = await this.tokens.issueAccessToken({ sub: userId, tenantId, roles, scopes: [], sessionId });

    await this.audit.record({
      principal: { sub: userId, tenantId, roles, scopes: [] },
      action: 'LOGIN_SUCCEEDED',
      resourceType: 'user',
      resourceId: userId,
    });

    return {
      status: 'AUTHENTICATED',
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      refreshToken: refreshPlain,
      sessionId,
    };
  }

  private async recordFailedAttempt(userId: string, currentCount: number): Promise<void> {
    const nextCount = currentCount + 1;
    const { loginMaxFailedAttempts, loginLockoutSeconds } = this.config.authPolicy;
    const lockingNow = nextCount >= loginMaxFailedAttempts;
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        failedAttemptCount: lockingNow ? 0 : nextCount,
        lockedUntil: lockingNow ? new Date(Date.now() + loginLockoutSeconds * 1000) : undefined,
      },
    });
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    const now = new Date();
    const tokens = await this.prisma.refreshToken.findMany({
      where: { familyId },
      select: { sessionId: true },
    });
    const sessionIds = [...new Set(tokens.map((t) => t.sessionId))];
    await withTransaction(this.prisma, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: now, reuseDetectedAt: now },
      });
      if (sessionIds.length > 0) {
        await tx.session.updateMany({
          where: { id: { in: sessionIds }, revokedAt: null },
          data: { revokedAt: now, revocationReason: reason },
        });
      }
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

'use server';

import { redirect } from 'next/navigation';
import { isApiError } from '@/lib/api/errors';
import { safeReturnPath } from '../safe-redirect';
import { login, logout, register } from './auth-client';
import { endSession, readSessionToken, startSession } from './session';

/**
 * Session actions (Phase 10: real registration/login/logout —
 * `api-specification.md` §16.1 — replacing the Phase 9 "paste a token"
 * flow now that `/api/v1/auth/**` exists).
 *
 * Server Actions rather than route handlers: Next verifies the action's own
 * origin, so these POSTs carry CSRF protection without this app inventing a
 * token scheme.
 */

export interface SignInState {
  error: string | null;
}

export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = asString(formData.get('email')).trim();
  const password = asString(formData.get('password'));
  const returnTo = safeReturnPath(asString(formData.get('returnTo')));

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  let result;
  try {
    result = await login(email, password);
  } catch (error) {
    return { error: loginErrorMessage(error) };
  }

  if (result.status === 'MFA_REQUIRED') {
    // No enrollment path exists in this deployment (see
    // docs/application/identity-and-account-architecture.md §4), so a real
    // login can never actually reach this branch today — handled for
    // contract correctness, not because it is reachable.
    return { error: 'This account requires a second factor, which this studio cannot collect yet.' };
  }
  if (!result.access_token) {
    return { error: 'Sign-in did not return a usable session. Try again.' };
  }

  try {
    await startSession(result.access_token);
  } catch {
    // The API accepted the credentials but this app could not verify the
    // token it issued — a key-material mismatch between the two deployments'
    // AUTH_JWT_* configuration, not a user-fixable error.
    return {
      error: 'This studio could not establish a session. Contact an administrator.',
    };
  }
  redirect(returnTo);
}

export interface RegisterState {
  error: string | null;
  submitted: boolean;
}

export async function registerAction(
  _previous: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const email = asString(formData.get('email')).trim();
  const password = asString(formData.get('password'));
  const displayName = asString(formData.get('displayName')).trim();

  if (!email || !password) {
    return { error: 'Enter an email and a password.', submitted: false };
  }

  try {
    await register(email, password, displayName || null);
  } catch (error) {
    if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
      const issues = error.fieldIssues();
      return { error: issues.password ?? 'Check the highlighted fields and try again.', submitted: false };
    }
    return { error: 'Registration could not be completed. Try again in a moment.', submitted: false };
  }

  // §16.1 enumeration protection: the response never distinguishes "created"
  // from "already existed" (both are `REGISTRATION_PENDING`), so this screen
  // cannot either — it sends the user to sign in either way.
  return { error: null, submitted: true };
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) await logout(token);
  await endSession();
  redirect('/sign-in');
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function loginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'ACCOUNT_LOCKED') {
      return 'Too many failed attempts. Try again later.';
    }
    if (error.code === 'UNAUTHENTICATED') {
      return 'Incorrect email or password.';
    }
    if (error.code === 'RATE_LIMITED') {
      return 'Too many attempts. Wait a moment and try again.';
    }
  }
  return 'Sign-in failed. Check your connection and try again.';
}

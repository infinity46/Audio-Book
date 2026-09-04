import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentPrincipal } from '@/lib/server/session';
import { safeReturnPath } from '@/lib/safe-redirect';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  const destination = safeReturnPath(returnTo);

  // Already signed in — do not make the user look at a form they do not need.
  const principal = await currentPrincipal();
  if (principal) redirect(destination);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--accent-text)] uppercase">
          Audiobook Studio
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          Sign in
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          Sign in with your email and password. Your credentials are sent directly to the
          studio&rsquo;s API and never touch this browser&rsquo;s scripts — the resulting session is
          held in a secure, server-side cookie.
        </p>
      </div>
      <SignInForm returnTo={destination} />
    </main>
  );
}

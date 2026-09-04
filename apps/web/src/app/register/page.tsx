import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentPrincipal } from '@/lib/server/session';
import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const principal = await currentPrincipal();
  if (principal) redirect('/');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--accent-text)] uppercase">
          Audiobook Studio
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          Create your workspace
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          Registering creates a new workspace with you as its owner. There is no separate step to
          join an existing workspace yet.
        </p>
      </div>
      <RegisterForm />
    </main>
  );
}

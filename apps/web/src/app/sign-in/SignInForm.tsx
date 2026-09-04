'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { signInAction, type SignInState } from '@/lib/server/actions';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { Panel } from '@/components/ui/Panel';

const INITIAL: SignInState = { error: null };

export function SignInForm({ returnTo }: { returnTo: string }) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL);

  return (
    <Panel className="p-5">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="returnTo" value={returnTo} />
        {state.error ? (
          <p className="text-[13px] font-medium text-[var(--tone-danger)]" role="alert">
            {state.error}
          </p>
        ) : null}
        <Field label="Email">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="email"
              type="email"
              aria-describedby={describedBy}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          )}
        </Field>
        <Field label="Password">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="password"
              type="password"
              aria-describedby={describedBy}
              required
              autoComplete="current-password"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={pending}>
          Sign in
        </Button>
      </form>
      <p className="mt-4 text-center text-[13px] text-[var(--text-secondary)]">
        No account?{' '}
        <Link href="/register" className="font-medium text-[var(--accent-text)] hover:underline">
          Create one
        </Link>
      </p>
    </Panel>
  );
}

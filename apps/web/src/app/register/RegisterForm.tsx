'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { registerAction, type RegisterState } from '@/lib/server/actions';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { Panel } from '@/components/ui/Panel';
import { Notice } from '@/components/ui/States';

const INITIAL: RegisterState = { error: null, submitted: false };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, INITIAL);

  if (state.submitted) {
    return (
      <Panel className="p-5">
        <Notice tone="info" title="Almost there">
          If that email is available, your workspace has been created and you can sign in with it
          now.
        </Notice>
        <Link
          href="/sign-in"
          className="mt-4 block text-center text-[13px] font-medium text-[var(--accent-text)] hover:underline"
        >
          Go to sign in
        </Link>
      </Panel>
    );
  }

  return (
    <Panel className="p-5">
      <form action={formAction} className="space-y-4">
        {state.error ? (
          <p className="text-[13px] font-medium text-[var(--tone-danger)]" role="alert">
            {state.error}
          </p>
        ) : null}
        <Field label="Display name" hint="Shown to anyone you invite to this workspace later.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="displayName"
              type="text"
              aria-describedby={describedBy}
              autoComplete="name"
              maxLength={256}
            />
          )}
        </Field>
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
        <Field label="Password" hint="At least 8 characters.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="password"
              type="password"
              aria-describedby={describedBy}
              required
              minLength={8}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={pending}>
          Create workspace
        </Button>
      </form>
      <p className="mt-4 text-center text-[13px] text-[var(--text-secondary)]">
        Already have an account?{' '}
        <Link href="/sign-in" className="font-medium text-[var(--accent-text)] hover:underline">
          Sign in
        </Link>
      </p>
    </Panel>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  useCapabilities,
  useCurrentUser,
  useQuotas,
  useRevokeSession,
  useSessions,
  useUpdateCurrentUser,
} from '@/lib/query/hooks';
import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { signOutAction } from '@/lib/server/actions';
import { formatAbsoluteTime, formatBytes, formatCount, formatRelativeTime } from '@/lib/format';

/**
 * Settings (Phase 9 rules 70, 73, 122).
 *
 * Only what the API actually allows a user to change about themselves:
 * `display_name` and two preferences. `email` and `roles` are deliberately
 * absent from the request schema — an email change is an auth-domain operation
 * and roles are administrative — so no control for them is rendered.
 *
 * `GET /users/me/sessions` is real as of Phase 10 (the `session` table now
 * has a writer — `apps/api/src/auth/`) — see the Sessions panel below.
 */
export function SettingsView() {
  const user = useCurrentUser();
  const quotas = useQuotas();
  const capabilities = useCapabilities();
  const update = useUpdateCurrentUser();
  const sessions = useSessions();
  const revokeSession = useRevokeSession();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState('');
  const [notificationEmail, setNotificationEmail] = useState(false);

  useEffect(() => {
    if (!user.data) return;
    setDisplayName(user.data.display_name ?? '');
    const preferences = user.data.preferences as { notification_email?: boolean } | undefined;
    setNotificationEmail(Boolean(preferences?.notification_email));
  }, [user.data]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await update.mutateAsync({
        display_name: displayName.trim() || undefined,
        preferences: { notification_email: notificationEmail },
      });
      toast({ message: 'Settings saved.', tone: 'success' });
    } catch {
      /* surfaced inline */
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          Settings
        </h1>
      </header>

      <Panel className="overflow-hidden">
        <PanelHeader title="Your account" />
        <PanelBody>
          {user.isPending ? (
            <SkeletonText lines={4} />
          ) : user.isError ? (
            <ErrorState error={user.error} onRetry={() => void user.refetch()} compact />
          ) : (
            <form onSubmit={(event) => void save(event)} className="space-y-4">
              {update.isError ? <ErrorState error={update.error} compact /> : null}

              <Field label="Display name">
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={256}
                  />
                )}
              </Field>

              <Field
                label="Email address"
                hint="Changing an email address is handled by your identity provider, not by this studio."
              >
                {({ id }) => (
                  <TextInput id={id} value={user.data?.email ?? 'Not provided'} readOnly disabled />
                )}
              </Field>

              <div className="flex items-start gap-3">
                <input
                  id="notification-email"
                  type="checkbox"
                  checked={notificationEmail}
                  onChange={(event) => setNotificationEmail(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <label htmlFor="notification-email" className="text-[13px] text-[var(--text-secondary)]">
                  Email me when a production finishes or needs attention
                  <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
                    This records your preference. Whether mail is actually sent depends on how this
                    deployment is configured.
                  </span>
                </label>
              </div>

              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={update.isPending}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Appearance" />
        <PanelBody className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-[13px] text-[var(--text-secondary)]">
            Colour theme. Stored in this browser only.
          </p>
          <ThemeToggle />
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Workspace allowance"
          description={
            quotas.data?.degraded
              ? 'Usage figures are unavailable right now. The limits below are accurate; the amounts used are not known.'
              : undefined
          }
        />
        <PanelBody>
          {quotas.isPending ? (
            <SkeletonText lines={3} />
          ) : quotas.isError ? (
            <ErrorState error={quotas.error} onRetry={() => void quotas.refetch()} compact />
          ) : (quotas.data?.quotas.length ?? 0) === 0 ? (
            <p className="text-[13px] text-[var(--text-muted)]">
              No limits are set for this workspace.
            </p>
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2">
              {quotas.data?.quotas.map((quota) => (
                <div key={quota.dimension}>
                  <dt className="text-[12px] text-[var(--text-muted)]">
                    {quota.dimension.replace(/_/g, ' ').toLowerCase()}
                  </dt>
                  <dd className="mt-0.5 font-mono text-[13px] tabular-nums text-[var(--text-primary)]">
                    {quota.used === null
                      ? 'unknown'
                      : quota.dimension.includes('BYTES')
                        ? formatBytes(quota.used)
                        : formatCount(quota.used)}
                    <span className="text-[var(--text-muted)]">
                      {' / '}
                      {quota.limit === null
                        ? 'unlimited'
                        : quota.dimension.includes('BYTES')
                          ? formatBytes(quota.limit)
                          : formatCount(quota.limit)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Studio limits"
          description="Reported by the server, not configured here."
        />
        <PanelBody>
          {capabilities.isPending ? (
            <SkeletonText lines={3} />
          ) : capabilities.data ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-[12px] text-[var(--text-muted)]">Accepted source formats</dt>
                <dd className="mt-0.5 text-[13px] text-[var(--text-primary)]">
                  {capabilities.data.upload.accepted_mime_types
                    .map((type) => (type.includes('pdf') ? 'PDF' : 'EPUB'))
                    .join(', ')}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-[var(--text-muted)]">Largest upload</dt>
                <dd className="mt-0.5 text-[13px] text-[var(--text-primary)]">
                  {formatBytes(
                    Math.max(
                      ...Object.values(capabilities.data.limits.max_upload_bytes).filter(
                        (value) => typeof value === 'number',
                      ),
                    ),
                  ) ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-[var(--text-muted)]">Pages per book</dt>
                <dd className="mt-0.5 text-[13px] text-[var(--text-primary)]">
                  {formatCount(capabilities.data.limits.max_pages_per_book)}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-[var(--text-muted)]">Delivery formats</dt>
                <dd className="mt-0.5 text-[13px] text-[var(--text-primary)]">
                  {capabilities.data.delivery_formats.join(', ')}
                </dd>
              </div>
            </dl>
          ) : null}
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Sessions"
          description="Every device currently signed in to your account."
        />
        <PanelBody className="space-y-4">
          {sessions.isPending ? (
            <SkeletonText lines={3} />
          ) : sessions.isError ? (
            <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} compact />
          ) : (sessions.data?.length ?? 0) === 0 ? (
            <p className="text-[13px] text-[var(--text-muted)]">No active sessions.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {sessions.data?.map((session) => (
                <li
                  key={session.id}
                  className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div>
                    <p className="text-[13px] text-[var(--text-primary)]">
                      {session.user_agent_family ?? 'Unknown device'}
                      {session.ip_country ? ` · ${session.ip_country}` : ''}
                      {session.current ? (
                        <span className="ml-2 rounded-full bg-[var(--accent-subtle)] px-2 py-0.5 text-[11px] text-[var(--accent-text)]">
                          This device
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                      Signed in {formatAbsoluteTime(session.created_at)}
                      {session.last_seen_at
                        ? ` · last active ${formatRelativeTime(session.last_seen_at)}`
                        : ''}
                    </p>
                  </div>
                  {session.current ? null : (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={revokeSession.isPending && revokeSession.variables === session.id}
                      onClick={() => {
                        revokeSession.mutate(session.id, {
                          onSuccess: () => toast({ message: 'Session revoked.', tone: 'success' }),
                        });
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form action={signOutAction} className="flex justify-end border-t border-[var(--border)] pt-4">
            <Button type="submit" variant="secondary">
              Sign out
            </Button>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}

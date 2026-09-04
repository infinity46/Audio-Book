import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { safeReturnPath } from '@/lib/safe-redirect';
import { currentPrincipal } from '@/lib/server/session';

/**
 * Route protection for the studio (Phase 9 rules 74, 75).
 *
 * This gate is **UX only**. It exists so a signed-out visitor sees a sign-in
 * page instead of a screen full of 401s — it is not a security boundary. Every
 * request still carries the bearer to the API, which checks ownership and role
 * on every resource and answers `404` for anything outside the caller's tenant.
 * Removing this file would change what the user sees, not what they can reach.
 */
export const dynamic = 'force-dynamic';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal();
  if (!principal) {
    // A cookie is present (middleware would have redirected otherwise) but the
    // token in it did not verify — expired, rotated key, wrong issuer. The
    // user's place is preserved either way; `x-pathname` is set by middleware
    // because a Server Component cannot read the request path directly.
    const requested = safeReturnPath((await headers()).get('x-pathname'));
    redirect(`/sign-in?returnTo=${encodeURIComponent(requested)}`);
  }

  return (
    <AppShell
      principal={{ sub: principal.sub, tenantId: principal.tenantId, roles: principal.roles }}
    >
      {children}
    </AppShell>
  );
}

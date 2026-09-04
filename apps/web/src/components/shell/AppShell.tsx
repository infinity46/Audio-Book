'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from './ThemeToggle';
import { signOutAction } from '@/lib/server/actions';

/**
 * The studio chrome (Phase 9 rules 6, 86, 87).
 *
 * Primary navigation is exactly the four sections the brief names, and no more:
 * every entry resolves to a real, working page backed by a real endpoint, so
 * there are no navigational dead ends (rules 160, 161). An "Admin" section is
 * deliberately absent — `/api/v1/admin/**` requires `PLATFORM_ADMIN`, and
 * §6.6 makes that principal *unable* to read tenant content at all, so an
 * operator console is a different product surface rather than a tab here.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Marks the section active for `/projects/anything` as well as `/projects`. */
  matchPrefix?: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: <DashboardIcon /> },
  { href: '/projects', label: 'Projects', icon: <ProjectsIcon />, matchPrefix: '/projects' },
  { href: '/voices', label: 'Voices', icon: <VoicesIcon />, matchPrefix: '/voices' },
  { href: '/settings', label: 'Settings', icon: <SettingsIcon />, matchPrefix: '/settings' },
];

export function AppShell({
  children,
  principal,
}: {
  children: React.ReactNode;
  principal: { sub: string; tenantId: string; roles: string[] };
}) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const isActive = (item: NavItem) =>
    item.matchPrefix ? pathname.startsWith(item.matchPrefix) : pathname === item.href;

  return (
    <div className="min-h-dvh bg-[var(--canvas)]">
      {/* First tab stop on every page (WCAG 2.4.1). */}
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--panel)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[110rem] items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded font-semibold tracking-tight"
          >
            <WaveMark />
            <span className="hidden text-[15px] sm:inline">Audiobook Studio</span>
          </Link>

          <nav aria-label="Primary" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive(item) ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                      isActive(item)
                        ? 'bg-[var(--panel-sunken)] text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--panel-raised)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden lg:block">
              <ThemeToggle />
            </div>
            <Link
              href="/projects/new"
              className="hidden rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] sm:inline-flex"
            >
              New project
            </Link>
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm" title={`Signed in as ${principal.sub}`}>
                Sign out
              </Button>
            </form>
            <button
              type="button"
              className="md:hidden"
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav"
              aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <MenuIcon open={mobileNavOpen} />
            </button>
          </div>
        </div>

        {/* Mobile primary navigation (rule 87). */}
        <nav
          id="mobile-nav"
          aria-label="Primary"
          hidden={!mobileNavOpen}
          className="border-t border-[var(--border-subtle)] bg-[var(--panel)] md:hidden"
        >
          <ul className="px-4 py-2">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMobileNavOpen(false)}
                  aria-current={isActive(item) ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium',
                    isActive(item)
                      ? 'bg-[var(--panel-sunken)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)]',
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="mt-2 border-t border-[var(--border-subtle)] pt-3 pb-1">
              <ThemeToggle />
            </li>
          </ul>
        </nav>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[110rem] px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- glyphs ----

function WaveMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-[var(--accent)]" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 12v0" opacity="0.4" />
        <path d="M7 8.5v7" />
        <path d="M11 5v14" />
        <path d="M15 8v8" />
        <path d="M19 10.5v3" opacity="0.7" />
      </g>
    </svg>
  );
}

const iconProps = { className: 'h-4 w-4', 'aria-hidden': true as const, viewBox: '0 0 16 16' };

function DashboardIcon() {
  return (
    <svg {...iconProps}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="8" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="12" width="5" height="2" rx="1" />
      </g>
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg {...iconProps}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M3 2.5h6.5L13 6v7.5H3z" />
        <path d="M9.5 2.5V6H13" />
      </g>
    </svg>
  );
}

function VoicesIcon() {
  return (
    <svg {...iconProps}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="6" y="1.75" width="4" height="8" rx="2" />
        <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
        <path d="M8 12v2.25" />
      </g>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...iconProps}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="2.25" />
        <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
      {open ? (
        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      )}
    </svg>
  );
}

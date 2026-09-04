'use client';

import { useMemo, useState } from 'react';
import { useVoiceVersions } from '@/lib/query/hooks';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { formatLanguage } from '@/lib/format';
import type { VoiceProfile, VoiceProfileVersion } from '@/lib/api/types';

/**
 * Voice picker (Phase 9 rules 28, 30, 31, 32).
 *
 * Three properties the backend forces, and the UI reflects rather than hides:
 *
 *  1. **An assignment binds a `VoiceProfileVersion`, never a profile.** That is
 *     what makes a rendered chunk traceable to the exact voice that produced
 *     it, so the version is always visible — "Sarah · v3", never just "Sarah".
 *  2. **Only `APPROVED` or `LOCKED` versions are usable.** A draft version is
 *     shown but disabled, with the reason, rather than omitted — a voice that
 *     exists but cannot be used is information.
 *  3. **The version must support the book's language.** `PUT` refuses with
 *     `VOICE_LANGUAGE_MISMATCH`, so an unsupported version is disabled here for
 *     that stated reason instead of failing after the click.
 *
 * Versions are fetched **only for the profile the user opens**, so browsing a
 * 200-voice library costs one request per voice actually inspected rather than
 * 200 up front.
 */

export const USABLE_APPROVAL_STATES = ['APPROVED', 'LOCKED'] as const;

export function isUsableVersion(
  version: VoiceProfileVersion,
  bookLanguage: string,
): { usable: boolean; reason?: string } {
  if (!USABLE_APPROVAL_STATES.includes(version.approval_state as 'APPROVED')) {
    if (version.lock_state !== 'LOCKED') {
      return {
        usable: false,
        reason: `This version is ${version.approval_state.toLowerCase().replace(/_/g, ' ')} — it must be approved before it can be used for production.`,
      };
    }
  }
  const base = bookLanguage.split('-')[0];
  const supported = version.supported_languages.some(
    (tag) => tag === bookLanguage || tag.split('-')[0] === base,
  );
  if (!supported) {
    return {
      usable: false,
      reason: `This voice does not support ${formatLanguage(bookLanguage)}.`,
    };
  }
  return { usable: true };
}

export function VoiceSelector({
  profiles,
  loading,
  error,
  bookLanguage,
  currentProfileId,
  currentVersion,
  onSelect,
  assigning,
}: {
  profiles: VoiceProfile[];
  loading: boolean;
  error?: unknown;
  bookLanguage: string;
  currentProfileId?: string | null;
  currentVersion?: number | null;
  onSelect: (profileId: string, version: number) => void;
  assigning: boolean;
}) {
  const [search, setSearch] = useState('');
  const [openProfileId, setOpenProfileId] = useState<string | null>(currentProfileId ?? null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        (profile.description ?? '').toLowerCase().includes(needle),
    );
  }, [profiles, search]);

  if (loading) return <SkeletonText lines={5} />;
  if (error) return <ErrorState error={error} compact />;

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="voice-search" className="sr-only">
          Filter voices
        </label>
        <TextInput
          id="voice-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter voices by name…"
        />
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          title="No voices in this workspace"
          description="Voice profiles are created in the Voices library. Every speaking character needs one before audio can be generated."
          className="py-8"
        />
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-[var(--text-muted)]">
          No voices match “{search}”.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-control)] border border-[var(--border-subtle)]">
          {filtered.map((profile) => (
            <VoiceProfileEntry
              key={profile.id}
              profile={profile}
              bookLanguage={bookLanguage}
              expanded={openProfileId === profile.id}
              onToggle={() =>
                setOpenProfileId((current) => (current === profile.id ? null : profile.id))
              }
              currentVersion={currentProfileId === profile.id ? (currentVersion ?? null) : null}
              onSelect={onSelect}
              assigning={assigning}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VoiceProfileEntry({
  profile,
  bookLanguage,
  expanded,
  onToggle,
  currentVersion,
  onSelect,
  assigning,
}: {
  profile: VoiceProfile;
  bookLanguage: string;
  expanded: boolean;
  onToggle: () => void;
  currentVersion: number | null;
  onSelect: (profileId: string, version: number) => void;
  assigning: boolean;
}) {
  // Lazy: versions load only when this profile is opened.
  const versions = useVoiceVersions(expanded ? profile.id : undefined);
  const panelId = `voice-versions-${profile.id}`;

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--panel-raised)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
            {profile.name}
            {currentVersion !== null ? (
              <span className="ml-2 text-[12px] font-normal text-[var(--accent-text)]">
                · currently assigned (v{currentVersion})
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-[var(--text-muted)]">
            {profile.description ??
              `${profile.scope === 'SYSTEM' ? 'Built-in voice' : 'Workspace voice'}`}
            {profile.active_version !== null ? ` · latest v${profile.active_version}` : ''}
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          className={cn('h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        >
          <path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-[var(--border-subtle)] bg-[var(--panel-sunken)] px-4 py-3">
          {versions.isPending ? (
            <SkeletonText lines={2} />
          ) : versions.isError ? (
            <ErrorState error={versions.error} compact />
          ) : (versions.data?.data.length ?? 0) === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              This voice has no versions yet, so it cannot be assigned.
            </p>
          ) : (
            <ul className="space-y-2">
              {versions.data?.data.map((version) => {
                const check = isUsableVersion(version, bookLanguage);
                const isCurrent = currentVersion === version.version;
                return (
                  <li
                    key={version.id}
                    className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--panel)] px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                        {profile.name} · v{version.version}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
                        {version.tts_provider_id} ·{' '}
                        {version.supported_languages.map(formatLanguage).join(', ')}
                      </span>
                      {!check.usable ? (
                        <span className="mt-1 block text-[12px] text-[var(--tone-warning)]">
                          {check.reason}
                        </span>
                      ) : null}
                    </span>
                    <StatusBadge
                      label={version.approval_state.replace(/_/g, ' ').toLowerCase()}
                      tone={check.usable ? 'success' : 'warning'}
                      size="sm"
                    />
                    <Button
                      size="sm"
                      variant={isCurrent ? 'ghost' : 'primary'}
                      disabled={!check.usable || isCurrent || assigning}
                      disabledReason={
                        isCurrent ? 'This version is already assigned.' : check.reason
                      }
                      onClick={() => onSelect(profile.id, version.version)}
                    >
                      {isCurrent ? 'Assigned' : 'Use this voice'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {/*
            Rule 29 says to allow playback "if backend supports preview". It does
            not: `POST .../previews` exists and produces a VoicePreview row, but
            the byte-access sub-resource the specification defines for it
            (§15.13) is not implemented, so there is no way to obtain the audio.
            A Play button here would be a dead control (rule 160), and rendering
            one anyway would be a UI for a capability that does not exist
            (rule 161). Recorded as GAP-7.
          */}
          <Notice className="mt-3" tone="info" title="Audio preview is not available">
            This deployment cannot return preview audio: the API implements preview
            <em> generation</em> but not the signed-URL endpoint needed to play it back. Voices are
            chosen here by name, provider, language, and approval state.
          </Notice>
        </div>
      ) : null}
    </li>
  );
}

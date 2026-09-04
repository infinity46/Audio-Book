'use client';

import { useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useAssignVoice, useClearVoice } from '@/lib/query/hooks';
import { VoiceSelector } from './VoiceSelector';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { formatCount, formatRelativeTime } from '@/lib/format';
import type { Character, VoiceAssignment, VoiceProfile } from '@/lib/api/types';

/**
 * Assign, replace, and clear a character's voice (Phase 9 rules 30–33).
 *
 * The regeneration warning (rule 33) is handled in two honest steps rather than
 * one guessed one:
 *
 *  - **Before** the change, the studio warns only when audio actually exists
 *    for this book — derived from the TTS stage having completed units, not
 *    from an assumption. The wording is conditional ("may require"), because
 *    the exact impact is not knowable until the server computes it.
 *  - **After** the change, the API's `impact` object gives the real figures —
 *    how many rendered chunks are bound to the previous version, and whether
 *    regeneration is required — and those are shown verbatim.
 *
 * The consequence is never hidden, and it is never overstated: reassignment
 * does not rewrite existing audio. The previous version stays reachable and
 * byte-identical; the change affects the next generation.
 */
export function VoiceAssignmentPanel({
  bookId,
  character,
  assignment,
  assignmentLoading,
  voiceProfiles,
  voicesLoading,
}: {
  bookId: string;
  character: Character;
  assignment: VoiceAssignment | null;
  assignmentLoading: boolean;
  voiceProfiles: VoiceProfile[];
  voicesLoading: boolean;
}) {
  const { book, progress } = useProject();
  const { toast } = useToast();
  const assign = useAssignVoice(bookId);
  const clear = useClearVoice(bookId);

  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState<{ profileId: string; version: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [lastImpact, setLastImpact] = useState<VoiceAssignment['impact'] | null>(null);

  // Has any audio been rendered for this book yet? If not, a reassignment has
  // no dependent artifacts and warning about regeneration would be noise.
  const ttsStage = progress?.stages.find((stage) => stage.stage === 'tts');
  const audioExists = (ttsStage?.completed_units ?? 0) > 0;

  const profileName =
    voiceProfiles.find((profile) => profile.id === assignment?.voice_profile_id)?.name ?? null;

  const applyAssignment = async (profileId: string, version: number) => {
    try {
      const result = await assign.mutateAsync({
        characterId: character.id,
        voiceProfileId: profileId,
        voiceProfileVersion: version,
      });
      setLastImpact(result.impact ?? null);
      setChoosing(false);
      setPending(null);
      toast({
        message: `Voice assigned to ${character.display_name}.`,
        tone: 'success',
      });
    } catch {
      // Surfaced inline below.
      setPending(null);
    }
  };

  const clearAssignment = async () => {
    try {
      await clear.mutateAsync(character.id);
      setLastImpact(null);
      toast({ message: 'Voice assignment removed.', tone: 'success' });
    } finally {
      setClearing(false);
    }
  };

  const handleSelect = (profileId: string, version: number) => {
    if (audioExists && assignment) {
      setPending({ profileId, version });
      return;
    }
    void applyAssignment(profileId, version);
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        as="h2"
        title="Voice"
        description="An assignment binds a specific voice version, so every rendered line is traceable to the exact voice that produced it."
        actions={
          assignment && !choosing ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setChoosing(true)}>
                Change voice
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
                Clear
              </Button>
            </div>
          ) : null
        }
      />
      <PanelBody className="space-y-4">
        {assign.isError ? <ErrorState error={assign.error} compact /> : null}
        {clear.isError ? <ErrorState error={clear.error} compact /> : null}

        {assignmentLoading ? (
          <SkeletonText lines={2} />
        ) : assignment ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--panel-sunken)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {/* Rule 32 — never just the name; the version is what is bound. */}
                {profileName ?? 'Voice profile'} · v{assignment.voice_profile_version}
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                Assigned {formatRelativeTime(assignment.assigned_at)}
              </p>
            </div>
            <StatusBadge
              label={assignment.approval_state.replace(/_/g, ' ').toLowerCase()}
              tone={
                assignment.approval_state === 'APPROVED' || assignment.approval_state === 'RETIRED'
                  ? assignment.approval_state === 'APPROVED'
                    ? 'success'
                    : 'warning'
                  : 'warning'
              }
              size="sm"
            />
          </div>
        ) : (
          <Notice tone="warning" title="No voice assigned">
            {character.display_name} has {formatCount(character.line_count)} spoken line
            {character.line_count === 1 ? '' : 's'}. Audio generation is refused until every
            speaking character has an approved voice.
          </Notice>
        )}

        {lastImpact ? (
          <Notice
            tone={lastImpact.requires_regeneration ? 'warning' : 'info'}
            title={
              lastImpact.requires_regeneration
                ? 'Existing audio still uses the previous voice'
                : 'No existing audio is affected'
            }
          >
            {lastImpact.requires_regeneration ? (
              <>
                {formatCount(lastImpact.chunks_bound_to_previous_version)} already-rendered passage
                {lastImpact.chunks_bound_to_previous_version === 1 ? '' : 's'} are bound to the
                previous voice version. They were <strong>not</strong> changed — the studio never
                rewrites existing audio. To hear the new voice in them, regenerate from the
                Generation tab; that produces a new version and leaves the old one intact.
              </>
            ) : (
              <>Nothing has been rendered with this character yet, so no regeneration is needed.</>
            )}
          </Notice>
        ) : null}

        {!assignment || choosing ? (
          <div className="space-y-3">
            {choosing ? (
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setChoosing(false)}>
                  Cancel
                </Button>
              </div>
            ) : null}
            <VoiceSelector
              profiles={voiceProfiles}
              loading={voicesLoading}
              bookLanguage={book?.language ?? 'en-US'}
              currentProfileId={assignment?.voice_profile_id}
              currentVersion={assignment?.voice_profile_version}
              onSelect={handleSelect}
              assigning={assign.isPending}
            />
          </div>
        ) : null}
      </PanelBody>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title="Change this character’s voice?"
        consequence={
          <>
            Audio has already been generated for this book. Changing the voice{' '}
            <strong>does not alter existing audio</strong> — the current recordings stay exactly as
            they are, and remain downloadable. The new voice applies the next time this character’s
            passages are generated, which you start yourself from the Generation tab.
          </>
        }
        confirmLabel="Change voice"
        busy={assign.isPending}
        onConfirm={() => {
          if (pending) void applyAssignment(pending.profileId, pending.version);
        }}
      />

      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Remove this voice assignment?"
        destructive
        consequence={
          <>
            {character.display_name} will have no voice, and audio generation for this book will be
            refused until a voice is assigned again. Audio that has already been rendered is not
            affected.
          </>
        }
        confirmLabel="Remove assignment"
        busy={clear.isPending}
        onConfirm={() => void clearAssignment()}
      />
    </Panel>
  );
}

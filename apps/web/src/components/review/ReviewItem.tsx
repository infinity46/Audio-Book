'use client';

import { useState } from 'react';
import { useStartStage, useUpdateScriptChunk } from '@/lib/query/hooks';
import { useSignedAudio } from '@/lib/hooks/useSignedAudio';
import { newIdempotencyKey } from '@/lib/api/client';
import { AudioPlayer } from '@/components/audio/AudioPlayer';
import { Button } from '@/components/ui/Button';
import { Select, TextInput } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { EMOTIONS, DELIVERY_MODES } from '@/lib/vocabularies';
import { humanizeEnum, reviewFlagDisplay } from '@/lib/status';
import { cn } from '@/lib/cn';
import type { AudioScriptChunk } from '@/lib/api/types';

/**
 * One flagged passage (Phase 9 rules 52–56, 123–125, 173).
 *
 * **The passage text is untrusted book content.** It is rendered as a React
 * text node — escaped by construction, never `dangerouslySetInnerHTML`, never
 * markdown — so a book containing markup, script tags, or text shaped like
 * instructions to a model is displayed as what it is: characters on a page
 * (rules 123, 125).
 *
 * The three actions correspond exactly to what the API permits on a chunk:
 *  - correct the speaker (`performance.speaker_type` / `character_id`),
 *  - adjust the performance (`performance.emotion` / `delivery_mode`),
 *  - clear the flags (`quality.review_flags`) — which is what "resolved" means
 *    here, and the copy says so rather than implying an approval workflow the
 *    backend does not have.
 *
 * Editing is offered only while the chunk is `DRAFT` or `VALIDATED`; a frozen
 * chunk gets an explanation instead of a control that would return `409`.
 */
export function ReviewItem({
  bookId,
  chunk,
  chapterTitle,
  characterNames,
  selected,
  onToggleSelected,
}: {
  bookId: string;
  chunk: AudioScriptChunk;
  chapterTitle: string;
  characterNames: Map<string, string>;
  selected: boolean;
  onToggleSelected: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateScriptChunk(bookId);
  const regenerate = useStartStage(bookId, 'tts');
  const [editing, setEditing] = useState(false);
  const [speakerId, setSpeakerId] = useState(chunk.performance.character_id ?? '');
  const [emotion, setEmotion] = useState(chunk.performance.emotion);
  const [delivery, setDelivery] = useState(chunk.performance.delivery_mode);
  const [reason, setReason] = useState('');

  const audio = useSignedAudio(
    chunk.current_audio_chunk_id
      ? `/api/v1/books/${bookId}/audio-chunks/${chunk.current_audio_chunk_id}/access-urls`
      : null,
  );

  const editable = chunk.state === 'DRAFT' || chunk.state === 'VALIDATED';
  const speakerName = chunk.performance.character_id
    ? (characterNames.get(chunk.performance.character_id) ?? 'Unknown character')
    : humanizeEnum(chunk.performance.speaker_type);

  const savePerformance = async () => {
    try {
      await update.mutateAsync({
        chunkId: chunk.id,
        body: {
          performance: {
            ...(speakerId !== (chunk.performance.character_id ?? '')
              ? {
                  character_id: speakerId || null,
                  speaker_type: speakerId ? 'CHARACTER' : 'NARRATOR',
                }
              : {}),
            emotion,
            delivery_mode: delivery,
          },
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      toast({ message: 'Passage updated.', tone: 'success' });
      setEditing(false);
    } catch {
      /* surfaced inline */
    }
  };

  const clearFlags = async () => {
    try {
      await update.mutateAsync({
        chunkId: chunk.id,
        body: {
          quality: { review_flags: [] },
          reason: reason.trim() || 'Reviewed in the studio; no change required.',
        },
      });
      toast({ message: 'Marked as resolved.', tone: 'success' });
    } catch {
      /* surfaced inline */
    }
  };

  const regenerateOne = async () => {
    try {
      await regenerate.mutateAsync({
        body: { scope: 'CHUNKS', chunk_ids: [chunk.id], force: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast({ message: 'This passage has been queued for regeneration.', tone: 'success' });
    } catch {
      /* surfaced inline */
    }
  };

  return (
    <li className={cn('px-5 py-4', selected && 'bg-[var(--accent-soft)]/40')}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select passage ${chunk.chapter_sequence_index + 1} in ${chapterTitle}`}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
              {chapterTitle}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              passage {chunk.chapter_sequence_index + 1}
            </span>
            {chunk.review_flags.map((flag) => {
              const display = reviewFlagDisplay(flag);
              return (
                <StatusBadge
                  key={flag}
                  label={display.label}
                  tone="warning"
                  description={display.description}
                  size="sm"
                />
              );
            })}
          </div>

          {/*
            Book text. A plain text node — never markup, never markdown, never
            an innerHTML sink. Clamped so one long passage cannot dominate the
            queue, and expandable in place.
          */}
          <blockquote className="book-text max-h-40 overflow-y-auto rounded-[var(--radius-control)] border-l-2 border-[var(--border-strong)] bg-[var(--panel-sunken)] px-4 py-3 text-[13px] text-[var(--text-primary)]">
            {chunk.content.text}
          </blockquote>

          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
            <Pair label="Speaker" value={speakerName} />
            <Pair label="Delivery" value={humanizeEnum(chunk.performance.delivery_mode)} />
            <Pair label="Emotion" value={humanizeEnum(chunk.performance.emotion)} />
            <Pair
              label="Director confidence"
              value={`${Math.round(chunk.confidence * 100)}%`}
            />
          </dl>

          {chunk.current_audio_chunk_id ? (
            <AudioPlayer
              audio={audio}
              title={`passage ${chunk.chapter_sequence_index + 1} of ${chapterTitle}`}
              compact
            />
          ) : (
            <p className="text-[12px] text-[var(--text-muted)]">
              No audio has been rendered for this passage yet, so there is nothing to listen to.
            </p>
          )}

          {update.isError ? <ErrorState error={update.error} compact /> : null}
          {regenerate.isError ? <ErrorState error={regenerate.error} compact /> : null}

          {editing ? (
            <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--panel)] px-4 py-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`speaker-${chunk.id}`}
                    className="block text-[12px] font-medium text-[var(--text-secondary)]"
                  >
                    Who speaks this passage
                  </label>
                  <Select
                    id={`speaker-${chunk.id}`}
                    className="mt-1"
                    value={speakerId}
                    onChange={(event) => setSpeakerId(event.target.value)}
                  >
                    <option value="">The narrator</option>
                    {[...characterNames.entries()].map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label
                    htmlFor={`delivery-${chunk.id}`}
                    className="block text-[12px] font-medium text-[var(--text-secondary)]"
                  >
                    Delivery
                  </label>
                  <Select
                    id={`delivery-${chunk.id}`}
                    className="mt-1"
                    value={delivery}
                    onChange={(event) => setDelivery(event.target.value)}
                  >
                    {DELIVERY_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {humanizeEnum(mode)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label
                    htmlFor={`emotion-${chunk.id}`}
                    className="block text-[12px] font-medium text-[var(--text-secondary)]"
                  >
                    Emotion
                  </label>
                  <Select
                    id={`emotion-${chunk.id}`}
                    className="mt-1"
                    value={emotion}
                    onChange={(event) => setEmotion(event.target.value)}
                  >
                    {EMOTIONS.map((entry) => (
                      <option key={entry} value={entry}>
                        {humanizeEnum(entry)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label
                    htmlFor={`reason-${chunk.id}`}
                    className="block text-[12px] font-medium text-[var(--text-secondary)]"
                  >
                    Note (optional)
                  </label>
                  <TextInput
                    id={`reason-${chunk.id}`}
                    className="mt-1"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={2000}
                    placeholder="Why this was changed"
                  />
                </div>
              </div>
              <p className="text-[12px] text-[var(--text-muted)]">
                Saving updates the script only. The audio you can hear above was rendered from the
                old version — regenerate the passage to hear the change.
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={update.isPending}
                  onClick={() => void savePerformance()}
                >
                  Save changes
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => setEditing(true)}
                disabled={!editable}
                disabledReason={
                  !editable
                    ? `This passage is ${humanizeEnum(chunk.state).toLowerCase()} and can no longer be edited. Regenerate the script for this chapter to change it.`
                    : undefined
                }
              >
                Correct this passage
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={update.isPending}
                onClick={() => void clearFlags()}
                disabled={!editable}
                disabledReason={
                  !editable ? 'Flags can only be cleared while the script is editable.' : undefined
                }
                title="Removes the review flags from this passage. It does not change the audio."
              >
                Mark as resolved
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={regenerate.isPending}
                onClick={() => void regenerateOne()}
              >
                Regenerate audio
              </Button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-[var(--text-muted)]">{label}:</dt>
      <dd className="font-medium text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

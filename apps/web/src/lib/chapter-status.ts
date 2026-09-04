import type { Tone } from './status';

/**
 * `ChapterAudio.status` → display, plus the "no audio at all" case.
 *
 * Part of the single status mapping (rule 10): nothing else in the app decides
 * what a chapter's audio state looks like.
 */
const MAP: Record<string, { label: string; tone: Tone; description: string }> = {
  PENDING: {
    label: 'Not generated',
    tone: 'neutral',
    description: 'No audio has been produced for this chapter yet.',
  },
  ASSEMBLING: {
    label: 'Assembling',
    tone: 'progress',
    description: 'The chapter’s passages are being joined and mastered.',
  },
  ASSEMBLED: {
    label: 'Ready',
    tone: 'success',
    description: 'This chapter’s audio is finished and can be played.',
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'Assembling this chapter stopped with an error.',
  },
  INVALID: {
    label: 'Invalid',
    tone: 'danger',
    description: 'The produced audio failed validation and should be regenerated.',
  },
  SUPERSEDED: {
    label: 'Superseded',
    tone: 'neutral',
    description: 'A newer version of this chapter’s audio exists.',
  },
};

export function chapterAudioDisplay(status: string | undefined) {
  if (!status) return MAP.PENDING!;
  return (
    MAP[status] ?? {
      label: status.replace(/_/g, ' ').toLowerCase(),
      tone: 'neutral' as Tone,
      description: 'This studio build does not recognise this chapter audio state.',
    }
  );
}

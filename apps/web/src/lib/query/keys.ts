/**
 * Query key factory (Phase 9 rules 94, 97).
 *
 * One place that names every server-state cache entry, so an invalidation
 * after a mutation is a prefix match rather than a hand-maintained list of
 * dozens of independent copies to patch.
 */
export const queryKeys = {
  capabilities: () => ['capabilities'] as const,
  me: () => ['me'] as const,
  quotas: () => ['quotas'] as const,
  sessions: () => ['sessions'] as const,

  books: () => ['books'] as const,
  bookList: (filters: Record<string, unknown>) => ['books', 'list', filters] as const,
  book: (bookId: string) => ['books', bookId] as const,
  bookDetail: (bookId: string) => ['books', bookId, 'detail'] as const,
  bookProgress: (bookId: string) => ['books', bookId, 'progress'] as const,
  bookFiles: (bookId: string) => ['books', bookId, 'files'] as const,
  chapters: (bookId: string) => ['books', bookId, 'chapters'] as const,
  characters: (bookId: string) => ['books', bookId, 'characters'] as const,
  character: (bookId: string, characterId: string) =>
    ['books', bookId, 'characters', characterId] as const,
  characterAliases: (bookId: string, characterId: string) =>
    ['books', bookId, 'characters', characterId, 'aliases'] as const,
  characterVoice: (bookId: string, characterId: string) =>
    ['books', bookId, 'characters', characterId, 'voice'] as const,
  casting: (bookId: string) => ['books', bookId, 'casting'] as const,
  audioScript: (bookId: string) => ['books', bookId, 'audio-script'] as const,
  scriptChunks: (bookId: string, filters: Record<string, unknown>) =>
    ['books', bookId, 'audio-script-chunks', filters] as const,
  scriptChunk: (bookId: string, chunkId: string) =>
    ['books', bookId, 'audio-script-chunks', chunkId] as const,
  audioChunks: (bookId: string, filters: Record<string, unknown>) =>
    ['books', bookId, 'audio-chunks', filters] as const,
  chapterAudio: (bookId: string) => ['books', bookId, 'chapter-audio'] as const,
  audiobookProject: (bookId: string) => ['books', bookId, 'audiobook'] as const,
  audiobooks: (bookId: string) => ['books', bookId, 'audiobooks'] as const,
  audiobook: (bookId: string, audiobookId: string) =>
    ['books', bookId, 'audiobooks', audiobookId] as const,
  ttsState: (bookId: string) => ['books', bookId, 'tts'] as const,
  assemblyState: (bookId: string) => ['books', bookId, 'assembly'] as const,
  analysisState: (bookId: string) => ['books', bookId, 'analysis'] as const,
  directorState: (bookId: string) => ['books', bookId, 'director'] as const,
  ingestionState: (bookId: string) => ['books', bookId, 'ingestion'] as const,

  voiceProfiles: (filters: Record<string, unknown>) => ['voice-profiles', filters] as const,
  voiceProfile: (voiceProfileId: string) => ['voice-profiles', voiceProfileId] as const,
  voiceVersions: (voiceProfileId: string) =>
    ['voice-profiles', voiceProfileId, 'versions'] as const,
  voicePreviews: (voiceProfileId: string, version: number) =>
    ['voice-profiles', voiceProfileId, 'versions', version, 'previews'] as const,

  jobs: (filters: Record<string, unknown>) => ['jobs', filters] as const,
  job: (jobId: string) => ['jobs', jobId] as const,
} as const;

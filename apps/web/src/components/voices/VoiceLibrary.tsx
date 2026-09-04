'use client';

import { useMemo, useState } from 'react';
import {
  useCapabilities,
  useCreateVoiceProfile,
  useVoiceProfiles,
} from '@/lib/query/hooks';
import { VoiceProfileDetail } from './VoiceProfileDetail';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, TextArea, TextInput } from '@/components/ui/Field';
import { ScrollRegion } from '@/components/ui/ScrollRegion';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The voice library (Phase 9 rules 28, 29, 31).
 *
 * Shows what the API exposes about a voice — name, scope, provider, supported
 * languages, version count, approval and lock state — and nothing it does not.
 * There is deliberately **no gender, age, or accent facet**: `VoiceProfile` and
 * `VoiceProfileVersion` carry no such fields, and rule 28 is explicit that
 * attributes appear "only if API exposes them". Inventing a taxonomy here would
 * be a filter that filters nothing.
 *
 * Audio preview is unavailable in this deployment — see `VoiceSelector` and
 * GAP-7 — so no play control is rendered anywhere in this library.
 */
export function VoiceLibrary() {
  const profiles = useVoiceProfiles();
  const capabilities = useCapabilities();
  const create = useCreateVoiceProfile();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const rows = useMemo(() => {
    const all = profiles.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        (profile.description ?? '').toLowerCase().includes(needle),
    );
  }, [profiles.data, search]);

  const selected = rows.find((profile) => profile.id === selectedId) ?? rows[0] ?? null;
  const engines = capabilities.data?.tts_providers ?? [];

  const submitCreate = async () => {
    try {
      const profile = await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        scope: 'TENANT',
      });
      setSelectedId(profile.id);
      setCreating(false);
      setName('');
      setDescription('');
      toast({ message: `Voice “${profile.name}” created. Add a version to make it usable.`, tone: 'success' });
    } catch {
      /* shown inline in the dialog */
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            Voices
          </h1>
          <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
            The voices available to every project in this workspace. A character is cast to a
            specific <em>version</em> of a voice, so a finished recording is always traceable to
            exactly what produced it.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New voice
        </Button>
      </header>

      {capabilities.data && engines.length === 0 && !capabilities.isPending ? (
        <Notice tone="warning" title="No speech engine is registered">
          This deployment has no active text-to-speech model registered, so new voice versions
          cannot be created. Existing voices are still listed.
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Panel className="overflow-hidden lg:sticky lg:top-20 lg:self-start">
          <PanelHeader
            as="h2"
            title="Library"
            description={profiles.data ? `${formatCount(rows.length)} shown` : undefined}
          />
          <div className="border-b border-[var(--border-subtle)] px-4 py-3">
            <label htmlFor="voice-library-search" className="sr-only">
              Filter voices
            </label>
            <TextInput
              id="voice-library-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by name…"
            />
          </div>

          {profiles.isPending ? (
            <PanelBody>
              <SkeletonText lines={5} />
            </PanelBody>
          ) : profiles.isError ? (
            <PanelBody>
              <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} compact />
            </PanelBody>
          ) : rows.length === 0 ? (
            <EmptyState
              title={search ? 'No voices match' : 'No voices yet'}
              description={
                search
                  ? 'Try a shorter search term.'
                  : 'Create a voice, then add a version bound to a speech engine.'
              }
              className="py-8"
            />
          ) : (
            <ScrollRegion label="Voice profiles" className="max-h-[32rem]">
              <ul className="divide-y divide-[var(--border-subtle)]">
              {rows.map((profile) => (
                <li key={profile.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(profile.id)}
                    aria-current={selected?.id === profile.id ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                      selected?.id === profile.id
                        ? 'bg-[var(--accent-soft)]'
                        : 'hover:bg-[var(--panel-raised)]',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {profile.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
                        {profile.version_count === 0
                          ? 'No versions yet'
                          : `${formatCount(profile.version_count)} version${profile.version_count === 1 ? '' : 's'}`}
                      </span>
                    </span>
                    {profile.scope === 'SYSTEM' ? (
                      <StatusBadge label="Built-in" tone="neutral" size="sm" />
                    ) : null}
                  </button>
                </li>
                ))}
              </ul>
            </ScrollRegion>
          )}
        </Panel>

        <div className="min-w-0">
          {selected ? (
            <VoiceProfileDetail key={selected.id} profile={selected} engines={engines} />
          ) : (
            <Panel>
              <EmptyState
                title="No voice selected"
                description="Choose a voice from the library, or create one."
              />
            </Panel>
          )}
        </div>
      </div>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New voice"
        description="A voice starts as a name. Adding a version binds it to a speech engine and makes it usable for casting."
        busy={create.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!name.trim()}
              disabledReason={!name.trim() ? 'Give the voice a name first.' : undefined}
              onClick={() => void submitCreate()}
            >
              Create voice
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {create.isError ? <ErrorState error={create.error} compact /> : null}
          <Field label="Name" required>
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={256}
                placeholder="Warm narrator"
              />
            )}
          </Field>
          <Field label="Description" hint="What this voice is for. Helps when casting a large book.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                rows={3}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

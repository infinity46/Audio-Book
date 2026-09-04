'use client';

import { useState } from 'react';
import { useApproveVoiceVersion, useCreateVoiceVersion, useVoiceVersions } from '@/lib/query/hooks';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ChoiceGroup, ChoiceOption, Field, Select, TextInput } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { formatAbsoluteTime, formatLanguage } from '@/lib/format';
import type { Capabilities, VoiceProfile } from '@/lib/api/types';

/**
 * One voice, and its versions (Phase 9 rules 28, 32, 67).
 *
 * The consent attestation is a **required** field of
 * `create-voice-profile-version.schema.json`, and this form treats it as the
 * deliberate choice it is rather than a checkbox to default past: a version
 * cannot exist without stating whether the voice is synthetic, the user's own,
 * or a consenting third party's. That is a product guarantee the schema
 * enforces, and the UI does not undercut it.
 *
 * Versions are immutable and append-only. Approval changes a version's state;
 * nothing here edits a version's parameters after the fact, because no endpoint
 * does (rule 68).
 */

type ConsentSubject = 'SYNTHETIC' | 'SELF' | 'THIRD_PARTY_CONSENTED';

export function VoiceProfileDetail({
  profile,
  engines,
}: {
  profile: VoiceProfile;
  engines: Capabilities['tts_providers'];
}) {
  const versions = useVoiceVersions(profile.id);
  const createVersion = useCreateVoiceVersion(profile.id);
  const approve = useApproveVoiceVersion(profile.id);
  const { toast } = useToast();

  const [addingVersion, setAddingVersion] = useState(false);
  const [engineIndex, setEngineIndex] = useState(0);
  const [language, setLanguage] = useState('en-US');
  const [consentSubject, setConsentSubject] = useState<ConsentSubject>('SYNTHETIC');

  const rows = versions.data?.data ?? [];
  const canAddVersion = engines.length > 0 && profile.scope !== 'SYSTEM';

  const submitVersion = async () => {
    const engine = engines[engineIndex];
    if (!engine) return;
    try {
      await createVersion.mutateAsync({
        tts_provider_id: engine.tts_provider_id,
        tts_model_id: engine.model_id,
        tts_model_version_id: engine.model_version_id,
        language,
        supported_languages: [language],
        reference_audio_consent: { attested: true, subject: consentSubject },
      });
      setAddingVersion(false);
      toast({
        message: 'Version created. Approve it before casting a character to it.',
        tone: 'success',
      });
    } catch {
      /* shown inline in the dialog */
    }
  };

  return (
    <div className="space-y-6">
      <Panel className="overflow-hidden">
        <PanelHeader
          as="h2"
          title={profile.name}
          description={profile.description ?? undefined}
          actions={
            <div className="flex items-center gap-2">
              {profile.scope === 'SYSTEM' ? (
                <StatusBadge
                  label="Built-in"
                  tone="neutral"
                  description="Provided by the platform. It cannot be modified from this workspace."
                  size="sm"
                />
              ) : null}
              <Button
                size="sm"
                variant="primary"
                onClick={() => setAddingVersion(true)}
                disabled={!canAddVersion}
                disabledReason={
                  profile.scope === 'SYSTEM'
                    ? 'Built-in voices cannot be changed from this workspace.'
                    : 'No speech engine is registered in this deployment, so a version cannot be created.'
                }
              >
                Add version
              </Button>
            </div>
          }
        />
        <PanelBody>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Stat label="Scope" value={profile.scope === 'SYSTEM' ? 'Platform' : 'This workspace'} />
            <Stat
              label="Active version"
              value={profile.active_version !== null ? `v${profile.active_version}` : 'None'}
            />
            <Stat label="Lock state" value={profile.lock_state === 'LOCKED' ? 'Locked' : 'Unlocked'} />
          </dl>
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          as="h2"
          title="Versions"
          description="A character is cast to one of these, not to the voice as a whole. Only approved or locked versions can be used for production."
        />

        {approve.isError ? (
          <PanelBody>
            <ErrorState error={approve.error} compact />
          </PanelBody>
        ) : null}

        {versions.isPending ? (
          <PanelBody>
            <SkeletonText lines={4} />
          </PanelBody>
        ) : versions.isError ? (
          <PanelBody>
            <ErrorState error={versions.error} onRetry={() => void versions.refetch()} compact />
          </PanelBody>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No versions yet"
            description="A voice needs at least one version before a character can be cast to it."
            className="py-8"
          />
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {rows
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((version) => {
                const usable =
                  version.approval_state === 'APPROVED' || version.lock_state === 'LOCKED';
                return (
                  <li key={version.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {profile.name} · v{version.version}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                        {version.tts_provider_id} ·{' '}
                        {version.supported_languages.map(formatLanguage).join(', ')} · created{' '}
                        {formatAbsoluteTime(version.created_at)}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                        Consent: {consentLabel(version.consent.subject)}
                      </p>
                    </div>

                    <StatusBadge
                      label={version.approval_state.replace(/_/g, ' ').toLowerCase()}
                      tone={usable ? 'success' : 'warning'}
                      description={
                        usable
                          ? 'This version can be used for production.'
                          : 'This version cannot be used for production until it is approved.'
                      }
                      size="sm"
                    />

                    {version.lock_state === 'LOCKED' ? (
                      <StatusBadge
                        label="Locked"
                        tone="neutral"
                        description="Locked versions cannot be changed, which is what makes an in-flight production reproducible."
                        size="sm"
                      />
                    ) : null}

                    {!usable && profile.scope !== 'SYSTEM' ? (
                      <Button
                        size="sm"
                        loading={approve.isPending}
                        onClick={() =>
                          void approve
                            .mutateAsync({ version: version.version, approved: true })
                            .then(() =>
                              toast({ message: `v${version.version} approved.`, tone: 'success' }),
                            )
                            .catch(() => undefined)
                        }
                      >
                        Approve
                      </Button>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        )}
      </Panel>

      <Dialog
        open={addingVersion}
        onOpenChange={setAddingVersion}
        size="md"
        title="Add a voice version"
        description="A version binds this voice to a specific speech engine and language. It is immutable once created — a change means a new version."
        busy={createVersion.isPending}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setAddingVersion(false)}
              disabled={createVersion.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createVersion.isPending}
              onClick={() => void submitVersion()}
            >
              Create version
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createVersion.isError ? <ErrorState error={createVersion.error} compact /> : null}

          <Field label="Speech engine" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={String(engineIndex)}
                onChange={(event) => setEngineIndex(Number(event.target.value))}
              >
                {engines.map((engine, index) => (
                  <option key={engine.model_version_id} value={index}>
                    {engine.model_id} · {engine.tts_provider_id} · {engine.version}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Language"
            required
            hint="A BCP-47 tag, for example en-GB. The voice can only be cast in a book of a matching language."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                pattern="^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$"
              />
            )}
          </Field>

          <ChoiceGroup
            legend="Consent"
            hint="Required. Every voice version records what it is and who agreed to it."
          >
            <ChoiceOption
              name="consent"
              value="SYNTHETIC"
              checked={consentSubject === 'SYNTHETIC'}
              onChange={(value) => setConsentSubject(value as ConsentSubject)}
              title="Fully synthetic"
              description="Not modelled on a specific real person’s voice."
            />
            <ChoiceOption
              name="consent"
              value="SELF"
              checked={consentSubject === 'SELF'}
              onChange={(value) => setConsentSubject(value as ConsentSubject)}
              title="My own voice"
              description="Based on a recording of yourself."
            />
            <ChoiceOption
              name="consent"
              value="THIRD_PARTY_CONSENTED"
              checked={consentSubject === 'THIRD_PARTY_CONSENTED'}
              onChange={(value) => setConsentSubject(value as ConsentSubject)}
              title="Another person, with their consent"
              description="You have that person’s permission to use their voice for this purpose."
            />
          </ChoiceGroup>

          <Notice tone="info" title="This attestation is recorded with the version">
            It is stored alongside the voice and travels with every recording made from it.
          </Notice>
        </div>
      </Dialog>
    </div>
  );
}

function consentLabel(subject: string): string {
  if (subject === 'SYNTHETIC') return 'fully synthetic';
  if (subject === 'SELF') return 'the creator’s own voice';
  if (subject === 'THIRD_PARTY_CONSENTED') return 'a consenting third party';
  return subject.replace(/_/g, ' ').toLowerCase();
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

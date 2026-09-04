'use client';

import { useState } from 'react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { ChoiceGroup, ChoiceOption, Select } from '@/components/ui/Field';
import { SkeletonText } from '@/components/ui/Skeleton';
import { Notice } from '@/components/ui/States';
import type { Capabilities } from '@/lib/api/types';

/**
 * Output configuration (Phase 9 rules 34, 35).
 *
 * **Only backend-approved options appear.** Delivery formats come from
 * `/capabilities` rather than a hard-coded list, and `priority` is the exact
 * three-value enum the stage-command schemas accept. There is no control for a
 * bitrate, a sample rate, a provider, a model, or a GPU — none of those is in
 * any request schema, and inventing one would be a UI for a capability that
 * does not exist (rule 161).
 *
 * The narrator voice and per-character voices are **not** here: they are bound
 * by casting (`PUT .../characters/{id}/voice`), not by a generation parameter,
 * and duplicating them as a setting would imply a second, competing source of
 * truth.
 *
 * Advanced options sit behind a disclosure (rule 35) and describe their effect
 * in product terms — never in infrastructure terms.
 */

export interface OutputSettings {
  deliveryFormats: string[];
  priority: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  force: boolean;
  allowPartialPreview: boolean;
}

const FORMAT_DESCRIPTIONS: Record<string, string> = {
  M4B: 'A single audiobook file with chapter markers. The usual choice.',
  M4A: 'A single audio file without audiobook chaptering.',
  MP3_PER_CHAPTER: 'One MP3 per chapter, for players that do not read M4B.',
};

export function GenerationSettings({
  value,
  onChange,
  capabilities,
  capabilitiesLoading,
}: {
  value: OutputSettings;
  onChange: (next: OutputSettings) => void;
  capabilities: Capabilities | null;
  capabilitiesLoading: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const formats = capabilities?.delivery_formats ?? ['M4B'];

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Output"
        description="How the finished audiobook is packaged. These apply when the audiobook is assembled."
      />
      <PanelBody className="space-y-5">
        {capabilitiesLoading ? (
          <SkeletonText lines={3} />
        ) : (
          <ChoiceGroup
            legend="Delivery formats"
            hint="At least one. Each format is produced from the same mastered audio."
          >
            {formats.map((format) => (
              <ChoiceOption
                key={format}
                type="checkbox"
                name="delivery-format"
                value={format}
                checked={value.deliveryFormats.includes(format)}
                title={format.replace(/_/g, ' ')}
                description={FORMAT_DESCRIPTIONS[format]}
                onChange={(formatValue, checked) => {
                  const next = checked
                    ? [...value.deliveryFormats, formatValue]
                    : value.deliveryFormats.filter((entry) => entry !== formatValue);
                  // The schema requires at least one format; refusing to empty
                  // the set is cheaper than a 422 the user has to read.
                  onChange({ ...value, deliveryFormats: next.length > 0 ? next : value.deliveryFormats });
                }}
              />
            ))}
          </ChoiceGroup>
        )}

        {capabilities?.degraded ? (
          <Notice tone="info" title="Voice capability information is unavailable">
            This deployment cannot currently report which voice engines are online, so the studio
            does not claim they are. Work is still accepted and queued normally.
          </Notice>
        ) : null}

        <div className="border-t border-[var(--border-subtle)] pt-4">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="advanced-settings"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
          >
            {advancedOpen ? 'Hide advanced settings' : 'Advanced settings'}
          </button>

          <div id="advanced-settings" hidden={!advancedOpen} className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="generation-priority"
                className="block text-[13px] font-medium text-[var(--text-secondary)]"
              >
                Queue priority
              </label>
              <p className="mt-1 mb-2 text-[12px] text-[var(--text-muted)]">
                Where this work sits relative to your other productions. It does not make individual
                work faster.
              </p>
              <Select
                id="generation-priority"
                value={value.priority}
                onChange={(event) =>
                  onChange({ ...value, priority: event.target.value as OutputSettings['priority'] })
                }
              >
                <option value="INTERACTIVE">Interactive — ahead of longer runs</option>
                <option value="NORMAL">Normal</option>
                <option value="BULK">Bulk — behind everything else</option>
              </Select>
            </div>

            <ChoiceGroup legend="Redo behaviour">
              <ChoiceOption
                type="checkbox"
                name="force"
                value="force"
                checked={value.force}
                title="Redo work that already has valid output"
                description="Off by default: existing valid output is reused, which is faster and cheaper. Turning this on regenerates it and produces a new version — the old one stays downloadable and unchanged."
                onChange={(_v, checked) => onChange({ ...value, force: checked })}
              />
              <ChoiceOption
                type="checkbox"
                name="partial"
                value="partial"
                checked={value.allowPartialPreview}
                title="Allow a preview build from incomplete audio"
                description="Assembles an audiobook even though some passages are missing or invalid. Useful to hear a work in progress; not the finished product."
                onChange={(_v, checked) => onChange({ ...value, allowPartialPreview: checked })}
              />
            </ChoiceGroup>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

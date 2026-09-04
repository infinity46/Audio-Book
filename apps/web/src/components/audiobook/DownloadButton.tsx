'use client';

import { useState } from 'react';
import { post } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/States';
import type { AccessUrl } from '@/lib/api/types';

/**
 * Download (Phase 9 rules 64, 65, 127, 181, 182).
 *
 * The flow is: mint a short-lived signed URL, then hand the browser that URL.
 * Nothing about object storage — no bucket, no key, no permanent credential —
 * is ever in the client (rule 65), and no path is ever built from user input:
 * the request path is composed from ids the API itself returned (rule 127).
 *
 * "Preparing download" is shown **only while the URL is actually being minted**
 * (rule 181), which is a real server round trip, and the button appears only
 * when the caller has established the artifact is ready (rule 182).
 */
export function DownloadButton({
  accessUrlPath,
  label = 'Download audiobook',
  disabled,
  disabledReason,
  variant = 'primary',
}: {
  accessUrlPath: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'secondary';
}) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const start = async () => {
    setPreparing(true);
    setError(null);
    try {
      const access = await post<AccessUrl>(accessUrlPath, {
        body: { disposition: 'ATTACHMENT', expires_in_seconds: 900 },
      });
      // Navigating to the signed URL starts the transfer from storage directly.
      // The bytes never pass through this application (rule 63).
      window.location.href = access.url;
    } catch (err) {
      setError(err);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div>
      <Button
        variant={variant}
        onClick={() => void start()}
        loading={preparing}
        disabled={disabled}
        disabledReason={disabledReason}
      >
        {preparing ? 'Preparing download…' : label}
      </Button>
      {error ? <ErrorState error={error} compact className="mt-3" /> : null}
    </div>
  );
}

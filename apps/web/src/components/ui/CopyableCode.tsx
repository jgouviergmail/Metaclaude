/**
 * A one-line value with a copy button — TOTP secrets, shell commands,
 * pairing links. Lifted out of SettingsPage the day a second screen needed it.
 */

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { copyToClipboard } from '@/lib/utils';

export function CopyableCode({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-caption text-ink">
        {value}
      </code>
      <Button
        variant="secondary"
        size="icon"
        aria-label={label ?? 'Copy'}
        onClick={() => {
          void copyToClipboard(value).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

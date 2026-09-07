/**
 * What the machine is doing, as three meters.
 *
 * The same component serves the dashboard, where it answers "is the box
 * coping?", and Settings → System, where it sits beside the version and the
 * uptime. One implementation because the two would otherwise drift, and the
 * question they answer is identical.
 *
 * Every figure is nullable and the nulls are the interesting part: production
 * is a container on Linux with cgroup v2, development is bare macOS or
 * Windows where none of those files exist. An unmeasured figure renders as a
 * dash and an empty track — never as 0%, which would draw a confident idle
 * machine while a run is under way.
 */

import { Cpu, HardDrive, MemoryStick } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SystemResources } from '@metaclaude/shared';
import { Meter } from '@/components/ui/primitives';
import { usePlural, useT } from '@/lib/i18n';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Where a usage meter turns from information into a warning.
 *
 * The same figures the doctor uses for disk, so the colour on the dashboard
 * and the verdict in Settings → System cannot disagree.
 */
const WARN_AT = 0.7;
const DANGER_AT = 0.9;

function toneFor(ratio: number | null): 'accent' | 'warning' | 'danger' {
  if (ratio === null) return 'accent';
  if (ratio >= DANGER_AT) return 'danger';
  if (ratio >= WARN_AT) return 'warning';
  return 'accent';
}

function percent(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)} %`;
}

export function ResourceMeters({
  resources,
  className,
}: {
  resources: SystemResources | undefined;
  className?: string;
}) {
  const t = useT();
  const plural = usePlural();

  const cpuRatio = resources?.cpu.usagePct != null ? resources.cpu.usagePct / 100 : null;

  /**
   * Two very different reasons for a null CPU reading, and only one of them
   * resolves itself.
   *
   * On the server it means "first poll since the restart" — usage is a rate,
   * so the reading arrives ten seconds later. On a developer's Windows or
   * macOS machine there is no `/sys/fs/cgroup` at all and it will never
   * arrive. "Measuring…" forever would be a lie told patiently.
   *
   * The tell is whether anything else on this platform could be measured:
   * `load1` comes from `/proc`, `usedBytes` from the cgroup, and a host with
   * neither has no way to answer the CPU question either.
   */
  const platformCanMeasure =
    resources != null && (resources.cpu.load1 != null || resources.memory.usedBytes != null);

  const { usedBytes, limitBytes } = resources?.memory ?? { usedBytes: null, limitBytes: null };
  const memoryRatio =
    usedBytes != null && limitBytes != null && limitBytes > 0 ? usedBytes / limitBytes : null;

  const { freeBytes, totalBytes } = resources?.disk ?? { freeBytes: null, totalBytes: null };
  const diskRatio =
    freeBytes != null && totalBytes != null && totalBytes > 0
      ? (totalBytes - freeBytes) / totalBytes
      : null;

  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-3', className)}>
      <ResourceMeter
        label={t('CPU')}
        icon={<Cpu />}
        ratio={cpuRatio}
        detail={
          cpuRatio !== null
            ? resources?.cpu.cores
              ? plural(resources.cpu.cores, 'of {n} core', 'of {n} cores')
              : undefined
            : platformCanMeasure
              ? t('Measuring…')
              : t('Not measurable here')
        }
        hint={
          resources?.cpu.load1 != null
            ? t('host load {n}', { n: resources.cpu.load1.toFixed(2) })
            : undefined
        }
      />
      <ResourceMeter
        // `RAM`, not `Memory`: the catalogue keys on the English string, and
        // `Memory` is already the navigation entry for the long-term memory
        // page. Reusing it would label this meter "Mémoire" in French.
        label={t('RAM')}
        icon={<MemoryStick />}
        ratio={memoryRatio}
        detail={
          usedBytes != null && limitBytes != null
            ? `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`
            : t('Not measurable here')
        }
        hint={
          resources?.memory.rssBytes != null
            ? t('this app {n}', { n: formatBytes(resources.memory.rssBytes) })
            : undefined
        }
      />
      <ResourceMeter
        label={t('Disk')}
        icon={<HardDrive />}
        ratio={diskRatio}
        detail={
          freeBytes != null && totalBytes != null
            ? t('{free} free of {total}', {
                free: formatBytes(freeBytes),
                total: formatBytes(totalBytes),
              })
            : t('Not measurable here')
        }
      />
    </div>
  );
}

function ResourceMeter({
  label,
  icon,
  ratio,
  detail,
  hint,
}: {
  label: string;
  icon: ReactNode;
  ratio: number | null;
  detail?: string;
  hint?: string;
}) {
  const tone = toneFor(ratio);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-eyebrow uppercase text-subtle">{label}</p>
        <span className="text-subtle [&>svg]:size-4">{icon}</span>
      </div>
      <p
        className={cn(
          'mt-2 text-display font-semibold tabular-nums tracking-tight',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          tone === 'accent' && 'text-ink',
        )}
      >
        {percent(ratio)}
      </p>
      <Meter value={ratio} tone={tone} label={`${label} ${percent(ratio)}`} className="mt-2" />
      {/* Two lines at most, and the second is context rather than the reading
          itself — at 375px the card is 100% of the width and anything longer
          wraps into a third line that pushes the grid out of alignment. */}
      {detail ? <p className="mt-2 truncate text-caption text-muted">{detail}</p> : null}
      {hint ? <p className="truncate text-caption text-subtle">{hint}</p> : null}
    </div>
  );
}

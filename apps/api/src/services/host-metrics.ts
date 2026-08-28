/**
 * What the machine is doing, from the files that carry it.
 *
 * Two vantage points, kept apart rather than blended. The cgroup gives the
 * *container's* figures, and those are the ones that decide whether this
 * process survives: the ceiling an OOM kill measures against is the cgroup's,
 * not the host's. `/proc` gives the host's, which is context — a box whose
 * load average is 12 explains a slow run that the container's own numbers
 * would not.
 *
 * Everything is read through injected functions and everything is nullable.
 * Production is Linux with cgroup v2; development is bare macOS or Windows,
 * where none of these paths exist. A missing measurement has to travel as
 * `null` all the way to the screen, because the alternative — a zero — draws a
 * confident empty meter on a machine that is actually working hard.
 */

/** cgroup v2, mounted at the same place in every container we ship. */
const CGROUP = '/sys/fs/cgroup';

/**
 * The shortest window a CPU percentage may be computed over.
 *
 * A second of cgroup usage is a measurement; two hundred milliseconds of it is
 * whatever the scheduler happened to be doing. One second is well under the
 * dashboard's ten-second poll, so a read from a single client is never
 * replayed.
 */
const MIN_SAMPLE_MS = 1_000;

export interface HostMetricsDeps {
  /** File contents, or null when the path does not exist. May reject. */
  readFile: (path: string) => Promise<string | null>;
  /** Free and total bytes for the filesystem holding a path. May reject. */
  statfs: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  /** This process's resident set size. */
  rss: () => number;
  /** Cores the host has, used when the container's quota is unbounded. */
  cpuCount: () => number;
  now: () => number;
}

export interface Resources {
  cpu: { usagePct: number | null; cores: number | null; load1: number | null };
  memory: {
    usedBytes: number | null;
    limitBytes: number | null;
    hostTotalBytes: number | null;
    rssBytes: number;
  };
  disk: { freeBytes: number | null; totalBytes: number | null };
}

/** A finite, non-negative number, or null. The only shape any figure may take. */
function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export class HostMetrics {
  /**
   * The previous CPU sample. Usage is a rate, so one reading answers nothing:
   * `usage_usec` is a counter since the cgroup was created, and dividing it by
   * an uptime nobody recorded would report the average since boot rather than
   * what is happening now.
   */
  private previous: { at: number; usageUsec: number } | null = null;

  /**
   * The last percentage computed, replayed for a read that arrives too soon.
   *
   * There is one instance of this class per process and any number of callers:
   * two browser tabs polling every ten seconds land a few hundred milliseconds
   * apart, and each read consumed the other's baseline. The window then
   * alternated between 200 ms and 9 800 ms, and a 200 ms window over a
   * scheduler that runs in bursts reports anything at all — the meter jumped
   * between 3% and 100% on an idle box. Below `MIN_SAMPLE_MS` the reading is
   * replayed and the baseline is left alone, so the next honest window is
   * measured against the last honest one.
   */
  private lastPct: number | null = null;

  constructor(private readonly deps: HostMetricsDeps) {}

  async read(dataDir: string): Promise<Resources> {
    const [memory, cpu, disk] = await Promise.all([
      this.memory(),
      this.cpu(),
      this.disk(dataDir),
    ]);
    return { cpu, memory, disk };
  }

  /** Read a file, treating any failure as absence. */
  private async text(path: string): Promise<string | null> {
    try {
      return await this.deps.readFile(path);
    } catch {
      return null;
    }
  }

  /** First whole number in a file, or null. */
  private async number(path: string): Promise<number | null> {
    const raw = await this.text(path);
    if (raw === null) return null;
    const trimmed = raw.trim();
    // `max` is cgroup v2 for "no limit". Deliberately not a huge number: a
    // ceiling of 9.2 exabytes would render as a meter permanently at 0%.
    if (trimmed === 'max' || !/^\d+$/.test(trimmed)) return null;
    return finite(Number(trimmed));
  }

  private async memory(): Promise<Resources['memory']> {
    const [usedBytes, limitBytes, meminfo] = await Promise.all([
      this.number(`${CGROUP}/memory.current`),
      this.number(`${CGROUP}/memory.max`),
      this.text('/proc/meminfo'),
    ]);

    // MemTotal is in kB, and says so on the line.
    const total = meminfo?.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const hostTotalBytes = total ? finite(Number(total[1]) * 1024) : null;

    return {
      usedBytes,
      limitBytes,
      hostTotalBytes,
      rssBytes: finite(this.deps.rss()) ?? 0,
    };
  }

  private async cpu(): Promise<Resources['cpu']> {
    const [stat, max, loadavg] = await Promise.all([
      this.text(`${CGROUP}/cpu.stat`),
      this.text(`${CGROUP}/cpu.max`),
      this.text('/proc/loadavg'),
    ]);

    // `cpu.max` is "<quota> <period>", both in microseconds, or "max <period>"
    // when the container may use the whole machine.
    let cores: number | null = null;
    const quota = max?.trim().split(/\s+/);
    if (quota && quota.length >= 2 && /^\d+$/.test(quota[0]!) && /^\d+$/.test(quota[1]!)) {
      const period = Number(quota[1]);
      cores = period > 0 ? finite(Number(quota[0]) / period) : null;
    }
    cores ??= finite(this.deps.cpuCount());
    if (cores !== null && cores <= 0) cores = null;

    const usagePct = this.sampleCpu(stat, cores);
    const load = loadavg?.trim().split(/\s+/)[0];
    const load1 = load !== undefined && /^\d+(\.\d+)?$/.test(load) ? finite(Number(load)) : null;

    return { usagePct, cores, load1 };
  }

  /**
   * Usage as a share of the allowance, from the change since the last read.
   *
   * Returns null in three cases that all mean the same thing — "this reading
   * cannot be trusted" — rather than a number that would be read as fact: no
   * previous sample, no time elapsed between the two, and a counter that went
   * backwards, which is what a restarted container looks like from here.
   */
  private sampleCpu(stat: string | null, cores: number | null): number | null {
    const match = stat?.match(/^usage_usec\s+(\d+)/m);
    if (!match) {
      this.previous = null;
      this.lastPct = null;
      return null;
    }

    const usageUsec = Number(match[1]);
    const at = this.deps.now();
    const previous = this.previous;
    const elapsedMs = previous ? at - previous.at : 0;

    // Too soon, but forwards: replay rather than consume the baseline. Done
    // before the baseline is overwritten, which is the whole point — see
    // `lastPct`. A clock that stepped *backwards* is not "too soon", it is a
    // broken baseline, and falls through to be discarded below.
    if (previous && elapsedMs >= 0 && elapsedMs < MIN_SAMPLE_MS) return this.lastPct;

    this.previous = { at, usageUsec };

    if (!previous || cores === null) return null;

    const usedUsec = usageUsec - previous.usageUsec;
    if (elapsedMs <= 0 || usedUsec < 0) {
      // A counter that went backwards is a restarted container, and a clock
      // that did is an NTP step. Either way the last reading no longer means
      // anything and must not be replayed as if it did.
      this.lastPct = null;
      return null;
    }

    // Microseconds of CPU over microseconds of wall clock, divided by the
    // cores the container may use, as a percentage.
    const pct = (usedUsec / (elapsedMs * 1000 * cores)) * 100;
    if (!Number.isFinite(pct)) return null;
    this.lastPct = Math.max(0, Math.min(100, pct));
    return this.lastPct;
  }

  private async disk(dataDir: string): Promise<Resources['disk']> {
    try {
      const { freeBytes, totalBytes } = await this.deps.statfs(dataDir);
      return { freeBytes: finite(freeBytes), totalBytes: finite(totalBytes) };
    } catch {
      // statfs is unavailable on some filesystems, and refuses outright on
      // others. Reporting nulls says "not measured"; reporting zeros would
      // say "full", which is the opposite of reassuring and equally wrong.
      return { freeBytes: null, totalBytes: null };
    }
  }
}

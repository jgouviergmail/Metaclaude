/**
 * What the machine is doing, read from the files that carry it.
 *
 * Every reader is injected, and that is the whole design: production is a
 * container on Linux with cgroup v2, development is bare macOS or Windows
 * where neither `/proc` nor `/sys/fs/cgroup` exists at all. A test that read
 * the real filesystem would pass or fail depending on whose machine ran it,
 * and would never exercise the branch that matters most — the one where
 * nothing can be measured.
 */

import { describe, expect, it } from 'vitest';
import { HostMetrics, type HostMetricsDeps } from './host-metrics.js';

const MB = 1024 * 1024;

/** cgroup v2 as a real container reports it: 2 cores of quota, 220 MB in use. */
const CGROUP: Record<string, string> = {
  '/sys/fs/cgroup/memory.current': '230502400\n',
  '/sys/fs/cgroup/memory.max': '2999975936\n',
  '/sys/fs/cgroup/cpu.max': '200000 100000\n',
  '/sys/fs/cgroup/cpu.stat': 'usage_usec 28909103\nuser_usec 23659490\nsystem_usec 5249612\n',
};

const PROC: Record<string, string> = {
  '/proc/meminfo': 'MemTotal:        3906292 kB\nMemFree:         1060004 kB\n',
  '/proc/loadavg': '0.63 0.28 0.19 1/248 638\n',
};

function make(overrides: Partial<HostMetricsDeps> = {}) {
  const files = { ...CGROUP, ...PROC };
  return new HostMetrics({
    readFile: async (path) => files[path] ?? null,
    statfs: async () => ({ freeBytes: 31 * 1024 * MB, totalBytes: 38 * 1024 * MB }),
    rss: () => 120 * MB,
    cpuCount: () => 2,
    now: () => 1_000_000,
    ...overrides,
  });
}

describe('memory', () => {
  it('reports the container’s own usage and ceiling, not the host’s', async () => {
    const { memory } = await make().read('/var/lib/metaclaude');

    expect(memory.usedBytes).toBe(230_502_400);
    expect(memory.limitBytes).toBe(2_999_975_936);
    // The host has 3.9 GB; the container may use 2.86. Blending them would
    // report headroom the container cannot actually use.
    expect(memory.hostTotalBytes).toBe(3_906_292 * 1024);
    expect(memory.rssBytes).toBe(120 * MB);
  });

  it('treats an unlimited cgroup as no ceiling rather than as a huge number', async () => {
    const metrics = make({
      readFile: async (path) =>
        path === '/sys/fs/cgroup/memory.max' ? 'max\n' : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    expect((await metrics.read('/x')).memory.limitBytes).toBeNull();
  });

  it('reports nulls rather than zeros where cgroup and /proc do not exist', async () => {
    const { memory, cpu } = await make({ readFile: async () => null }).read('/x');

    expect(memory.usedBytes).toBeNull();
    expect(memory.limitBytes).toBeNull();
    expect(memory.hostTotalBytes).toBeNull();
    expect(cpu.load1).toBeNull();
    // The process's own resident set is the one figure Node always knows.
    expect(memory.rssBytes).toBe(120 * MB);
  });
});

describe('cpu', () => {
  it('has nothing to report on the first read, because usage is a rate', async () => {
    const { cpu } = await make().read('/x');

    expect(cpu.usagePct).toBeNull();
    expect(cpu.cores).toBe(2);
  });

  it('measures the second read against the first', async () => {
    let clock = 1_000_000;
    let usageUsec = 28_909_103;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    // One second of wall clock, one core-second of CPU, two cores allowed.
    clock += 1000;
    usageUsec += 1_000_000;

    expect((await metrics.read('/x')).cpu.usagePct).toBeCloseTo(50, 5);
  });

  it('clamps to 100 rather than reporting more than the machine has', async () => {
    let clock = 1_000_000;
    let usageUsec = 0;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    clock += 1000;
    usageUsec += 9_000_000; // nine core-seconds in one second, on a two-core quota

    expect((await metrics.read('/x')).cpu.usagePct).toBe(100);
  });

  it('reports nothing rather than a spike when the clock has not moved', async () => {
    const metrics = make({ now: () => 1_000_000 });
    await metrics.read('/x');

    // Two reads inside the same millisecond: the denominator is zero, and a
    // division there is either Infinity or a number that means nothing.
    expect((await metrics.read('/x')).cpu.usagePct).toBeNull();
  });

  // Isolates the elapsed-time guard, which the case above does not: with the
  // clock frozen the arithmetic produces NaN and is caught further down
  // anyway, but with the clock *behind* it produces a negative that the clamp
  // would happily round up to a confident 0%. An NTP step backwards is all it
  // takes, and 0% during a run is a lie rather than an absence.
  it('reports nothing rather than 0% when the clock has stepped backwards', async () => {
    let clock = 1_000_000;
    let usageUsec = 1_000_000;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    clock -= 500;
    usageUsec += 400_000;

    expect((await metrics.read('/x')).cpu.usagePct).toBeNull();
  });

  it('survives a counter that goes backwards, which a restarted cgroup does', async () => {
    let usageUsec = 5_000_000;
    let clock = 1_000_000;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    clock += 1000;
    usageUsec = 1_000_000;

    expect((await metrics.read('/x')).cpu.usagePct).toBeNull();
  });

  /**
   * There is one instance per process and any number of callers. Two browser
   * tabs polling every ten seconds land a few hundred milliseconds apart, and
   * each read used to consume the other's baseline: the window alternated
   * between a fraction of a second and nearly ten, and a short window over a
   * scheduler that runs in bursts reports anything at all. The meter jumped
   * between 3% and 100% on an idle box, which is worse than no meter.
   */
  it('replays rather than measures a window too short to mean anything', async () => {
    let clock = 1_000_000;
    let usageUsec = 0;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    clock += 10_000;
    usageUsec += 5_000_000; // five core-seconds over ten, on a two-core quota
    expect((await metrics.read('/x')).cpu.usagePct).toBeCloseTo(25, 5);

    // The second tab, 200 ms later, during which the container did nothing at
    // all. Measured, that window says 0%; replayed, it says what the last
    // honest window said.
    clock += 200;
    expect((await metrics.read('/x')).cpu.usagePct).toBeCloseTo(25, 5);

    // And it did not eat the baseline: the next full window is measured
    // against the last honest one, not against the 200 ms read.
    clock += 9_800;
    usageUsec += 5_000_000;
    expect((await metrics.read('/x')).cpu.usagePct).toBeCloseTo(25, 5);
  });

  it('does not replay a stale reading once the baseline is broken', async () => {
    let clock = 1_000_000;
    let usageUsec = 0;
    const metrics = make({
      now: () => clock,
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.stat'
          ? `usage_usec ${usageUsec}\n`
          : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    await metrics.read('/x');
    clock += 10_000;
    usageUsec += 5_000_000;
    expect((await metrics.read('/x')).cpu.usagePct).toBeCloseTo(25, 5);

    // The container restarted: the counter is back at zero. Replaying 25%
    // here would report a figure for a process that has done nothing.
    clock += 10_000;
    usageUsec = 0;
    expect((await metrics.read('/x')).cpu.usagePct).toBeNull();

    clock += 100;
    expect((await metrics.read('/x')).cpu.usagePct).toBeNull();
  });

  it('falls back to the host’s core count when the quota is unbounded', async () => {
    const metrics = make({
      readFile: async (path) =>
        path === '/sys/fs/cgroup/cpu.max' ? 'max 100000\n' : ({ ...CGROUP, ...PROC })[path] ?? null,
    });

    expect((await metrics.read('/x')).cpu.cores).toBe(2);
  });

  it('reads the host load average, which is the box and not this container', async () => {
    expect((await make().read('/x')).cpu.load1).toBeCloseTo(0.63, 5);
  });
});

describe('disk', () => {
  it('reports free and total, so a proportion can be drawn', async () => {
    const { disk } = await make().read('/var/lib/metaclaude');

    expect(disk.freeBytes).toBe(31 * 1024 * MB);
    expect(disk.totalBytes).toBe(38 * 1024 * MB);
  });

  it('reports nulls when statfs refuses, rather than a full disk', async () => {
    const metrics = make({
      statfs: async () => {
        throw new Error('ENOSYS');
      },
    });
    const { disk } = await metrics.read('/x');

    expect(disk.freeBytes).toBeNull();
    expect(disk.totalBytes).toBeNull();
  });
});

describe('robustness', () => {
  it('never throws, whatever the files say', async () => {
    const metrics = make({
      readFile: async () => 'not a number at all\n ',
      statfs: async () => ({ freeBytes: Number.NaN, totalBytes: -1 }),
      rss: () => Number.NaN,
    });

    const resources = await metrics.read('/x');

    expect(resources.memory.usedBytes).toBeNull();
    expect(resources.cpu.cores).toBe(2);
    expect(resources.disk.freeBytes).toBeNull();
    expect(resources.memory.rssBytes).toBe(0);
  });

  it('a reader that rejects costs its own figure and nothing else', async () => {
    const metrics = make({
      readFile: async (path) => {
        if (path === '/proc/meminfo') throw new Error('EACCES');
        return ({ ...CGROUP, ...PROC })[path] ?? null;
      },
    });

    const resources = await metrics.read('/x');

    expect(resources.memory.hostTotalBytes).toBeNull();
    expect(resources.memory.usedBytes).toBe(230_502_400);
  });
});

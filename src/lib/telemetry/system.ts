import { hostname, arch, cpus, totalmem, freemem, uptime, platform, release, type } from "node:os";

/** One per-core CPU time sample summed across cores. */
export type CpuTimes = { idle: number; total: number };

/** Aggregate the CPU tick counters across all logical cores. */
export function snapshotCpuTimes(): CpuTimes {
  const cores = cpus();
  const sum = { idle: 0, total: 0 };
  for (const core of cores) {
    const t = core.times;
    // On Linux there is also an "irq" field; Windows reports user/sys/idle.
    const total =
      t.user + t.nice + t.sys + t.idle + (t.irq ?? 0);
    sum.idle += t.idle;
    sum.total += total;
  }
  return sum;
}

/** CPU busy % between two snapshots; null if the sample is unusable. */
export function cpuUsagePct(start: CpuTimes, end: CpuTimes): number | null {
  const idle = end.idle - start.idle;
  const total = end.total - start.total;
  if (total <= 0 || idle < 0) return null;
  const busy = total - idle;
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

/** Static facts about the host that never change during a run. */
export function staticSystem() {
  return {
    hostname: hostname(),
    platform: platform(),
    osType: type(),
    osRelease: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? null,
    cores: cpus().length,
    uptimeSec: uptime(),
    totalMem: totalmem(),
    usedMem: totalmem() - freemem(),
    availMem: freemem(),
  };
}

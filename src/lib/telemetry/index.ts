import {
  snapshotCpuTimes,
  cpuUsagePct,
  staticSystem,
} from "./system";
import {
  sampleInterfaces,
  physicalTotals,
  type InterfaceSample,
} from "./network";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type NetworkInfo = {
  rxTotal: number;
  txTotal: number;
  rxRate: number; // bytes/second
  txRate: number; // bytes/second
  sampleMs: number; // measurement window used for the rates
  interfaces: InterfaceSample[];
};

export type SystemInfo = ReturnType<typeof staticSystem> & {
  cpuUsagePct: number | null;
};

export type TelemetrySnapshot = {
  collectedAt: number;
  system: SystemInfo | null;
  network: NetworkInfo | null;
};

/**
 * Collect one telemetry snapshot. Two samples ~800ms apart give fresh
 * CPU-usage and network-rate readings. Each subsystem fails independently:
 * a failure yields null for that block rather than throwing.
 */
export async function collectTelemetry(): Promise<TelemetrySnapshot> {
  const collectedAt = Date.now();

  // CPU and network share one sampling window to keep latency low.
  const cpu0 = snapshotCpuTimes();
  const net0 = await sampleInterfaces();
  await sleep(800);
  const cpu1 = snapshotCpuTimes();
  const net1 = await sampleInterfaces();

  const system = (() => {
    try {
      return {
        ...staticSystem(),
        cpuUsagePct: cpuUsagePct(cpu0, cpu1),
      };
    } catch {
      return null;
    }
  })();

  const network = (() => {
    try {
      const samples = net1 ?? net0;
      if (!samples) return null;
      const t0 = physicalTotals(net0);
      const t1 = physicalTotals(net1);
      const rxRate = net0 && net1 ? Math.max(0, (t1.rx - t0.rx) / 0.8) : 0;
      const txRate = net0 && net1 ? Math.max(0, (t1.tx - t0.tx) / 0.8) : 0;
      return {
        rxTotal: t1.rx,
        txTotal: t1.tx,
        rxRate,
        txRate,
        sampleMs: 800,
        interfaces: samples,
      };
    } catch {
      return null;
    }
  })();

  return { collectedAt, system, network };
}

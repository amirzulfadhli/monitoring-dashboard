export type NetStatus = {
  tone: "good" | "warn" | "critical";
  label: string;
};

export type NetworkMetrics = {
  status: NetStatus;
  downloadMbps: number;
  uploadMbps: number;
  pingMs: number;
  jitterMs: number;
  packetLossPct: number;
  // Cumulative traffic this session.
  downloadTrafficMB: number;
  uploadTrafficMB: number;
};

export const timeRanges = ["Live", "1H", "24H", "7D", "30D"] as const;

export type TrafficPoint = { down: number; up: number };

// Round to one decimal to keep the payload tidy.
const r1 = (n: number) => Math.round(n * 10) / 10;

// Deterministic pseudo-live series (Mbps), one sample per minute over ~1h.
// Swap for a real collector later; shape of {down, up} is the contract.
export const trafficSeries: TrafficPoint[] = Array.from({ length: 60 }, (_, i) => {
  const drift = 42 + Math.sin(i / 9) * 10 + (i % 11) * 0.4;
  const down = Math.max(6, r1(drift + ((i * 53) % 9) - 4));
  const up = Math.max(2, r1(down * 0.18 + Math.sin(i / 4) * 3));
  return { down, up };
});

export const networkMetrics: NetworkMetrics = {
  status: { tone: "good", label: "Operational" },
  downloadMbps: 84.6,
  uploadMbps: 21.3,
  pingMs: 12,
  jitterMs: 2.1,
  packetLossPct: 0.0,
  downloadTrafficMB: 1284.2,
  uploadTrafficMB: 312.8,
};

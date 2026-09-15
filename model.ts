export type TraceStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";
export interface EventRow {
  id: string;
  seq: number;
  createdAt: number;
  type: string;
  scope: { kind: string; turnId?: string };
  data: Record<string, unknown>;
}
export interface ThreadSummary {
  id: string;
  title: string;
  provider: string;
  status: string;
  updatedAt: number;
  projectId: string | null;
}
export interface TraceSpan {
  id: string;
  parentId: string | null;
  turnId: string;
  name: string;
  kind: string;
  status: TraceStatus;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  timing: "reported" | "observed" | "unknown";
  sourceSeq: number;
  detailSeq: number;
  summary: string;
}
export interface TraceTurn {
  id: string;
  label: string;
  model: string | null;
  status: TraceStatus;
  startedAt: number | null;
  endedAt: number | null;
  spanCount: number;
  toolCount: number;
  errorCount: number;
}
export interface TraceUsage {
  input: number;
  output: number;
  cached: number;
  total: number;
}
export interface TraceProjection {
  turns: TraceTurn[];
  spans: TraceSpan[];
  usage: TraceUsage | null;
}
export interface TraceResult extends TraceProjection {
  thread: ThreadSummary;
  hasOlder: boolean;
  limit: number;
  eventCount: number;
  lastSeq: number;
  warnings: string[];
  fetchedAt: number;
}
export interface SpanDetail {
  input: string;
  output: string;
  metadata: string;
  events: { seq: number; type: string; time: number }[];
  truncated: boolean;
}

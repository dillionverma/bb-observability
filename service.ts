import { extractUsage } from "./usage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EventRow, SpanDetail, ThreadSummary, TraceResult } from "./model";
import { buildTrace } from "./trace";

type Threads = BbPluginApi["sdk"]["threads"];
const EVENT_TYPES = [
  "client/turn/requested", "client/turn/rejected", "client/turn/start", "client/thread/start", "turn/started", "turn/input/accepted",
  "turn/completed", "item/started", "item/completed", "item/delegation/completed",
  "item/backgroundTask/completed", "thread/tokenUsage/updated", "provider/error",
  "provider/warning", "provider/modelFallback", "system/error", "system/operation",
  "system/thread/interrupted", "thread/context/cleared",
] as const;
const CACHE_MS = 4000;
const CACHE_SIZE = 6;
const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret)$/i;

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Cache only small summaries; fetch full payloads when an operation is selected. */
export function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 400);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 5) return "…";
  if (Array.isArray(value)) return value.slice(0, 8).map(v => compact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record(value)).slice(0, 35)) out[key] = SECRET_KEY.test(key) ? "[masked]" : compact(entry, depth + 1);
  return out;
}

export function summarizeThread(value: unknown): ThreadSummary {
  const row = record(value);
  return {
    id: String(row.id), title: String(row.title || row.titleFallback || "Untitled thread").slice(0, 200),
    provider: String(row.providerId || "unknown"), status: String(record(row.runtime).displayStatus || row.status || "unknown"),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
    projectId: typeof row.projectId === "string" ? row.projectId : null,
  };
}

function oversized(error: unknown): boolean {
  return /event_data_too_large|too large|413|8 MiB/i.test(error instanceof Error ? error.message : String(error));
}

export function formatPayload(value: unknown, max = 32000): { text: string; truncated: boolean } {
  if (value === undefined || value === null) return { text: "Not recorded", truncated: false };
  let shortened = false;
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, val: unknown) => {
    if (SECRET_KEY.test(key)) return "[masked]";
    if (typeof val === "string" && val.length > max) { shortened = true; return val.slice(0, max) + "…"; }
    if (Array.isArray(val) && val.length > 200) { shortened = true; return [...val.slice(0, 200), "…"]; }
    return val;
  }, 2);
  const truncated = shortened || text.length > max;
  return { text: text.slice(0, max) + (truncated ? "\n… (preview truncated)" : ""), truncated };
}

interface CachedTrace { result: TraceResult; events: EventRow[]; }

export class TraceService {
  private cache = new Map<string, CachedTrace>();
  private inflight = new Map<string, Promise<CachedTrace>>();
  private generation = 0;
  private lifecycle = new AbortController();
  constructor(private threads: Threads, private now = Date.now) {}
  dispose() { this.lifecycle.abort(); this.cache.clear(); this.inflight.clear(); }
  invalidate(threadId: string) {
    this.generation++;
    for (const [key, entry] of this.cache) if (entry.result.thread.id === threadId) this.cache.delete(key);
  }

  async list(input: { offset: number; projectId?: string; query?: string }) {
    if (input.query?.trim()) {
      const result = await this.threads.search({ query: input.query.trim(), limitPerGroup: "50", signal: this.lifecycle.signal });
      const matches = [...result.active.results, ...result.archived.results].map(x => x.thread).filter(x => !input.projectId || x.projectId === input.projectId);
      return { threads: matches.map(summarizeThread), hasMore: false };
    }
    const rows = await this.threads.list({ ...(input.projectId ? { projectId: input.projectId } : {}), offset: input.offset, limit: 50, includeHidden: false, signal: this.lifecycle.signal });
    return { threads: rows.map(summarizeThread), hasMore: rows.length === 50 };
  }

  async trace(threadId: string, limit: number, refresh = false): Promise<TraceResult> {
    return (await this.load(threadId, limit, refresh)).result;
  }

  private async load(threadId: string, limit: number, refresh: boolean): Promise<CachedTrace> {
    const key = `${threadId}:${limit}`;
    const cached = this.cache.get(key);
    if (!refresh && cached && this.now() - cached.result.fetchedAt < CACHE_MS) {
      this.cache.delete(key); this.cache.set(key, cached); return cached;
    }
    const current = this.inflight.get(key);
    if (current) return current;
    const version = this.generation;
    const pending = this.read(threadId, limit).then(result => {
      if (!this.lifecycle.signal.aborted && version === this.generation) {
        this.cache.delete(key); this.cache.set(key, result);
        while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      }
      return result;
    }).finally(() => { if (this.inflight.get(key) === pending) this.inflight.delete(key); });
    this.inflight.set(key, pending);
    return pending;
  }

  private async read(threadId: string, limit: number, retry = true): Promise<CachedTrace> {
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(20000)]);
    const thread = await this.threads.get({ threadId, signal });
    if (thread.deletedAt !== null) throw new Error("This thread was deleted.");
    const events: EventRow[] = [];
    const warnings: string[] = [];
    let beforeSeq: string | undefined;
    let pageSize = 100;
    let exhausted = false;
    let bytes = 0;
    while (events.length <= limit && !signal.aborted) {
      const count = Math.min(pageSize, limit + 1 - events.length);
      let rows: EventRow[];
      try {
        rows = await this.threads.events.list({ threadId, beforeSeq, limit: String(count), order: "desc", types: EVENT_TYPES, signal }) as EventRow[];
      } catch (error) {
        if (!oversized(error)) throw error;
        if (count > 1) { pageSize = Math.max(1, Math.floor(count / 2)); continue; }
        warnings.push("A recorded event is too large to read. This view contains only the available history."); break;
      }
      if (!rows.length) { exhausted = true; break; }
      for (const row of rows) {
        const slim = { ...row, data: compact(row.data) as Record<string, unknown>,
          operationUsage: extractUsage(record(row.data.item)),
        };
        bytes += JSON.stringify(slim).length;
        if (bytes > 4_000_000) break;
        events.push(slim);
      }
      if (bytes > 4_000_000) { warnings.push("The preview reached its size limit. Select a smaller history window for details."); break; }
      beforeSeq = String(rows.at(-1)!.seq);
      if (rows.length < count) { exhausted = true; break; }
    }
    const lastSeq = events[0]?.seq ?? 0;
    const changes = await this.threads.events.list({ threadId, afterSeq: String(lastSeq), limit: "100", types: ["system/operation"], signal });
    const rewritten = changes.some(row => record(row.data).operation === "edit_message" && record(row.data).status === "completed");
    if (rewritten && retry) return this.read(threadId, limit, false);
    if (rewritten) throw new Error("History changed while loading. Refresh to read the updated trace.");
    const hasOlder = !exhausted || events.length > limit;
    const window = events.slice(0, limit).reverse();
    if (hasOlder) warnings.push(`Showing the latest ${window.length} trace events. Earlier starts or turns may be outside this view.`);
    return {
      result: { ...buildTrace(window, thread.status), thread: summarizeThread(thread), hasOlder, limit,
        eventCount: window.length, lastSeq, warnings, fetchedAt: this.now() }, events: window,
    };
  }

  async detail(threadId: string, spanId: string, limit: number): Promise<SpanDetail> {
    const trace = await this.load(threadId, limit, false);
    const span = trace.result.spans.find(s => s.id === spanId);
    if (!span) throw new Error("This operation was removed, replaced, or is outside the loaded history.");
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(10000)]);
    const rows = await this.threads.events.list({ threadId, afterSeq: String(span.detailSeq - 1), beforeSeq: String(span.detailSeq + 1), limit: "1", signal });
    const source = rows.find(row => row.seq === span.detailSeq);
    if (!source) throw new Error("This operation was removed or replaced. Refresh the trace.");
    const data = record(source.data);
    const item = record(data.item);
    const kind = String(item.type ?? "error");
    let input: unknown;
    let output: unknown;
    switch (kind) {
      case "toolCall": case "mcpToolCall": input = item.arguments; output = item.result ?? item.error; break;
      case "commandExecution": input = { command: item.command, cwd: item.cwd }; output = item.aggregatedOutput ?? item.output ?? item.error; break;
      case "fileChange": input = item.changes; output = item.output ?? item.diff ?? item.error; break;
      case "agentMessage": case "reasoning": input = undefined; output = item.text || (Array.isArray(item.content) && !item.content.length ? undefined : item.content) || item.summary; break;
      case "delegation": input = { label: item.label, childRef: item.childRef, background: item.background }; output = item.summary; break;
      case "fileRead": input = item.path ?? item.paths; output = item.content ?? item.result; break;
      case "webSearch": input = item.queries ?? item.query ?? item.action; output = item.resultText ?? item.results ?? item.result; break;
      case "webFetch": input = item.url; output = item.resultText ?? item.content ?? item.result; break;
      default: input = item.arguments ?? item.input; output = item.result ?? item.output ?? item.summary ?? data.error ?? data.message;
    }
    const rendered = [formatPayload(input), formatPayload(output), formatPayload({
      type: kind, status: span.status, timing: span.timing, durationMs: span.durationMs,
      reportedDurationMs: item.durationMs ?? null, threadId, sourceSequence: source.seq,
      item: Object.keys(item).length ? item : data,
    })];
    return {
      input: rendered[0].text, output: rendered[1].text, metadata: rendered[2].text,
      truncated: rendered.some(v => v.truncated) || Object.keys(record(item.truncation)).length > 0 || item.aggregatedOutputTruncated === true || item.outputTruncated === true,
      events: trace.events.filter(e => e.seq === span.sourceSeq || e.seq === span.detailSeq).map(e => ({ seq: e.seq, type: e.type, time: e.createdAt })),
    };
  }
}

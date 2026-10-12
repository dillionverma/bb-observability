import { extractUsage } from "./usage";
import type { EventRow, TraceProjection, TraceSpan, TraceStatus, TraceTurn, TraceUsage } from "./model";

type RecordValue = Record<string, unknown>;
type TurnState = { turn: TraceTurn; firstSeq: number; hasLabel: boolean; items: Map<string, SpanState> };
type SpanState = { span: TraceSpan; parentItemId: string | null; complete: boolean };
type RequestState = { row: EventRow; turn: TurnState; bound: boolean };

const toolKinds = new Set([
  "toolCall", "mcpToolCall", "commandExecution", "fileRead", "fileChange", "search",
  "webSearch", "webFetch", "imageGeneration", "imageView", "delegation", "backgroundTask",
]);
const activeThreads = new Set(["active", "pending", "starting", "stopping"]);
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Keep list responses small, plain text, and independent of raw payload sizes. */
function text(value: unknown, limit = 180): string {
  const normalized = string(value).slice(0, 4000)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function inputText(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  return text(value.slice(0, 8).map((part) => {
    const content = record(part);
    return content.visibility === "agent-only" ? "" : string(content.text).slice(0, 180);
  }).join(" "));
}

function status(value: unknown, fallback: TraceStatus): TraceStatus {
  if (value === "completed" || value === "failed" || value === "interrupted") return value;
  if (value === "pending" || value === "running") return "running";
  return fallback;
}

function itemName(item: RecordValue): string {
  const names: Record<string, string> = {
    agentMessage: "Response", reasoning: "Reasoning", fileRead: "Read file", fileChange: "File changes",
    commandExecution: "Command", webSearch: "Web search", webFetch: "Fetch page", search: "Search",
    imageGeneration: "Generate image", imageView: "View image", delegation: "Agent", backgroundTask: "Background task",
    contextCompaction: "Compaction", plan: "Plan",
  };
  const kind = string(item.type);
  const named = kind === "toolCall" || kind === "mcpToolCall" ? item.tool
    : kind === "commandExecution" ? item.command
      : kind === "delegation" ? item.label
        : kind === "backgroundTask" ? item.description : null;
  return text(named || record(item.presentation).title || names[kind] || kind || "Activity", 120);
}

function itemSummary(item: RecordValue): string {
  if (item.error) return text(typeof item.error === "string" ? item.error : record(item.error).message);
  if (item.type === "agentMessage") return text(item.text);
  if (item.type === "reasoning") return text(Array.isArray(item.summary) ? item.summary.slice(0, 3).join(" ") : "");
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    return text(item.changes.slice(0, 4).map((change) => string(record(change).path)).join(", "));
  }
  return text(item.summary || record(item.presentation).detail || item.path || item.query || item.url || item.cwd);
}

/** Project the current bounded history. No timing is invented for missing lifecycle events. */
export function buildTrace(inputEvents: EventRow[], threadStatus: string): TraceProjection {
  const unique = new Map(inputEvents.map((event) => [event.seq, event]));
  let events = [...unique.values()].sort((a, b) => a.seq - b.seq);
  // A snapshot can race a history edit. Only the verified deleted range is removed.
  for (const event of events) {
    if (event.type !== "system/operation" || event.data.operation !== "edit_message" || event.data.status !== "completed") continue;
    const metadata = record(event.data.metadata);
    const cutoff = number(metadata.cutoffSequence);
    const oldMax = number(metadata.oldMaxSequence);
    if (cutoff !== null && oldMax !== null && cutoff <= oldMax && oldMax < event.seq) {
      events = events.filter((row) => row.seq < cutoff || row.seq > oldMax);
    }
  }

  const bindings = new Map<string, string>();
  for (const row of events) {
    const turnId = row.scope.kind === "turn" ? row.scope.turnId : undefined;
    const item = record(row.data.item);
    const requestId = row.type === "turn/input/accepted" ? row.data.clientRequestId
      : item.type === "userMessage" ? item.clientRequestId : undefined;
    if (turnId && typeof requestId === "string") bindings.set(requestId, turnId);
  }

  const turns = new Map<string, TurnState>();
  const requests = new Map<string, RequestState>();
  let latestRequest: RequestState | undefined;
  let activeTurn: TurnState | undefined;
  let usage: TraceUsage | null = null;

  function ensureTurn(id: string, seq: number): TurnState {
    let state = turns.get(id);
    if (!state) {
      state = {
        turn: { id, label: "", model: null, status: "running", startedAt: null, endedAt: null, spanCount: 0, toolCount: 0, errorCount: 0 },
        firstSeq: seq, hasLabel: false, items: new Map(),
      };
      turns.set(id, state);
    }
    return state;
  }

  function setLabel(state: TurnState, label: string, model: unknown = null) {
    if (label && !state.hasLabel) { state.turn.label = label; state.hasLabel = true; }
    if (typeof model === "string") state.turn.model = text(model, 120);
  }

  function bindRequest(request: RequestState, turnId: string): TurnState {
    const previous = request.turn;
    const state = ensureTurn(turnId, previous.firstSeq);
    if (previous !== state) {
      setLabel(state, previous.turn.label, previous.turn.model);
      state.firstSeq = Math.min(state.firstSeq, previous.firstSeq);
      for (const [key, value] of previous.items) {
        value.span.turnId = turnId;
        state.items.set(key, value);
      }
      turns.delete(previous.turn.id);
      request.turn = state;
    }
    request.bound = true;
    return state;
  }

  function scopedTurn(row: EventRow): TurnState {
    if (row.scope.kind === "turn" && row.scope.turnId) return ensureTurn(row.scope.turnId, row.seq);
    return latestRequest && (!latestRequest.bound || latestRequest.turn.turn.startedAt === null) ? latestRequest.turn
      : activeTurn ?? ensureTurn(`unscoped:${row.seq}`, row.seq);
  }

  function addError(row: EventRow, state: TurnState, message: unknown) {
    const span: TraceSpan = {
      id: `error:${row.seq}`, turnId: state.turn.id, parentId: null,
      name: row.type === "client/turn/rejected" ? "Request rejected" : row.type === "system/error" ? "System error" : "Provider error",
      kind: "error", status: "failed", startedAt: row.createdAt, endedAt: row.createdAt,
      durationMs: 0, timing: "observed", sourceSeq: row.seq, detailSeq: row.seq, summary: text(message),
    };
    state.items.set(`error:${row.seq}`, { span, parentItemId: null, complete: true });
  }

  for (const row of events) {
    const data = row.data;
    if (row.type === "thread/tokenUsage/updated") {
      const total = record(record(data.tokenUsage).total);
      if (number(total.totalTokens) !== null) usage = {
        input: number(total.inputTokens) ?? 0, output: number(total.outputTokens) ?? 0,
        cached: number(total.cachedInputTokens) ?? 0, total: number(total.totalTokens)!,
      };
      continue;
    }
    if (row.type === "client/turn/requested") {
      const requestId = string(data.requestId) || `request:${row.seq}`;
      const boundId = bindings.get(requestId);
      const state = ensureTurn(boundId ?? `request:${row.seq}`, row.seq);
      const params = record(record(data.request).params);
      setLabel(state, inputText(data.input || params.input), record(data.execution).model || params.model);
      latestRequest = { row, turn: state, bound: Boolean(boundId) };
      requests.set(requestId, latestRequest);
      continue;
    }
    if (row.type === "client/turn/start" || row.type === "client/thread/start") {
      const params = record(record(data.request).params);
      // Older providers only recorded this outbound event; modern ones also record a request.
      if (!latestRequest || latestRequest.turn.turn.endedAt !== null) {
        latestRequest = { row, turn: ensureTurn(`request:${row.seq}`, row.seq), bound: false };
        requests.set(`request:${row.seq}`, latestRequest);
      }
      setLabel(latestRequest.turn, inputText(params.input), params.model);
      continue;
    }
    if (row.type === "turn/started") {
      const turnId = row.scope.kind === "turn" ? row.scope.turnId : undefined;
      if (!turnId) continue;
      const state = latestRequest && !latestRequest.bound && latestRequest.turn.turn.status === "running"
        ? bindRequest(latestRequest, turnId) : ensureTurn(turnId, row.seq);
      if (state.turn.startedAt === null) state.turn.startedAt = row.createdAt;
      activeTurn = state;
      continue;
    }
    if (row.type === "turn/input/accepted") {
      const request = requests.get(string(data.clientRequestId));
      if (request && row.scope.turnId) bindRequest(request, row.scope.turnId);
      continue;
    }
    if (row.type === "client/turn/rejected") {
      const state = requests.get(string(data.requestId))?.turn ?? ensureTurn(`request:${row.seq}`, row.seq);
      state.turn.status = "failed";
      state.turn.endedAt = row.createdAt;
      addError(row, state, data.message || data.reason);
      continue;
    }
    if (row.type === "provider/error" || row.type === "system/error") {
      const state = scopedTurn(row);
      addError(row, state, data.message || data.detail);
      if (data.willRetry !== true && state.turn.startedAt === null) {
        state.turn.status = "failed";
        state.turn.endedAt = row.createdAt;
      }
      continue;
    }
    if (row.type === "turn/completed") {
      const state = scopedTurn(row);
      state.turn.status = status(data.status, "unknown");
      state.turn.endedAt = row.createdAt;
      const message = record(data.error).message;
      if (message && ![...state.items.values()].some((item) => item.span.kind === "error" && item.span.summary === text(message))) addError(row, state, message);
      if (activeTurn === state) activeTurn = undefined;
      continue;
    }
    if (row.type === "system/thread/interrupted") {
      const state = row.scope.turnId ? scopedTurn(row) : activeTurn ?? latestRequest?.turn;
      if (state && state.turn.status === "running") {
        state.turn.status = "interrupted";
        state.turn.endedAt = row.createdAt;
      }
      activeTurn = undefined;
      continue;
    }
    if (row.type === "provider/modelFallback") {
      scopedTurn(row).turn.model = text(data.fallbackModel, 120) || null;
      continue;
    }
    if (!row.type.startsWith("item/")) continue;
    const item = record(data.item);
    if (!item.type || !item.id) continue; // Deltas are not complete snapshots.
    const state = scopedTurn(row);
    if (item.type === "userMessage") {
      setLabel(state, inputText(item.content));
      continue;
    }
    const itemId = string(item.id);
    const isStart = row.type === "item/started";
    const isComplete = row.type === "item/completed" || row.type.endsWith("/completed");
    let entry = state.items.get(itemId);
    if (!entry) {
      entry = {
        span: {
          id: `span:${row.seq}:${itemId}`, parentId: null, turnId: state.turn.id,
          name: itemName(item), kind: string(item.type), status: "running",
          startedAt: isStart ? row.createdAt : null, endedAt: null, durationMs: null, timing: "unknown",
          sourceSeq: row.seq, detailSeq: row.seq, summary: "",
        },
        parentItemId: string(item.parentToolCallId) || null, complete: false,
      };
      state.items.set(itemId, entry);
    }
    const span = entry.span;
    if (entry.complete && isStart) continue;
    span.detailSeq = row.seq;
    span.name = itemName(item);
    span.summary = itemSummary(item);
    const operationUsage = row.operationUsage ?? extractUsage(item);
    if (!span.operationUsage) span.operationUsage = operationUsage;
    else {
      if (operationUsage.tool) span.operationUsage.tool = operationUsage.tool;
      const retainsServer = operationUsage.toolOrigin === "MCP" && span.operationUsage.toolOrigin?.startsWith("MCP · ");
      if (operationUsage.toolOrigin && !retainsServer) span.operationUsage.toolOrigin = operationUsage.toolOrigin;
      if (operationUsage.toolIdentity && !retainsServer && (operationUsage.toolOrigin || !span.operationUsage.toolIdentity)) span.operationUsage.toolIdentity = operationUsage.toolIdentity;
      const skills = new Map(span.operationUsage.skills.map(skill => [`${skill.evidence}:${skill.source}`, skill]));
      for (const skill of operationUsage.skills) {
        const key = `${skill.evidence}:${skill.source}`;
        skills.set(key, { ...skills.get(key), ...skill });
      }
      span.operationUsage.skills = [...skills.values()].slice(0, 32);
    }
    entry.parentItemId = string(item.parentToolCallId) || entry.parentItemId;
    if (isStart && span.startedAt === null && !entry.complete) span.startedAt = row.createdAt;
    // Replayed start snapshots must not reopen a completed tool.
    if (!entry.complete || isComplete) {
      span.status = status(item.status, isComplete ? "completed" : "running");
      if (item.approvalStatus === "denied" || typeof item.exitCode === "number" && item.exitCode !== 0 || item.error) span.status = "failed";
      if (isComplete || span.status === "completed" || span.status === "failed" || span.status === "interrupted") {
        entry.complete = true;
        span.endedAt ??= row.createdAt;
      }
    }
    const reported = number(item.durationMs) ?? number(record(item.usage).durationMs);
    if (reported !== null) { span.durationMs = reported; span.timing = "reported"; }
    else if (span.timing !== "reported" && span.startedAt !== null && span.endedAt !== null && span.endedAt >= span.startedAt) {
      span.durationMs = span.endedAt - span.startedAt;
      span.timing = "observed";
    }
  }

  const ordered = [...turns.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  const spans: TraceSpan[] = [];
  for (const [index, state] of ordered.entries()) {
    const turn = state.turn;
    if (!state.hasLabel) turn.label = turn.id.startsWith("request:") ? "Request" : `Turn ${index + 1}`;
    if (turn.status === "running" && (!activeThreads.has(threadStatus) || state !== (activeTurn ?? ordered.at(-1)))) {
      turn.status = threadStatus === "interrupted" ? "interrupted" : "unknown";
    }
    for (const [itemId, entry] of state.items) {
      const span = entry.span;
      if (!entry.complete && turn.status !== "running") span.status = turn.status === "interrupted" ? "interrupted" : "unknown";
      // Accept only local, acyclic parent edges. Missing parents remain roots.
      const ancestors = new Set([itemId]);
      let parentId = entry.parentItemId;
      let valid = parentId !== null && state.items.has(parentId);
      while (parentId && valid) {
        if (ancestors.has(parentId)) { valid = false; break; }
        ancestors.add(parentId);
        parentId = state.items.get(parentId)?.parentItemId ?? null;
      }
      if (valid && entry.parentItemId) span.parentId = state.items.get(entry.parentItemId)!.span.id;
      turn.spanCount++;
      if (toolKinds.has(span.kind)) turn.toolCount++;
      if (span.status === "failed") turn.errorCount++;
      spans.push(span);
    }
  }
  return { turns: ordered.map((state) => state.turn), spans, usage };
}

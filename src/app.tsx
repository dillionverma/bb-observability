import { groupUsage, type UsageGroup } from "./traces/usage";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./traces/contract";
import type {
  SpanDetail,
  ThreadSummary,
  TraceResult,
  TraceSpan,
} from "./traces/model";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import "./app.css";

const number = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactNumber = new Intl.NumberFormat();
const ROW_HEIGHT = 36;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const toolKinds = new Set([
  "toolCall",
  "commandExecution",
  "fileRead",
  "fileChange",
  "webSearch",
  "webFetch",
  "delegation",
]);
export function duration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
const timestamp = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Keep wire methods current without making hook identity drive request loops. */
function useClient() {
  const rpc = useRpc<typeof rpcContract>();
  const ref = useRef(rpc);
  ref.current = rpc;
  return ref;
}
function useRefreshSignals(
  refresh: () => void,
  threadId?: string,
  delay = 500,
) {
  const callback = useRef(refresh);
  callback.current = refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(
    (payload: unknown) => {
      if (
        threadId &&
        (!payload ||
          typeof payload !== "object" ||
          !("threadId" in payload) ||
          payload.threadId !== threadId)
      )
        return;
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (document.visibilityState !== "hidden") callback.current();
      }, delay);
    },
    [threadId, delay],
  );
  useRealtime("changed", schedule);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected")
      callback.current();
    previous.current = connection;
  }, [connection]);
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden") callback.current();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") callback.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      if (timer.current !== null) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return connection;
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="tr-empty" role="status">
      {children}
    </div>
  );
}
function ErrorNotice({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="tr-error" role="alert">
      <Icon name="AlertCircle" />
      <span>{error}</span>
      <Button variant="ghost" size="sm" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
function Status({ status }: { status: string }) {
  status =
    status === "active" ? "running" : status === "error" ? "failed" : status;
  return (
    <span className={`tr-status tr-status-${status}`}>
      <i aria-hidden="true" />
      {status}
    </span>
  );
}

function ThreadList({
  selected,
  select,
  hidden,
}: {
  selected: string;
  select: (id: string) => void;
  hidden: boolean;
}) {
  const rpc = useClient();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(false);
  const version = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const fetchList = useCallback(
    (offset = 0, background = false) => {
      if (background && inFlight.current) return;
      inFlight.current = true;
      const request = ++version.current;
      setPending(true);
      rpc.current
        .call("list", { query: search, offset })
        .then(
          (result) => {
            if (request !== version.current) return;
            setThreads((old) => {
              if (offset)
                return [
                  ...(old ?? []),
                  ...result.threads.filter(
                    (thread) => !old?.some((row) => row.id === thread.id),
                  ),
                ];
              if (background && old && old.length > result.threads.length)
                return [
                  ...result.threads,
                  ...old.filter(
                    (row) =>
                      !result.threads.some((thread) => thread.id === row.id),
                  ),
                ].slice(0, old.length);
              return result.threads;
            });
            setHasMore(result.hasMore);
            setError(null);
          },
          (cause) => {
            if (request === version.current) setError(message(cause));
          },
        )
        .finally(() => {
          if (request === version.current) {
            inFlight.current = false;
            setPending(false);
          }
        });
    },
    [rpc, search],
  );
  useEffect(() => {
    setThreads(null);
    fetchList();
    return () => {
      version.current++;
    };
  }, [fetchList]);
  useRefreshSignals(() => fetchList(0, true), undefined, 3000);
  return (
    <aside
      className={`tr-threads${hidden ? " tr-threads-hidden" : ""}`}
      aria-label="Recent threads"
    >
      <div className="tr-list-heading">
        <span>Recent threads</span>
        <span className="tr-count">{threads?.length ?? ""}</span>
      </div>
      <div className="tr-search">
        <Icon name="Search" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={200}
          placeholder="Search threads…"
          aria-label="Search threads"
        />
      </div>
      {error && <ErrorNotice error={error} retry={() => fetchList()} />}
      <div className="tr-thread-scroll" aria-busy={pending}>
        {threads === null ? (
          <Empty>Loading threads…</Empty>
        ) : threads.length === 0 ? (
          <Empty>
            {search
              ? "No matching threads."
              : "Your recent agent threads will appear here."}
          </Empty>
        ) : (
          threads.map((thread) => (
            <button
              type="button"
              className={`tr-thread${selected === thread.id ? " tr-thread-selected" : ""}`}
              key={thread.id}
              onClick={() => select(thread.id)}
              aria-current={selected === thread.id ? "true" : undefined}
            >
              <span className="tr-thread-title">
                {thread.title || "Untitled thread"}
              </span>
              <span className="tr-thread-meta">
                <span>{thread.provider}</span>
                <time dateTime={new Date(thread.updatedAt).toISOString()}>
                  {timestamp(thread.updatedAt)}
                </time>
              </span>
              {["running", "failed", "active", "error"].includes(
                thread.status,
              ) ? (
                <Status status={thread.status} />
              ) : null}
            </button>
          ))
        )}
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="tr-load-more"
            disabled={pending}
            onClick={() => fetchList(threads?.length ?? 0)}
          >
            Load more threads
          </Button>
        )}
      </div>
    </aside>
  );
}

export interface TreeRow {
  span: TraceSpan;
  depth: number;
  hasChildren: boolean;
}
export function flattenSpans(
  spans: TraceSpan[],
  collapsed: Set<string>,
  query: string,
  failuresOnly: boolean,
): TreeRow[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const children = new Map<string | null, TraceSpan[]>();
  for (const span of spans) {
    const parent =
      span.parentId && byId.has(span.parentId) && span.parentId !== span.id
        ? span.parentId
        : null;
    const group = children.get(parent) ?? [];
    group.push(span);
    children.set(parent, group);
  }
  const filtering = Boolean(query || failuresOnly);
  const allowed = new Set<string>();
  if (filtering) {
    for (const span of spans) {
      if (failuresOnly && span.status !== "failed") continue;
      if (
        query &&
        !`${span.name} ${span.kind} ${span.summary}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        continue;
      let row: TraceSpan | undefined = span;
      const branch = new Set<string>();
      while (row && !branch.has(row.id)) {
        branch.add(row.id);
        allowed.add(row.id);
        row = row.parentId ? byId.get(row.parentId) : undefined;
      }
    }
  }
  const output: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (span: TraceSpan, depth: number) => {
    if (seen.has(span.id)) return;
    seen.add(span.id);
    if (filtering && !allowed.has(span.id)) return;
    const nested = children.get(span.id) ?? [];
    output.push({ span, depth, hasChildren: nested.length > 0 });
    if (filtering || !collapsed.has(span.id))
      for (const child of nested) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  // Malformed cyclic provider ancestry must never crash the explorer.
  if (!collapsed.size)
    for (const span of spans) if (!seen.has(span.id)) visit(span, 0);
  return output;
}

function SpanTree({
  spans,
  selected,
  select,
  collapsed,
  toggle,
  query,
  failuresOnly,
  clock,
}: {
  spans: TraceSpan[];
  selected: string | null;
  select: (id: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  query: string;
  failuresOnly: boolean;
  clock: number;
}) {
  const rows = useMemo(
    () => flattenSpans(spans, collapsed, query.trim(), failuresOnly),
    [spans, collapsed, query, failuresOnly],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ top: 0, height: 540 });
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setWindow((old) => ({ ...old, height: element.clientHeight || 540 })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setWindow((old) => ({ ...old, top: 0 }));
  }, [query, failuresOnly, spans[0]?.turnId]);
  const validStarts = spans.flatMap((span) =>
    span.startedAt === null ? [] : [span.startedAt],
  );
  const start = validStarts.length ? Math.min(...validStarts) : 0;
  const end = Math.max(
    start + 1,
    ...spans.map(
      (span) =>
        span.endedAt ??
        (span.status === "running" ? clock : (span.startedAt ?? start)),
    ),
  );
  const range = end - start;
  const first = Math.min(
    Math.max(0, Math.floor(window.top / ROW_HEIGHT) - 6),
    Math.max(0, rows.length - 1),
  );
  const visible = rows.slice(
    first,
    first + Math.ceil(window.height / ROW_HEIGHT) + 12,
  );
  return (
    <div className="tr-tree">
      <div className="tr-tree-heading">
        <span>
          Span <small>{rows.length}</small>
        </span>
        <div className="tr-axis">
          <span>0</span>
          <span>{validStarts.length ? duration(range / 2) : ""}</span>
          <span>
            {validStarts.length ? duration(range) : "Time unavailable"}
          </span>
        </div>
        <span>Duration</span>
      </div>
      <div
        className="tr-tree-scroll"
        ref={viewport}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setWindow((old) => ({ ...old, top }));
        }}
      >
        {!rows.length ? (
          <Empty>
            {query || failuresOnly
              ? "No spans match these filters."
              : "No spans recorded for this turn yet."}
          </Empty>
        ) : (
          <div
            role="list"
            aria-label="Trace spans"
            style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}
          >
            <div
              style={{
                position: "absolute",
                top: first * ROW_HEIGHT,
                left: 0,
                right: 0,
              }}
            >
              {visible.map(({ span, depth, hasChildren }) => {
                const left =
                  span.startedAt === null
                    ? 0
                    : Math.min(
                        100,
                        Math.max(0, ((span.startedAt - start) / range) * 100),
                      );
                const spanEnd =
                  span.endedAt ??
                  (span.status === "running" ? clock : span.startedAt);
                const width =
                  span.startedAt === null || spanEnd === null
                    ? 0
                    : Math.min(
                        100 - left,
                        Math.max(
                          0.4,
                          ((spanEnd - span.startedAt) / range) * 100,
                        ),
                      );
                const kind = toolKinds.has(span.kind)
                  ? "tool"
                  : span.kind === "reasoning"
                    ? "reasoning"
                    : span.kind === "turn"
                      ? "turn"
                      : "message";
                return (
                  <div
                    className={`tr-span tr-kind-${kind}${selected === span.id ? " tr-span-selected" : ""}`}
                    key={span.id}
                    role="listitem"
                    data-status={span.status}
                  >
                    <div
                      className="tr-span-label"
                      style={{ paddingLeft: 8 + Math.min(depth, 8) * 14 }}
                    >
                      {hasChildren ? (
                        <button
                          type="button"
                          className="tr-collapse"
                          onClick={() => toggle(span.id)}
                          aria-label={`${collapsed.has(span.id) ? "Expand" : "Collapse"} ${span.name}`}
                          aria-expanded={!collapsed.has(span.id)}
                        >
                          <Icon
                            name={
                              collapsed.has(span.id) && !query && !failuresOnly
                                ? "ChevronRight"
                                : "ChevronDown"
                            }
                          />
                        </button>
                      ) : (
                        <span className="tr-collapse-space" />
                      )}
                      <button
                        type="button"
                        className="tr-span-select"
                        onClick={() => select(span.id)}
                        aria-pressed={selected === span.id}
                        title={span.summary || span.name}
                      >
                        <span className="tr-kind-mark" aria-hidden="true" />
                        <span>{span.name}</span>
                        {span.status === "failed" && (
                          <Icon
                            name="AlertCircle"
                            className="tr-failure-icon"
                          />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="tr-waterfall"
                      onClick={() => select(span.id)}
                      aria-label={`Inspect ${span.name} timing`}
                      tabIndex={-1}
                      title={`${span.timing} timing${span.durationMs !== null ? ` · ${duration(span.durationMs)}` : ""}`}
                    >
                      {span.startedAt !== null ? (
                        <span
                          className={`tr-bar${span.status === "running" ? " tr-bar-running" : ""}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        />
                      ) : (
                        <span className="tr-time-unavailable">unavailable</span>
                      )}
                    </button>
                    <span
                      className="tr-span-duration"
                      title={`${span.timing} timing`}
                    >
                      {span.status === "running"
                        ? "running"
                        : duration(span.durationMs)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="tr-tree-footer">
        <span>
          <i className="tr-legend-tool" />
          Tool
        </span>
        <span>
          <i className="tr-legend-message" />
          Agent
        </span>
        <span>
          <i className="tr-legend-reasoning" />
          Reasoning
        </span>
        <span className="tr-footer-note">Observed timing where available</span>
      </div>
    </div>
  );
}

function Inspector({
  threadId,
  span,
  limit,
  close,
}: {
  threadId: string;
  span: TraceSpan;
  limit: number;
  close: () => void;
}) {
  const rpc = useClient();
  const [detail, setDetail] = useState<SpanDetail | null>(null);
  const [tab, setTab] = useState<"input" | "output" | "metadata" | "events">(
    "input",
  );
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    rpc.current.call("detail", { threadId, spanId: span.id, limit }).then(
      (result) => {
        if (current) {
          setDetail(result);
          setError(null);
        }
      },
      (cause) => {
        if (current) setError(message(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, threadId, span.id, span.detailSeq, span.status, limit, attempt]);
  const text = detail
    ? tab === "events"
      ? detail.events
          .map(
            (event) =>
              `#${event.seq}  ${new Date(event.time).toISOString()}  ${event.type}`,
          )
          .join("\n")
      : detail[tab]
    : "";
  return (
    <section className="tr-inspector" aria-label="Span inspector">
      <div className="tr-inspector-heading">
        <div>
          <div className="tr-eyebrow">{span.kind}</div>
          <h3 title={span.name}>{span.name}</h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label="Close inspector"
        >
          <Icon name="X" />
        </Button>
      </div>
      <div className="tr-inspector-meta">
        <Status status={span.status} />
        <span>{duration(span.durationMs)}</span>
        <span>{span.timing} timing</span>
      </div>
      <div className="tr-detail-tabs" role="tablist" aria-label="Span details">
        {(["input", "output", "metadata", "events"] as const).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`tr-detail-${span.id}`}
            onClick={() => {
              setTab(value);
              setCopyState("");
            }}
          >
            {value === "events"
              ? "Source"
              : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorNotice
          error={error}
          retry={() => setAttempt((value) => value + 1)}
        />
      ) : !detail ? (
        <Empty>Loading span…</Empty>
      ) : (
        <>
          <div className="tr-detail-toolbar">
            <span>
              {tab === "events"
                ? `${detail.events.length} source events`
                : `${number.format(text.length)} characters`}
            </span>
            <button
              type="button"
              disabled={!text}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopyState("Copied");
                } catch {
                  setCopyState("Copy unavailable");
                }
              }}
            >
              <Icon name="Copy" />
              {copyState || "Copy"}
            </button>
          </div>
          <div
            className="tr-detail-content"
            id={`tr-detail-${span.id}`}
            role="tabpanel"
            aria-label={tab}
          >
            {text ? <pre>{text}</pre> : <Empty>No {tab} recorded.</Empty>}
          </div>
          {detail.truncated && (
            <div className="tr-detail-footnote">
              Large payload shortened for display.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function UsageList({ label, groups, select }: { label: string; groups: UsageGroup[]; select: (span: TraceSpan) => void }) {
  return <div className="tr-usage-group">
    {groups.some(group => group.badges?.length) && <div className="tr-badge-legend" aria-label="Badge color guide">
      {label === "Skills" && <span><i data-kind="scope" />Scope</span>}
      <span><i data-kind="source" />Source</span>
      <span><i data-kind="owner" />{label === "Skills" ? "Package" : "Server"}</span>
    </div>}
    {!groups.length ? <p>No {label.toLowerCase()} detected in loaded history.</p> : groups.map(group => (
      <details key={group.key}>
        <summary title={group.source}>
          <span className="tr-usage-identity">
            <span className="tr-usage-title">{group.name}</span>
            {group.subtitle && <span className="tr-usage-source" aria-label={group.subtitle}>
              {group.badges?.map(badge => <span className="tr-usage-badge" data-kind={badge.kind} title={`${badge.kind === "scope" ? "Scope" : badge.kind === "source" ? "Source" : label === "Skills" ? "Package" : "Server"}: ${badge.label}`} key={`${badge.kind}-${badge.label}`}>{badge.label}</span>)}
            </span>}
          </span>
          <small>{group.evidence === "read" ? "Read" : group.evidence === "invoked" ? "Invoked" : "Calls"} · {group.spans.length}
            {group.spans.some(span => span.status === "failed") && <span className="tr-usage-failures"> · {group.spans.filter(span => span.status === "failed").length} failed</span>}
          </small>
        </summary>
        <code>{group.source}</code>
        <div className="tr-usage-calls">{group.spans.map(span => <button key={span.id} type="button" onClick={() => select(span)}>
          <span>{span.name}</span><Status status={span.status} />
        </button>)}</div>
      </details>
    ))}
  </div>;
}

function TraceViewer({
  threadId,
  back,
}: {
  threadId: string;
  back?: () => void;
}) {
  const rpc = useClient();
  const navigate = useBbNavigate();
  const [data, setData] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [limit, setLimit] = useState(400);
  const viewId = useId();
  const [view, setView] = useState<"Activity" | "Skills" | "Tools" | "Usage">("Activity");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [spanId, setSpanId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const version = useRef(0);
  const fetchTrace = useCallback(
    (refresh = false) => {
      const request = ++version.current;
      setPending(true);
      rpc.current
        .call("trace", { threadId, limit, refresh })
        .then(
          (result) => {
            if (request === version.current) {
              setData(result);
              setTurnId((old) =>
                result.turns.some((turn) => turn.id === old) ? old : null,
              );
              setError(null);
            }
          },
          (cause) => {
            if (request === version.current) setError(message(cause));
          },
        )
        .finally(() => {
          if (request === version.current) setPending(false);
        });
    },
    [rpc, threadId, limit],
  );
  useEffect(() => {
    fetchTrace();
    return () => {
      version.current++;
    };
  }, [fetchTrace]);
  const connection = useRefreshSignals(() => fetchTrace(true), threadId);
  // With no chosen turn, follow the newest one, except while a span from an older turn is open.
  const shownTurnId =
    turnId ?? data?.spans.find((span) => span.id === spanId)?.turnId;
  const turn =
    data?.turns.find((item) => item.id === shownTurnId) ?? data?.turns.at(-1);
  const chooseTurn = (id: string) => {
    setTurnId(id === data?.turns.at(-1)?.id ? null : id);
    setSpanId(null);
  };
  const spans = useMemo(
    () => data?.spans.filter((span) => span.turnId === turn?.id) ?? [],
    [data, turn?.id],
  );
  const usageGroups = useMemo(() => groupUsage(data?.spans ?? []), [data]);
  const selected = spans.find((span) => span.id === spanId);
  const elapsed =
    turn?.startedAt != null
      ? (turn.endedAt ?? (turn.status === "running" ? data?.fetchedAt : null))
      : null;
  const totalDuration =
    turn?.startedAt != null && elapsed != null
      ? Math.max(0, elapsed - turn.startedAt)
      : null;
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <main className="tr-viewer" aria-busy={pending}>
      <div className="tr-viewer-heading">
        <div className="tr-thread-heading">
          {back && (
            <button
              type="button"
              className="tr-back"
              onClick={back}
              aria-label="Back to threads"
            >
              <Icon name="ChevronLeft" />
            </button>
          )}
          <div>
            <h2>{data?.thread.title || "Thread trace"}</h2>
            <div className="tr-thread-subtitle">
              <span>{data?.thread.provider ?? "Loading"}</span>
              {turn?.model && <span>{turn.model}</span>}
              <span
                className={`tr-connection${connection === "connected" ? " tr-connected" : ""}`}
              >
                <i />
                {connection === "connected" ? "Live" : "Reconnecting"}
              </span>
            </div>
          </div>
        </div>
        <div className="tr-heading-actions">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchTrace(true)}
            disabled={pending}
            aria-label="Refresh trace"
          >
            <Icon name="ArrowReloadHorizontal" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate.toThread(threadId)}
            aria-label="Open thread"
          >
            <Icon name="ArrowUpRight" />
          </Button>
        </div>
      </div>
      {error && <ErrorNotice error={error} retry={() => fetchTrace(true)} />}
      {!data ? (
        !error && <Empty>Loading trace…</Empty>
      ) : (
        <>
          <div className="tr-view-tabs" role="tablist" aria-label="Trace views">
            {(["Activity", "Skills", "Tools", "Usage"] as const).map((name, index, names) => (
              <button key={name} type="button" role="tab" id={`${viewId}-${name}`} aria-controls={`${viewId}-content`}
                aria-selected={view === name} tabIndex={view === name ? 0 : -1}
                onClick={() => { setView(name); setSpanId(null); }}
                onKeyDown={event => {
                  const next = event.key === "ArrowRight" ? (index + 1) % names.length : event.key === "ArrowLeft" ? (index + names.length - 1) % names.length : event.key === "Home" ? 0 : event.key === "End" ? names.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault(); setView(names[next]); setSpanId(null);
                  document.getElementById(`${viewId}-${names[next]}`)?.focus();
                }}>
                {name}{name === "Skills" && <span>{usageGroups.skills.length}</span>}{name === "Tools" && <span>{usageGroups.tools.length}</span>}
              </button>
            ))}
          </div>
          <div className="tr-view-content" id={`${viewId}-content`} role="tabpanel" aria-labelledby={`${viewId}-${view}`}>
          {view === "Usage" ? <section className="tr-usage-page">
            <h3>Usage</h3><p>Provider-reported tokens for this thread. Timing and call counts are for the selected turn.</p>
          <div className="tr-controls">
            <label className="tr-turn-label">
              <span>Turn</span>
              <select
                aria-label="Select turn"
                value={turn?.id ?? ""}
                onChange={(event) => chooseTurn(event.target.value)}
                disabled={!data.turns.length}
              >
                {!data.turns.length && <option value="">No turns yet</option>}
                {data.turns.map((item, index) => (
                  <option value={item.id} key={item.id}>
                    {index + 1} · {item.label.slice(0, 100)}
                  </option>
                ))}
              </select>
            </label>
            {turn && <Status status={turn.status} />}
          </div>
          <div className="tr-summary">
            <div>
              <span>Duration</span>
              <strong>{duration(totalDuration)}</strong>
            </div>
            <div>
              <span>Tool calls</span>
              <strong>{turn?.toolCount ?? 0}</strong>
            </div>
            <div className={turn?.errorCount ? "tr-metric-error" : ""}>
              <span>Errors</span>
              <strong>{turn?.errorCount ?? 0}</strong>
            </div>
            <div title="Latest provider-reported usage for the whole thread, not the selected turn">
              <span>Thread tokens</span>
              <strong>
                {data.usage ? number.format(data.usage.total) : "—"}
              </strong>
              <small>reported</small>
            </div>
          </div>
          {data.usage && (
            <dl
              className="tr-token-breakdown"
              aria-label="Provider-reported thread token breakdown"
            >
              <div title={`${exactNumber.format(data.usage.input)} input tokens reported for the whole thread`}>
                <dt>Input</dt>
                <dd>{number.format(data.usage.input)}</dd>
              </div>
              <div title={`${exactNumber.format(data.usage.output)} output tokens reported for the whole thread`}>
                <dt>Output</dt>
                <dd>{number.format(data.usage.output)}</dd>
              </div>
              <div title={`${exactNumber.format(data.usage.cached)} cache tokens reported by the provider. Cache accounting varies by provider; this is not an additional amount to add to the total.`}>
                <dt>Cached</dt>
                <dd>{number.format(data.usage.cached)}</dd>
              </div>
            </dl>
          )}
          </section> : view === "Skills" || view === "Tools" ? <section className="tr-usage-page">
            <p>{view === "Skills" ? "Detected in loaded history. Read means the file was requested; Invoked means an explicit skill call." : "Recorded calls in loaded history. Expand a tool to inspect its calls."}</p>
            <UsageList label={view} groups={view === "Skills" ? usageGroups.skills : usageGroups.tools} select={span => { setTurnId(span.turnId); setSpanId(span.id); setQuery(""); setFailuresOnly(false); setCollapsed(new Set()); setView("Activity"); }} />
          </section> : <>
          <div className="tr-workspace">
            <section className="tr-timeline" aria-label="Trace timeline">
              <div className="tr-filterbar">
            <label className="tr-turn-label">
              <span>Turn</span>
              <select
                aria-label="Select turn"
                value={turn?.id ?? ""}
                onChange={(event) => chooseTurn(event.target.value)}
                disabled={!data.turns.length}
              >
                {!data.turns.length && <option value="">No turns yet</option>}
                {data.turns.map((item, index) => (
                  <option value={item.id} key={item.id}>
                    {index + 1} · {item.label.slice(0, 100)}
                  </option>
                ))}
              </select>
            </label>
                <div className="tr-search">
                  <Icon name="Search" />
                  <Input
                    placeholder="Find a span…"
                    aria-label="Find a span"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <button
                  className={`tr-filter${failuresOnly ? " tr-filter-active" : ""}`}
                  type="button"
                  aria-pressed={failuresOnly}
                  onClick={() => setFailuresOnly((value) => !value)}
                >
                  <Icon name="AlertCircle" />
                  Errors
                </button>
              </div>
              <SpanTree
                spans={spans}
                selected={selected?.id ?? null}
                select={setSpanId}
                collapsed={collapsed}
                toggle={toggle}
                query={query}
                failuresOnly={failuresOnly}
                clock={data.fetchedAt}
              />
            </section>
            {selected ? (
              <Inspector
                key={selected.id}
                threadId={threadId}
                span={selected}
                limit={limit}
                close={() => setSpanId(null)}
              />
            ) : null}
          </div>
          </>}
          </div>
          <footer className="tr-coverage">
            <span>
              {data.hasOlder ? "Latest " : ""}
              {number.format(data.eventCount)} events · {data.turns.length}{" "}
              turns{data.hasOlder && " · earlier history available"}
            </span>
            {data.hasOlder && limit < 2000 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setLimit((value) => Math.min(2000, value + 400))}
              >
                Load older
              </Button>
            )}
            {data.hasOlder && limit >= 2000 && (
              <span>Showing the latest 2,000 events</span>
            )}
            {data.warnings.length > 0 && (
              <details>
                <summary>Coverage notes ({data.warnings.length})</summary>
                <ul>
                  {data.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </footer>
        </>
      )}
    </main>
  );
}

function TracesPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const threadId = subPath.split("/")[0] || "";
  return (
    <div className={`bb-traces${threadId ? " tr-has-selection" : ""}`}>
      <ThreadList
        selected={threadId}
        select={(id) => navigate.toPluginPanel("traces", { subPath: id })}
        hidden={Boolean(threadId)}
      />
      {threadId ? (
        <TraceViewer
          key={threadId}
          threadId={threadId}
          back={() => navigate.toPluginPanel("traces")}
        />
      ) : (
        <main className="tr-welcome">
          <div className="tr-welcome-art" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <h2>Follow the work.</h2>
          <p>
            Open a thread to see its turns, tool calls,
            <br />
            and timing in one clear view.
          </p>
          <span>Choose a recent thread to begin</span>
        </main>
      )}
    </div>
  );
}
function ThreadTracePanel({ threadId }: { threadId: string }) {
  return (
    <div className="bb-traces tr-panel">
      <TraceViewer key={threadId} threadId={threadId} />
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "traces",
    title: "Traces",
    icon: "Activity",
    path: "traces",
    component: TracesPage,
  });
  app.slots.threadPanelAction({
    id: "trace",
    title: "Traces",
    icon: "Activity",
    layout: "flush",
    component: ThreadTracePanel,
  });
});

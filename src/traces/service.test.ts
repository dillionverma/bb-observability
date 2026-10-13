import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "./model";
import { compact, formatPayload, TraceService } from "./service";

type Threads = BbPluginApi["sdk"]["threads"];
type EventInput = Parameters<Threads["events"]["list"]>[0];

function event(seq: number, item: Record<string, unknown> = {}): EventRow {
  return { id: `event-${seq}`, seq, createdAt: 1000 + seq, type: "item/completed",
    scope: { kind: "turn", turnId: "turn-1" },
    data: { item: { type: "commandExecution", id: `command-${seq}`, command: `echo ${seq}`,
      status: "completed", aggregatedOutput: `output ${seq}`, ...item } } };
}

const services: TraceService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

function fixture(initial: EventRow[] = []) {
  let rows = initial;
  let now = 1000;
  const thread = { id: "thread-1", title: "Trace fixture", providerId: "codex", status: "idle",
    updatedAt: 1000, projectId: "project-1", deletedAt: null as number | null };
  const select = (input: EventInput) => rows.filter(row =>
    (!input.types || input.types.includes(row.type as never)) &&
    (input.afterSeq === undefined || row.seq > Number(input.afterSeq)) &&
    (input.beforeSeq === undefined || row.seq < Number(input.beforeSeq)))
    .sort((a, b) => input.order === "desc" ? b.seq - a.seq : a.seq - b.seq)
    .slice(0, Number(input.limit ?? 100));
  const list = vi.fn(async (input: EventInput) => select(input));
  const get = vi.fn(async () => thread);
  const service = new TraceService({ get, events: { list } } as unknown as Threads, () => now);
  services.push(service);
  return { service, list, get, thread, select,
    replace: (next: EventRow[]) => { rows = next; }, advance: (ms: number) => { now += ms; } };
}

describe("TraceService history loading", () => {
  it("extracts skill paths beyond the compact command limit without retaining outputs", async () => {
    const command = `echo ${"x".repeat(600)}; cat /skills/shadcn/SKILL.md`;
    const f = fixture([event(1, { command, aggregatedOutput: "private skill contents" })]);
    const result = await f.service.trace("thread-1", 100);
    expect(result.spans[0].operationUsage?.skills).toEqual([{ name: "shadcn", source: "/skills/shadcn/SKILL.md", evidence: "read" }]);
    expect(JSON.stringify(result)).not.toContain("private skill contents");
  });

  it("paginates beyond the SDK's 100 event page and keeps only the latest requested window", async () => {
    const f = fixture(Array.from({ length: 251 }, (_, i) => event(i + 1)));
    const trace = await f.service.trace("thread-1", 200);
    expect(trace.eventCount).toBe(200);
    expect(trace.spans.map(span => span.detailSeq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 52));
    expect(trace.lastSeq).toBe(251);
    expect(trace.hasOlder).toBe(true);
    expect(trace.warnings.join(" ")).toContain("latest 200");
    const pages = f.list.mock.calls.map(([input]) => input).filter(input => input.order === "desc");
    expect(pages.map(input => [input.beforeSeq, input.limit])).toEqual([[undefined, "100"], ["152", "100"], ["52", "1"]]);
    expect(pages.every(input => input.types?.includes("item/completed"))).toBe(true);
    expect(pages.every(input => !input.types?.includes("item/agentMessage/delta"))).toBe(true);
  });

  it("reports complete coverage when the history ends exactly at the requested limit", async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => event(i + 1)));
    expect(await f.service.trace("thread-1", 100)).toMatchObject({ eventCount: 100, hasOlder: false, warnings: [] });
  });

  it("shrinks oversized pages and still reads every available event", async () => {
    const f = fixture(Array.from({ length: 120 }, (_, i) => event(i + 1)));
    f.list.mockImplementation(async input => {
      if (input.order === "desc" && Number(input.limit) > 25) throw new Error("event_data_too_large: 8 MiB");
      return f.select(input);
    });
    const trace = await f.service.trace("thread-1", 200);
    expect(trace).toMatchObject({ eventCount: 120, hasOlder: false, warnings: [] });
    expect(new Set(trace.spans.map(span => span.detailSeq)).size).toBe(120);
    expect(f.list.mock.calls.slice(0, 3).map(([input]) => input.limit)).toEqual(["100", "50", "25"]);
  });

  it("stops with an explicit partial-history warning when even one event is too large", async () => {
    const f = fixture([event(1), event(2), event(3)]);
    f.list.mockImplementation(async input => {
      const rows = f.select(input);
      if (input.order === "desc" && rows.some(row => row.seq === 2)) throw new Error("event_data_too_large");
      return rows;
    });
    const trace = await f.service.trace("thread-1", 100);
    expect(trace.spans.map(span => span.detailSeq)).toEqual([3]);
    expect(trace.hasOlder).toBe(true);
    expect(trace.warnings.join(" ")).toContain("event is too large");
    expect(f.list.mock.calls.length).toBeLessThan(12);
  });

  it("reuses short-lived cache entries and rereads edited history after invalidation", async () => {
    const f = fixture([event(1), event(2)]);
    const first = await f.service.trace("thread-1", 100);
    expect(await f.service.trace("thread-1", 100)).toBe(first);
    expect(f.get).toHaveBeenCalledTimes(1);
    f.replace([event(3, { command: "edited command" })]);
    f.service.invalidate("thread-1");
    const edited = await f.service.trace("thread-1", 100);
    expect(edited.spans.map(span => span.name)).toEqual(["edited command"]);
    expect(f.get).toHaveBeenCalledTimes(2);
    f.advance(4001);
    await f.service.trace("thread-1", 100);
    expect(f.get).toHaveBeenCalledTimes(3);
  });

  it("shares an in-flight read across concurrent viewers", async () => {
    const f = fixture([event(1)]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.get.mockImplementation(async () => { await gate; return f.thread; });
    const a = f.service.trace("thread-1", 100);
    const b = f.service.trace("thread-1", 100);
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("does not cache a read that was invalidated while it was in flight", async () => {
    const f = fixture([event(1)]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.get.mockImplementationOnce(async () => { await gate; return f.thread; });
    const pending = f.service.trace("thread-1", 100);
    f.service.invalidate("thread-1");
    release();
    await pending;
    f.replace([event(2)]);
    const next = await f.service.trace("thread-1", 100);
    expect(next.spans.map(span => span.detailSeq)).toEqual([2]);
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("rereads the snapshot when a completed history edit arrives during pagination", async () => {
    const f = fixture(Array.from({ length: 120 }, (_, i) => event(i + 1)));
    let replaced = false;
    f.list.mockImplementation(async input => {
      const rows = f.select(input);
      if (input.order === "desc" && !replaced) {
        replaced = true;
        f.replace([{ ...event(121), type: "system/operation", data: {
          operation: "edit_message", status: "completed", metadata: { cutoffSequence: 0, oldMaxSequence: 120 },
        } }, event(122, { command: "replacement" })]);
      }
      return rows;
    });
    const trace = await f.service.trace("thread-1", 200);
    expect(trace.spans.map(span => span.name)).toEqual(["replacement"]);
    expect(trace.lastSeq).toBe(122);
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("rejects deleted threads before fetching history", async () => {
    const f = fixture([event(1)]);
    f.thread.deletedAt = 1001;
    await expect(f.service.trace("thread-1", 100)).rejects.toThrow("deleted");
    expect(f.list).not.toHaveBeenCalled();
  });
});

describe("TraceService thread list", () => {
  it("pages threads by most recent update across projects, not bb's project order", async () => {
    const row = (id: string, projectId: string, updatedAt: number) => ({ id, title: id, providerId: "codex", status: "idle", updatedAt, projectId });
    const rows = [...Array.from({ length: 50 }, (_, i) => row(`a-${i}`, "proj_a", 1000 + i)), row("b-newest", "proj_b", 9000), row("c-newer", "proj_c", 5000)];
    const list = vi.fn(async (input: { offset?: number; limit?: number }) => rows.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? rows.length)));
    const service = new TraceService({ list } as unknown as Threads);
    services.push(service);
    const first = await service.list({ offset: 0 });
    expect(first.threads.slice(0, 3).map(thread => thread.id)).toEqual(["b-newest", "c-newer", "a-49"]);
    expect(first).toMatchObject({ hasMore: true, threads: { length: 50 } });
    const second = await service.list({ offset: 50 });
    expect(second).toMatchObject({ hasMore: false, threads: [{ id: "a-1" }, { id: "a-0" }] });
  });
});

describe("TraceService operation details", () => {
  it("lazily fetches the completion payload instead of the compact cached preview", async () => {
    const output = "full output ".repeat(100);
    const f = fixture([
      { ...event(1, { id: "command", status: "pending", aggregatedOutput: undefined }), type: "item/started" },
      event(2, { id: "command", aggregatedOutput: output }),
    ]);
    const trace = await f.service.trace("thread-1", 100);
    expect(f.list.mock.calls.every(([input]) => input.types !== undefined)).toBe(true);
    const detail = await f.service.detail("thread-1", trace.spans[0].id, 100);
    expect(detail.output).toBe(output);
    expect(detail.input).toContain("echo 2");
    expect(detail.events.map(row => row.seq)).toEqual([1, 2]);
    expect(f.list.mock.lastCall?.[0]).toMatchObject({ afterSeq: "1", beforeSeq: "3", limit: "1" });
    expect(detail.truncated).toBe(false);
  });

  it.each([
    [{ type: "webSearch", queries: ["SDK event schema"], resultText: "search results" }, "SDK event schema", "search results"],
    [{ type: "webFetch", url: "https://example.com", resultText: "page contents" }, "https://example.com", "page contents"],
    [{ type: "reasoning", content: [], summary: ["Recorded reasoning summary"] }, "Not recorded", "Recorded reasoning summary"],
  ])("extracts recorded SDK payload fields for $0.type", async (item, input, output) => {
    const f = fixture([event(1, { aggregatedOutput: undefined, ...item })]);
    const trace = await f.service.trace("thread-1", 100);
    const detail = await f.service.detail("thread-1", trace.spans[0].id, 100);
    expect(detail.input).toContain(input);
    expect(detail.output).toContain(output);
  });

  it("reports provider-side truncation even when the retained payload is short", async () => {
    const f = fixture([event(1, { aggregatedOutput: "retained output", truncation: {
      aggregatedOutput: { originalLength: 50000, retainedHeadLength: 10, retainedTailLength: 5, truncatedAt: 1000 },
    } })]);
    const trace = await f.service.trace("thread-1", 100);
    expect((await f.service.detail("thread-1", trace.spans[0].id, 100)).truncated).toBe(true);
  });

  it("reports local preview truncation and masks structured secret fields", async () => {
    const f = fixture([event(1, { type: "toolCall", tool: "fixture", arguments: { api_key: "test-secret", query: "public" }, result: "x".repeat(40000) })]);
    const trace = await f.service.trace("thread-1", 100);
    const detail = await f.service.detail("thread-1", trace.spans[0].id, 100);
    expect(detail.truncated).toBe(true);
    expect(detail.output.length).toBeLessThan(32100);
    expect(detail.output).toContain("preview truncated");
    expect(detail.input).toContain("[masked]");
    expect(JSON.stringify(detail)).not.toContain("test-secret");
  });

  it("rejects a selected operation whose source row was removed by a history edit", async () => {
    const f = fixture([event(1)]);
    const trace = await f.service.trace("thread-1", 100);
    f.replace([]);
    await expect(f.service.detail("thread-1", trace.spans[0].id, 100)).rejects.toThrow("removed or replaced");
    await expect(f.service.detail("thread-1", "missing-span", 100)).rejects.toThrow("outside the loaded history");
  });
});

describe("bounded previews", () => {
  it("bounds cached payload text and arrays without retaining structured credentials", () => {
    expect(compact({ password: "test-secret", text: "x".repeat(1000), rows: Array.from({ length: 100 }, (_, i) => i) }))
      .toEqual({ password: "[masked]", text: "x".repeat(400), rows: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(formatPayload(null)).toEqual({ text: "Not recorded", truncated: false });
  });
});

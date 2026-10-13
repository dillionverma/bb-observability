import { describe, expect, it } from "vitest";
import { buildTrace } from "./trace";
import type { EventRow } from "./model";

function event(seq: number, type: string, data: Record<string, unknown> = {}, turnId?: string): EventRow {
  return { id: `event-${seq}`, seq, type, data, createdAt: seq * 100,
    scope: turnId ? { kind: "turn", turnId } : { kind: "thread" } };
}
const start = (seq: number, id = "t1") => event(seq, "turn/started", {}, id);
const finish = (seq: number, id = "t1", status = "completed") => event(seq, "turn/completed", { status }, id);
const request = (seq: number, id: string, label: string) => event(seq, "client/turn/requested", {
  requestId: id, input: [{ type: "text", text: label }], execution: { model: "test-model" }, target: { kind: "new-turn" },
});
const accepted = (seq: number, requestId: string, turnId = "t1") => event(seq, "turn/input/accepted", { clientRequestId: requestId }, turnId);
const item = (seq: number, type: string, data: Record<string, unknown>, turnId = "t1") => event(seq, type, { item: data }, turnId);

describe("buildTrace", () => {
  it("reconstructs a labeled turn and tool using its reported duration without retaining payloads", () => {
    const result = buildTrace([
      request(1, "r1", "Fix the search view"), start(2), accepted(3, "r1"),
      item(4, "item/started", { type: "toolCall", id: "c1", tool: "read", status: "pending", arguments: { secret: "not-list-data" } }),
      item(8, "item/completed", { type: "toolCall", id: "c1", tool: "read", status: "completed", result: "full-output", durationMs: 321 }),
      finish(9),
    ], "idle");
    expect(result.turns).toEqual([{
      id: "t1", label: "Fix the search view", model: "test-model", status: "completed", startedAt: 200, endedAt: 900,
      spanCount: 1, toolCount: 1, errorCount: 0,
    }]);
    expect(result.spans[0]).toMatchObject({ sourceSeq: 4, detailSeq: 8, startedAt: 400, endedAt: 800, durationMs: 321, timing: "reported" });
    expect(JSON.stringify(result)).not.toContain("not-list-data");
    expect(JSON.stringify(result)).not.toContain("full-output");
  });

  it("uses observed lifecycle duration and recognizes failed commands", () => {
    const result = buildTrace([
      start(1), item(2, "item/started", { id: "cmd", type: "commandExecution", command: "npm test", status: "pending" }),
      item(5, "item/completed", { id: "cmd", type: "commandExecution", command: "npm test", status: "completed", exitCode: -1 }), finish(6),
    ], "idle");
    expect(result.spans[0]).toMatchObject({ name: "npm test", status: "failed", durationMs: 300, timing: "observed" });
    expect(result.turns[0]).toMatchObject({ status: "completed", errorCount: 1 });
  });

  it("deduplicates repeated rows and snapshots without reopening a completed tool or moving its end", () => {
    const completed = item(5, "item/completed", { id: "read", type: "fileRead", path: "app.ts", status: "completed" });
    const result = buildTrace([
      start(1), item(2, "item/started", { id: "read", type: "fileRead", path: "app.ts", status: "pending" }),
      completed, completed,
      item(6, "item/started", { id: "read", type: "fileRead", path: "app.ts", status: "pending" }),
      item(7, "item/completed", { id: "read", type: "fileRead", path: "app.ts", status: "completed" }), finish(8),
    ], "idle");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ sourceSeq: 2, detailSeq: 7, status: "completed", endedAt: 500, durationMs: 300 });
  });

  it("keeps tool IDs independent across retry turns and provider errors visible", () => {
    const result = buildTrace([
      request(1, "r1", "Try task"), start(2, "a"), accepted(3, "r1", "a"),
      item(4, "item/completed", { id: "same", type: "toolCall", tool: "call", status: "failed", error: "Timed out" }, "a"),
      event(5, "provider/error", { message: "Connection lost", willRetry: true }, "a"), finish(6, "a", "failed"),
      request(7, "r2", "Try task again"), start(8, "b"), accepted(9, "r2", "b"),
      item(10, "item/completed", { id: "same", type: "toolCall", tool: "call", status: "completed" }, "b"), finish(11, "b"),
    ], "idle");
    expect(result.turns.map((turn) => turn.status)).toEqual(["failed", "completed"]);
    expect(result.spans).toHaveLength(3);
    expect(new Set(result.spans.map((span) => span.id)).size).toBe(3);
    expect(result.turns.map((turn) => turn.errorCount)).toEqual([2, 0]);
  });

  it("keeps missing start times unknown even when a completion reports duration", () => {
    const result = buildTrace([
      item(9, "item/completed", { id: "late", type: "toolCall", tool: "fetch", status: "completed", durationMs: 250 }),
      item(10, "item/completed", { id: "message", type: "agentMessage", text: "Done" }), finish(11),
    ], "idle");
    expect(result.turns[0]?.startedAt).toBeNull();
    expect(result.spans[0]).toMatchObject({ startedAt: null, endedAt: 900, durationMs: 250, timing: "reported" });
    expect(result.spans[1]).toMatchObject({ startedAt: null, durationMs: null, timing: "unknown" });
  });

  it("does not leave unfinished historical spans running or invent their end time", () => {
    for (const terminal of ["completed", "failed", "interrupted"]) {
      const result = buildTrace([start(1), item(2, "item/started", { id: "open", type: "webFetch", url: "https://example.com" }), finish(3, "t1", terminal)], "idle");
      expect(result.spans[0]).toMatchObject({ status: terminal === "interrupted" ? "interrupted" : "unknown", endedAt: null, durationMs: null });
    }
    const truncated = buildTrace([start(1), item(2, "item/started", { id: "open", type: "toolCall", tool: "read" })], "idle");
    expect(truncated.turns[0]?.status).toBe("unknown");
    expect(truncated.spans[0]?.status).toBe("unknown");
    expect(buildTrace([start(1), item(2, "item/started", { id: "open", type: "toolCall", tool: "read" })], "active").spans[0]?.status).toBe("running");
  });

  it("resolves later parents within the turn, leaving missing, cross-turn, and cyclic parents as roots", () => {
    const result = buildTrace([
      start(1),
      item(2, "item/completed", { id: "child", type: "fileRead", parentToolCallId: "parent" }),
      item(3, "item/completed", { id: "parent", type: "toolCall", tool: "batch" }),
      item(4, "item/completed", { id: "missing", type: "fileRead", parentToolCallId: "other" }),
      item(5, "item/completed", { id: "cycle-a", type: "toolCall", parentToolCallId: "cycle-b" }),
      item(6, "item/completed", { id: "cycle-b", type: "toolCall", parentToolCallId: "cycle-a" }), finish(7),
      start(8, "t2"), item(9, "item/completed", { id: "cross", type: "fileRead", parentToolCallId: "parent" }, "t2"), finish(10, "t2"),
    ], "idle");
    expect(result.spans[0]?.parentId).toBe(result.spans[1]?.id);
    expect(result.spans.slice(2).every((span) => span.parentId === null)).toBe(true);
  });

  it("uses the latest cumulative usage report, not their sum or last-turn usage", () => {
    const total = (tokens: number) => ({ inputTokens: tokens - 20, outputTokens: 20, cachedInputTokens: 10, totalTokens: tokens });
    const result = buildTrace([
      event(1, "thread/tokenUsage/updated", { tokenUsage: { total: total(100), last: total(90) } }),
      event(2, "thread/tokenUsage/updated", { tokenUsage: { total: total(200), last: total(100) } }),
    ], "idle");
    expect(result.usage).toEqual({ input: 180, output: 20, cached: 10, total: 200 });
    expect(result.turns).toEqual([]);
  });

  it("shows rejected and pre-start failed requests without fabricating provider turns", () => {
    const result = buildTrace([
      request(1, "r1", "First attempt"), event(2, "client/turn/rejected", { requestId: "r1", message: "No quota" }),
      request(3, "r2", "Second attempt"), event(4, "system/error", { message: "Could not authenticate" }),
      event(5, "system/error", { message: "Retry failed" }),
    ], "failed");
    expect(result.turns.map((turn) => [turn.label, turn.status, turn.startedAt, turn.errorCount])).toEqual([
      ["First attempt", "failed", null, 1], ["Second attempt", "failed", null, 2],
    ]);
    expect(result.spans).toHaveLength(3);
  });

  it("attaches joined requests to an existing turn without creating additional runs", () => {
    const result = buildTrace([
      request(1, "r1", "Original task"), start(2), accepted(3, "r1"), request(4, "r2", "Also do this"), accepted(5, "r2"), finish(6),
    ], "idle");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.label).toBe("Original task");
  });

  it("keeps the active provider turn running when a later steering request is rejected", () => {
    const result = buildTrace([
      request(1, "r1", "Original task"), start(2), accepted(3, "r1"),
      item(4, "item/started", { id: "open", type: "toolCall", tool: "read" }),
      request(5, "r2", "Also do this"), event(6, "client/turn/rejected", { requestId: "r2", message: "Turn cannot be steered" }),
    ], "active");
    expect(result.turns.map((turn) => turn.status)).toEqual(["running", "failed"]);
    expect(result.spans[0]?.status).toBe("running");
  });

  it("supports legacy outbound requests without double-counting modern outbound events", () => {
    const legacy = event(2, "client/turn/start", { request: { params: { input: [{ type: "text", text: "Legacy task" }], model: "legacy" } } });
    expect(buildTrace([legacy, start(3), finish(4)], "idle").turns[0]).toMatchObject({ id: "t1", label: "Legacy task", model: "legacy" });
    expect(buildTrace([request(1, "r1", "Modern task"), legacy, start(3), accepted(4, "r1"), finish(5)], "idle").turns).toHaveLength(1);
  });

  it("handles delegation progress snapshots and short plain-text summaries", () => {
    const result = buildTrace([
      start(1), item(2, "item/started", { id: "child", type: "delegation", label: "Agent\n" + "x".repeat(200), status: "pending", childRef: "another-thread" }),
      item(3, "item/delegation/progress", { id: "child", type: "delegation", label: "Agent", status: "pending", summary: "\u001b[31mWorking\u001b[0m\n" + "y".repeat(500) }),
      item(4, "item/delegation/completed", { id: "child", type: "delegation", label: "Agent", status: "completed", summary: "z".repeat(500) }), finish(5),
    ], "idle");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ name: "Agent", detailSeq: 4, parentId: null, durationMs: 200 });
    expect(result.spans[0]?.summary.length).toBe(180);
    expect(result.turns[0]?.toolCount).toBe(1);
  });

  it("excludes a verified edited suffix while retaining the replacement history", () => {
    const result = buildTrace([
      start(1), item(2, "item/completed", { id: "keep", type: "agentMessage", text: "Kept" }),
      item(3, "item/completed", { id: "removed", type: "agentMessage", text: "Removed" }), finish(4),
      event(5, "system/operation", { operation: "edit_message", status: "completed", metadata: { cutoffSequence: 3, oldMaxSequence: 4 } }),
      item(6, "item/completed", { id: "replacement", type: "agentMessage", text: "Replacement" }), finish(7),
    ], "idle");
    expect(result.spans.map((span) => span.summary)).toEqual(["Kept", "Replacement"]);
    expect(result.turns[0]?.endedAt).toBe(700);
  });
});

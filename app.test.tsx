// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { SpanDetail, TraceResult, TraceSpan } from "./model";

let app: CapturedPluginApp;
beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const startedAt = 1_700_000_000_000;
function span(id: string, overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id,
    parentId: "turn-1",
    turnId: "turn-1",
    name: id,
    kind: "commandExecution",
    status: "completed",
    startedAt: startedAt + 100,
    endedAt: startedAt + 500,
    durationMs: 400,
    timing: "observed",
    sourceSeq: 2,
    detailSeq: 4,
    summary: "",
    ...overrides,
  };
}
function trace(overrides: Partial<TraceResult> = {}): TraceResult {
  return {
    thread: {
      id: "thr_test",
      title: "Build the trace explorer",
      provider: "codex",
      status: "idle",
      updatedAt: startedAt,
      projectId: null,
    },
    turns: [
      {
        id: "turn-1",
        label: "Build the explorer",
        model: "gpt-test",
        status: "completed",
        startedAt,
        endedAt: startedAt + 1000,
        spanCount: 3,
        toolCount: 2,
        errorCount: 1,
      },
    ],
    spans: [
      span("turn-1", {
        name: "Agent turn",
        kind: "turn",
        parentId: null,
        startedAt,
        endedAt: startedAt + 1000,
        durationMs: 1000,
      }),
      span("shell", { name: "npm test" }),
      span("failure", { name: "npm build", status: "failed" }),
    ],
    usage: { input: 1000, output: 400, cached: 100, total: 1400 },
    hasOlder: false,
    limit: 400,
    eventCount: 10,
    lastSeq: 10,
    warnings: [],
    fetchedAt: startedAt + 1000,
    ...overrides,
  };
}
const detail = (
  input = "npm test",
  output = "All checks passed",
): SpanDetail => ({
  input,
  output,
  metadata: '{"provider":"codex"}',
  events: [{ seq: 2, type: "item.updated", time: startedAt }],
  truncated: false,
});
const panel = (
  handlers: {
    trace?: (...args: any[]) => any;
    detail?: (...args: any[]) => any;
  } = {},
) =>
  renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_test", params: null },
    { rpc: { trace: () => trace(), detail: () => detail(), ...handlers } },
  );

describe("native trace explorer", () => {
  it("shows skill evidence and tool counts across turns and opens a source call", async () => {
    const skillSpan = span("skill-read", { name: "Read skill", operationUsage: { tool: "Shell", skills: [{ name: "shadcn", source: "/global/shadcn/SKILL.md", evidence: "read", scope: "Global", origin: "Shared agents" }] } });
    const view = panel({ trace: () => trace({ spans: [skillSpan] }) });
    fireEvent.click(await view.findByRole("tab", { name: /Skills/ }));
    await view.findByText("shadcn");
    expect(view.getByText("Read · 1")).toBeTruthy();
    expect(view.getByText("Global")).toBeTruthy();
    expect(view.getByText("Shared agents")).toBeTruthy();
    expect(view.queryByRole("heading", { name: /Skills/ })).toBeNull();
    expect(view.queryByText("Calls · 1")).toBeNull();
    fireEvent.click(view.getByText("shadcn"));
    expect(view.getByText("/global/shadcn/SKILL.md")).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: /Read skill/ })[0]);
    await waitFor(() => expect(view.inspection.rpcCalls.some(call => call.method === "detail")).toBe(true));
    view.unmount();
  });

  it("supports keyboard view navigation and hides the inspector until a call is selected", async () => {
    const view = panel();
    const activity = await view.findByRole("tab", { name: "Activity" });
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(view.queryByRole("region", { name: "Span inspector" })).toBeNull();
    fireEvent.keyDown(activity, { key: "ArrowRight" });
    expect(view.getByRole("tab", { name: /Skills/ }).getAttribute("aria-selected")).toBe("true");
    expect(view.queryByRole("region", { name: "Trace timeline" })).toBeNull();
    fireEvent.keyDown(view.getByRole("tab", { name: /Skills/ }), { key: "End" });
    expect(view.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(view.getByRole("tab", { name: "Usage" }), { key: "Home" });
    fireEvent.click(view.getByRole("button", { name: "npm test" }));
    await view.findByRole("region", { name: "Span inspector" });
    fireEvent.click(view.getByRole("button", { name: "Close inspector" }));
    expect(view.queryByRole("region", { name: "Span inspector" })).toBeNull();
  });

  it("registers native pages and opens a thread via host navigation", async () => {
    expect(app.navPanels[0]?.path).toBe("traces");
    expect(app.threadPanelActions[0]?.layout).toBe("flush");
    const view = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { list: () => ({ threads: [trace().thread], hasMore: false }) } },
    );
    fireEvent.click(
      await view.findByRole("button", { name: /Build the trace explorer/ }),
    );
    expect(view.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "traces",
      options: { subPath: "thr_test" },
    });
  });

  it("shows core metrics first and fetches input/output only when a span is selected", async () => {
    const view = panel();
    await view.findByText("Build the trace explorer");
    expect(view.queryByRole("region", { name: "Span inspector" })).toBeNull();
    expect(view.queryByText("Thread tokens")).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "Usage" }));
    expect(view.getByText("Thread tokens")).toBeTruthy();
    const usage = within(view.getByLabelText("Provider-reported thread token breakdown"));
    expect(usage.getByText("Input").nextElementSibling?.textContent).toBe("1K");
    expect(usage.getByText("Output").nextElementSibling?.textContent).toBe("400");
    expect(usage.getByText("Cached").nextElementSibling?.textContent).toBe("100");
    expect(
      view.inspection.rpcCalls.filter((call) => call.method === "detail"),
    ).toHaveLength(0);
    fireEvent.click(view.getByRole("tab", { name: "Activity" }));
    fireEvent.click(view.getByRole("button", { name: "npm test" }));
    const inspector = await view.findByRole("region", {
      name: "Span inspector",
    });
    await waitFor(() =>
      expect(within(inspector).getByRole("tabpanel").textContent).toBe(
        "npm test",
      ),
    );
    fireEvent.click(within(inspector).getByRole("tab", { name: "Output" }));
    expect(within(inspector).getByRole("tabpanel").textContent).toBe(
      "All checks passed",
    );
    fireEvent.click(view.getByRole("button", { name: "Open thread" }));
    expect(view.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_test",
    });
  });

  it("keeps ancestor context while filtering failures, and collapses descendants", async () => {
    const view = panel();
    await view.findByRole("button", { name: "npm test" });
    fireEvent.click(view.getByRole("button", { name: "Collapse Agent turn" }));
    expect(view.queryByRole("button", { name: "npm test" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Errors" }));
    expect(view.getByRole("button", { name: "npm build" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Agent turn" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "npm test" })).toBeNull();
    fireEvent.change(view.getByRole("textbox", { name: "Find a span" }), {
      target: { value: "absent" },
    });
    expect(view.getByText("No spans match these filters.")).toBeTruthy();
  });

  it("refreshes completed details and preserves the selected turn on reconnect", async () => {
    let result = trace({
      spans: trace().spans.map((item) =>
        item.id === "shell"
          ? { ...item, status: "running", detailSeq: 3 }
          : item,
      ),
    });
    const details = vi.fn(() => detail("npm test", "Still running"));
    const view = panel({ trace: () => result, detail: details });
    fireEvent.click(await view.findByRole("button", { name: "npm test" }));
    await waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    details.mockImplementation(() => detail("npm test", "Finished"));
    result = trace({
      turns: [
        ...trace().turns,
        { ...trace().turns[0]!, id: "turn-2", label: "Next turn" },
      ],
    });
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(details).toHaveBeenCalledTimes(2));
    expect(
      (view.getByRole("combobox", { name: "Select turn" }) as HTMLSelectElement)
        .value,
    ).toBe("turn-1");
    fireEvent.click(view.getByRole("tab", { name: "Output" }));
    expect(within(view.getByRole("region", { name: "Span inspector" })).getByRole("tabpanel").textContent).toBe("Finished");
    expect(
      view.inspection.rpcCalls.filter((call) => call.method === "trace"),
    ).toHaveLength(2);
  });

  it("follows the newest turn as it starts unless an older turn was chosen", async () => {
    const next = { ...trace().turns[0]!, id: "turn-2", label: "Next turn", status: "running" as const, endedAt: null };
    let result = trace();
    const view = panel({ trace: () => result });
    const turnSelect = async () => (await view.findByRole("combobox", { name: "Select turn" })) as HTMLSelectElement;
    const reconnect = async () => {
      await view.behavior.setRealtimeConnectionState("reconnecting");
      await view.behavior.setRealtimeConnectionState("connected");
    };
    expect((await turnSelect()).value).toBe("turn-1");
    result = trace({ turns: [...trace().turns, next], spans: [...trace().spans, span("probe", { name: "live probe", turnId: "turn-2", parentId: null })] });
    await reconnect();
    await view.findByRole("button", { name: "live probe" });
    expect((await turnSelect()).value).toBe("turn-2");
    fireEvent.change(await turnSelect(), { target: { value: "turn-1" } });
    result = trace({ turns: [...result.turns, { ...next, id: "turn-3", label: "Third turn" }] });
    await reconnect();
    await waitFor(() => expect(view.inspection.rpcCalls.filter((call) => call.method === "trace")).toHaveLength(3));
    expect((await turnSelect()).value).toBe("turn-1");
  });

  it("does not allow a slow previous detail response to replace the selected span", async () => {
    let resolveOld: ((value: SpanDetail) => void) | undefined;
    const view = panel({
      detail: ({ spanId }) =>
        spanId === "shell"
          ? new Promise<SpanDetail>((resolve) => {
              resolveOld = resolve;
            })
          : detail("New selection"),
    });
    fireEvent.click(await view.findByRole("button", { name: "npm test" }));
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    fireEvent.click(view.getByRole("button", { name: "npm build" }));
    await waitFor(() =>
      expect(within(view.getByRole("region", { name: "Span inspector" })).getByRole("tabpanel").textContent).toBe("New selection"),
    );
    await act(async () => {
      resolveOld!(detail("Stale selection"));
    });
    expect(within(view.getByRole("region", { name: "Span inspector" })).getByRole("tabpanel").textContent).toBe("New selection");
  });

  it("recovers from failed trace loads and passes the bounded history limit", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Thread unavailable"))
      .mockResolvedValue(trace({ hasOlder: true }));
    const view = panel({ trace: load });
    await view.findByText("Thread unavailable");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    fireEvent.click(await view.findByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(
        view.inspection.rpcCalls.some(
          (call) =>
            call.method === "trace" &&
            (call.input as { limit: number }).limit === 800,
        ),
      ).toBe(true),
    );
  });

  it("bounds rendered rows and renders the scrolled window in a large trace", async () => {
    const rows = Array.from({ length: 1500 }, (_, index) =>
      span(`tool-${index}`, { name: `Tool ${index}` }),
    );
    const view = panel({
      trace: () => trace({ spans: [trace().spans[0]!, ...rows] }),
    });
    await view.findByRole("list", { name: "Trace spans" });
    // Run the mount effect that scrolls to the top first, or it can undo the scroll below.
    await act(async () => {});
    expect(view.getAllByRole("listitem").length).toBeLessThan(40);
    const scroll = view.container.querySelector(".tr-tree-scroll")!;
    fireEvent.scroll(scroll, { target: { scrollTop: 40_000 } });
    expect(view.getAllByRole("listitem").length).toBeLessThan(40);
    expect(view.queryByRole("button", { name: "Tool 0" })).toBeNull();
    expect(view.getAllByRole("listitem")[0]!.textContent).toMatch(/Tool 110/);
  });

  it("does not invent unavailable timing and contains malformed ancestry", async () => {
    const { duration, flattenSpans } = await import("./app");
    expect(duration(null)).toBe("—");
    expect(duration(1250)).toBe("1.3 s");
    const rows = flattenSpans(
      [span("a", { parentId: "b" }), span("b", { parentId: "a" })],
      new Set(),
      "",
      false,
    );
    expect(rows).toHaveLength(2);
    const view = panel({
      trace: () =>
        trace({
          spans: [
            span("unknown", {
              name: "No timing",
              startedAt: null,
              endedAt: null,
              durationMs: null,
              timing: "unknown",
            }),
          ],
        }),
    });
    await view.findByText("Time unavailable");
    expect(view.container.querySelector(".tr-bar")).toBeNull();
  });
});

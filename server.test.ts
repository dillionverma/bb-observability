import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function fixture() {
  const thread = makeThreadResponse({ id: "thread-1", title: "RPC fixture", status: "idle", providerId: "codex" });
  const get = vi.fn(async () => thread);
  const events = vi.fn(async () => []);
  const host = createFakePluginHost({ pluginId: "observability", sdk: { threads: {
    get, list: async () => [thread], events: { list: events },
  } } });
  hosts.push(host);
  plugin(host.bb);
  return { ...host, thread, get, events };
}

describe("Traces plugin RPC and lifecycle", () => {
  it("validates RPC inputs before SDK calls and serializes the default trace shape", async () => {
    const f = fixture();
    await expect(f.harness.behavior.callRpc("trace", { threadId: "thread-1", limit: 2001 })).rejects.toThrow();
    await expect(f.harness.behavior.callRpc("trace", { threadId: "thread-1", limit: 99 })).rejects.toThrow();
    await expect(f.harness.behavior.callRpc("trace", { threadId: "thread-1", arbitrary: true })).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(await f.harness.behavior.callRpc("trace", { threadId: "thread-1" })).toMatchObject({
      thread: { id: "thread-1", title: "RPC fixture" }, limit: 400, hasOlder: false,
      eventCount: 0, lastSeq: 0, spans: [], turns: [], usage: null,
    });
    expect(await f.harness.behavior.callRpc("list", {})).toMatchObject({ threads: [{ id: "thread-1" }], hasMore: false });
  });

  it("invalidates cached history and publishes a small signal on live event updates", async () => {
    const f = fixture();
    await f.harness.behavior.callRpc("trace", { threadId: "thread-1" });
    await f.harness.behavior.callRpc("trace", { threadId: "thread-1" });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: f.thread, sequence: 12 })).toEqual({ errors: [] });
    expect(f.harness.inspection.realtimeSignals).toEqual([{ channel: "changed", payload: { threadId: "thread-1" } }]);
    await f.harness.behavior.callRpc("trace", { threadId: "thread-1" });
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("aborts outstanding SDK work on plugin disposal", async () => {
    const f = fixture();
    let receivedSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.harness.inspection.sdk.stub("threads.get", async (input: { signal?: AbortSignal }) => {
      receivedSignal = input.signal;
      entered();
      await new Promise<void>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return f.thread;
    });
    const pending = f.harness.behavior.callRpc("trace", { threadId: "thread-1" });
    const rejection = expect(pending).rejects.toThrow("aborted");
    await started;
    await f.harness.lifecycle.dispose();
    expect(receivedSignal?.aborted).toBe(true);
    await rejection;
  });

  it("uses only public SDK APIs and package-local source", async () => {
    const scan = await experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
      allow: [/^vitest$/, /^@testing-library\//, /^react(?:-dom)?(?:\/|$)/, /^@hugeicons\//, /^@radix-ui\//, /^(?:class-variance-authority|clsx|tailwind-merge)$/],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});

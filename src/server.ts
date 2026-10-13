import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./traces/contract";
import { TraceService } from "./traces/service";

export { rpcContract } from "./traces/contract";

export default function plugin(bb: BbPluginApi) {
  const service = new TraceService(bb.sdk.threads);
  bb.rpc.register(rpcContract, {
    list: input => service.list(input),
    trace: input => service.trace(input.threadId, input.limit, input.refresh),
    detail: input => service.detail(input.threadId, input.spanId, input.limit),
  });
  const changed = (threadId: string) => {
    service.invalidate(threadId);
    bb.realtime.publish("changed", { threadId });
  };
  bb.events.on("experimental_thread.events", ({ thread }) => changed(thread.id));
  bb.events.on("thread.created", ({ thread }) => changed(thread.id));
  bb.events.on("thread.idle", ({ thread }) => changed(thread.id));
  bb.events.on("thread.failed", ({ thread }) => changed(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => changed(thread.id));
  bb.onDispose(() => service.dispose());
}

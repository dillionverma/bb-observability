import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(300);
const status = z.enum(["running", "completed", "failed", "interrupted", "unknown"]);
const time = z.number().nullable();
const thread = z.object({ id, title: z.string(), provider: z.string(), status: z.string(), updatedAt: z.number(), projectId: z.string().nullable() });
const span = z.object({ id, parentId: id.nullable(), turnId: id, name: z.string(), kind: z.string(), status, startedAt: time, endedAt: time, durationMs: time, timing: z.enum(["reported", "observed", "unknown"]), sourceSeq: z.number(), detailSeq: z.number(), summary: z.string() });
const turn = z.object({ id, label: z.string(), model: z.string().nullable(), status, startedAt: time, endedAt: time, spanCount: z.number(), toolCount: z.number(), errorCount: z.number() });
export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ projectId: id.optional(), offset: z.number().int().min(0).max(10000).default(0), query: z.string().max(200).optional() }).strict(),
    output: z.object({ threads: z.array(thread), hasMore: z.boolean() }),
  },
  trace: {
    input: z.object({ threadId: id, limit: z.number().int().min(100).max(2000).default(400), refresh: z.boolean().optional() }).strict(),
    output: z.object({ thread, turns: z.array(turn), spans: z.array(span), usage: z.object({ input: z.number(), output: z.number(), cached: z.number(), total: z.number() }).nullable(), hasOlder: z.boolean(), limit: z.number(), eventCount: z.number(), lastSeq: z.number(), warnings: z.array(z.string()), fetchedAt: z.number() }),
  },
  detail: {
    input: z.object({ threadId: id, spanId: id, limit: z.number().int().min(100).max(2000).default(400) }).strict(),
    output: z.object({ input: z.string(), output: z.string(), metadata: z.string(), events: z.array(z.object({ seq: z.number(), type: z.string(), time: z.number() })), truncated: z.boolean() }),
  },
});

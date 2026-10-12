import { describe, expect, it } from "vitest";
import { extractUsage, groupUsage, skillSource } from "./usage";
import { buildTrace } from "./trace";
import type { EventRow } from "./model";

describe("skill evidence", () => {
  it("extracts multiple global and repo reads from wrapped RTK shell commands", () => {
    const result = extractUsage({ type: "commandExecution", command: `/bin/zsh -lc "rtk cat /home/me/.agents/skills/shadcn/SKILL.md; rtk sed -n '1,85p' '/repo with space/.agents/skills/shadcn/SKILL.md'"` });
    expect(result.tool).toBe("Shell");
    expect(result.skills).toEqual([
      { name: "shadcn", source: "/home/me/.agents/skills/shadcn/SKILL.md", evidence: "read", scope: "Global", origin: "Shared agents" },
      { name: "shadcn", source: "/repo with space/.agents/skills/shadcn/SKILL.md", evidence: "read" },
    ]);
  });
  it("does not claim that search, output, mentions or writes invoke skills", () => {
    for (const command of ['echo /skills/foo/SKILL.md', 'echo \"example; cat /skills/foo/SKILL.md\"', 'sed -i s/a/b/ /skills/foo/SKILL.md', 'rg SKILL.md .', 'cp /skills/foo/SKILL.md /tmp/copy', 'cat file.txt > /skills/foo/SKILL.md']) {
      expect(extractUsage({ type: "commandExecution", command }).skills).toEqual([]);
    }
    expect(extractUsage({ type: "agentMessage", text: "Using /skills/foo/SKILL.md" }).skills).toEqual([]);
    expect(extractUsage({ type: "toolCall", tool: "search", result: "/skills/foo/SKILL.md" }).skills).toEqual([]);
  });
  it("supports explicit Skill calls and structured reads with JSON arguments", () => {
    expect(extractUsage({ type: "toolCall", tool: "Skill", arguments: { skill: "shadcn" } }).skills[0]?.evidence).toBe("invoked");
    expect(extractUsage({ type: "toolCall", tool: "Read", arguments: JSON.stringify({ file_path: "/skills/foo/SKILL.md" }) }).skills[0]?.name).toBe("foo");
    expect(extractUsage({ type: "toolCall", tool: "Read", arguments: "invalid json" }).skills).toEqual([]);
  });
  it("keeps non-tool lifecycle metadata valid for strict JSON RPC", () => {
    const rows: EventRow[] = ["item/started", "item/completed"].map((type, i) => ({
      id: String(i), seq: i, createdAt: i, type, scope: { kind: "turn", turnId: "t" },
      data: { item: { id: "reply", type: "agentMessage", text: "Done" } },
    }));
    const usage = buildTrace(rows, "idle").spans[0].operationUsage;
    expect(usage).toEqual({ skills: [] });
    expect(Object.values(usage!)).not.toContain(undefined);
  });

  it("keeps start-only arguments, deduplicates lifecycle snapshots and separates paths", () => {
    const events: EventRow[] = [
      { id: "1", seq: 1, createdAt: 1, type: "item/started", scope: { kind: "turn", turnId: "t" }, data: { item: { id: "read", type: "toolCall", tool: "Read", arguments: { path: "/skills/foo/SKILL.md" } } } },
      { id: "2", seq: 2, createdAt: 2, type: "item/completed", scope: { kind: "turn", turnId: "t" }, data: { item: { id: "read", type: "toolCall", tool: "Read", status: "failed" } } },
    ];
    const usage = groupUsage(buildTrace(events, "idle").spans);
    expect(usage.skills).toHaveLength(1);
    expect(usage.skills[0].spans).toHaveLength(1);
    expect(usage.skills[0].spans[0].status).toBe("failed");
    expect(usage.tools[0].spans).toHaveLength(1);
  });
});


describe("source categories", () => {
  it("distinguishes shared, provider, plugin and BB global sources", () => {
    expect(skillSource("/Users/me/.agents/skills/foo/SKILL.md")).toEqual({ scope: "Global", origin: "Shared agents" });
    expect(skillSource("/home/me/.codex/skills/foo/SKILL.md")).toEqual({ scope: "Global", origin: "Codex" });
    expect(skillSource("~/.claude/skills/foo/SKILL.md")).toEqual({ scope: "Global", origin: "Claude" });
    expect(skillSource("/Users/me/.codex/plugins/cache/openai/product-design/1.0/skills/audit/SKILL.md")).toEqual({ scope: "Global", origin: "Codex plugin", packageName: "product-design" });
    expect(skillSource("/Users/me/.bb/runtime/global-skills/hash/skills/bb-cli/SKILL.md")).toEqual({ scope: "Global", origin: "BB" });
  });
  it("requires cwd evidence for project paths and omits unsupported labels", () => {
    expect(skillSource("/repo/.agents/skills/foo/SKILL.md", "/repo/apps/web")).toEqual({ scope: "Project", origin: "Shared agents" });
    expect(skillSource("/repo/.agents/skills/foo/SKILL.md", "/repo-other")).toEqual({});
    expect(skillSource("skill://foo")).toEqual({});
    expect(skillSource("shadcn")).toEqual({});
    expect(skillSource("/root-copy/.codex/skills/foo/SKILL.md")).toEqual({});
    const usage = extractUsage({ type: "commandExecution", command: "cat .agents/skills/foo/SKILL.md", cwd: "/repo" });
    expect(usage.skills[0]).toMatchObject({ source: "/repo/.agents/skills/foo/SKILL.md", scope: "Project" });
  });
  it("separates same-name MCP tools by server and labels only known origins", () => {
    const spans = ["linear", "github"].map((server, seq) => buildTrace([{
      id: String(seq), seq, createdAt: seq, type: "item/completed", scope: { kind: "turn", turnId: "t" },
      data: { item: { id: server, type: "mcpToolCall", tool: "search", server } },
    }], "idle").spans[0]);
    const groups = groupUsage(spans).tools;
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.subtitle)).toEqual(["MCP · linear", "MCP · github"]);
    expect(extractUsage({ type: "toolCall", tool: "mcp__cua_repl__js" }).toolOrigin).toBe("MCP · cua_repl");
    expect(extractUsage({ type: "commandExecution", command: "git status" }).toolOrigin).toBe("Built-in");
    expect(extractUsage({ type: "toolCall", tool: "custom" }).toolOrigin).toBeUndefined();
  });
  it("preserves server and project evidence when completion omits metadata", () => {
    const result = buildTrace(["item/started", "item/completed"].map((type, seq) => ({
      id: String(seq), seq, createdAt: seq, type, scope: { kind: "turn", turnId: "t" },
      data: { item: { id: "call", type: "toolCall", tool: "Read", arguments: { path: "/repo/.agents/skills/foo/SKILL.md" }, ...(seq === 0 ? { server: "files", cwd: "/repo" } : {}) } },
    })), "idle");
    expect(result.spans[0].operationUsage).toMatchObject({ toolOrigin: "MCP · files", skills: [{ scope: "Project" }] });
  });
});

it("preserves the MCP server identity when its completion is incomplete", () => {
  const result = buildTrace(["item/started", "item/completed"].map((type, seq) => ({
    id: String(seq), seq, createdAt: seq, type, scope: { kind: "turn", turnId: "t" },
    data: { item: { id: "call", type: "mcpToolCall", tool: "search", ...(seq === 0 ? { server: "linear" } : {}) } },
  })), "idle");
  expect(result.spans[0].operationUsage).toMatchObject({ toolOrigin: "MCP · linear", toolIdentity: JSON.stringify(["mcp", "linear", "search"]) });
});

import type { TraceSpan } from "./model";

export interface SkillEvidence {
  name: string;
  source: string;
  evidence: "read" | "invoked";
  scope?: "Global" | "Project";
  origin?: string;
  packageName?: string;
}
export interface OperationUsage {
  tool?: string;
  toolIdentity?: string;
  toolOrigin?: string;
  skills: SkillEvidence[];
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const toolNames: Record<string, string> = {
  commandExecution: "Shell", fileRead: "Read file", fileChange: "Edit files", search: "Search",
  webSearch: "Web search", webFetch: "Fetch page", imageGeneration: "Generate image",
  imageView: "View image", delegation: "Agent", backgroundTask: "Background task",
};

/** Classify recorded paths only; never inspect the filesystem or infer ownership from the reader. */
export function skillSource(path: string, cwd = ""): Pick<SkillEvidence, "scope" | "origin" | "packageName"> {
  const home = /^(?:~|\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/)/;
  const userPath = path.replace(home, "~");
  const plugin = userPath.match(/^~\/\.codex\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\//);
  if (plugin) return { scope: "Global", origin: "Codex plugin", packageName: plugin[1] };
  if (/^~\/\.bb\/runtime\/global-skills\//.test(userPath)) return { scope: "Global", origin: "BB" };
  const global = userPath.match(/^~\/\.(agents|codex|claude)\/skills\//);
  const origins: Record<string, string> = { agents: "Shared agents", codex: "Codex", claude: "Claude" };
  if (global) return { scope: "Global", origin: origins[global[1]] };
  const project = path.match(/^(.*)\/\.(agents|codex|claude)\/skills\//);
  if (project && project[1] && (cwd === project[1] || cwd.startsWith(`${project[1]}/`))) {
    return { scope: "Project", origin: origins[project[2]] };
  }
  return {};
}

function resolveSource(path: string, cwd: string): string {
  if (!path.startsWith("/") && !path.startsWith("~") && !path.includes(":") && cwd.startsWith("/")) path = `${cwd}/${path}`;
  if (!path.startsWith("/")) return path;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function toolSource(item: Record<string, unknown>, tool: string | undefined) {
  if (!tool) return {};
  const server = str(item.server).slice(0, 160);
  const namespaced = tool.match(/^mcp__([^]+?)__(.+)$/);
  if (server || namespaced) {
    const owner = server || namespaced![1];
    return { toolIdentity: JSON.stringify(["mcp", owner, tool]), toolOrigin: `MCP · ${owner}` };
  }
  if (toolNames[str(item.type)]) return { toolIdentity: JSON.stringify(["builtin", str(item.type), tool]), toolOrigin: "Built-in" };
  if (item.type === "mcpToolCall") return { toolIdentity: JSON.stringify(["mcp", "", tool]), toolOrigin: "MCP" };
  return { toolIdentity: JSON.stringify([str(item.type), tool]) };
}

/** Input evidence only. A skill read does not prove its instructions were followed. */
export function extractUsage(item: Record<string, unknown>): OperationUsage {
  const kind = str(item.type);
  const tool = str(item.tool) || toolNames[kind];
  let args = record(item.arguments);
  if (typeof item.arguments === "string") {
    try { args = record(JSON.parse(item.arguments)); } catch { /* Non-JSON arguments are not interpreted. */ }
  }
  const cwd = str(item.cwd || args.workdir || args.cwd).slice(0, 2000);
  const skills = new Map<string, SkillEvidence>();
  const addPath = (value: unknown) => {
    const path = resolveSource(str(value), cwd);
    if (!path || path.length > 1500 || !/(?:^|\/)SKILL\.md$/.test(path)) return;
    const name = path.split("/").at(-2);
    if (name) skills.set(path, { name, source: path, evidence: "read", ...skillSource(path, cwd) });
  };
  const leafTool = (tool ?? "").split(/[.:]/).at(-1)?.toLowerCase();
  if (leafTool === "skill") {
    const name = str(args.skill).slice(0, 200);
    if (name) skills.set(name, { name, source: name, evidence: "invoked" });
  }
  if (kind === "fileRead" || ["read", "read_file"].includes(leafTool ?? "")) {
    addPath(item.path ?? args.file_path ?? args.path);
    if (Array.isArray(item.paths)) item.paths.slice(0, 32).forEach(addPath);
  }
  if (kind === "commandExecution" || ["exec_command", "bash", "shell"].includes(leafTool ?? "")) {
    // Unwrap the shell's quoted -c payload; never evaluate command text.
    let command = str(item.command || args.cmd || args.command).slice(0, 64000);
    const wrapper = command.match(/^\S*(?:bash|zsh|sh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1$/);
    if (wrapper) command = wrapper[2].replace(/\\(["\\])/g, "$1");
    // Keep quoted strings intact so `echo "...; cat ..."` is never treated as a read.
    if (!command.includes("<<")) {
      const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n<>]|[^\s;|<>"']+/g) ?? [];
      let segment: string[] = [];
      const inspect = () => {
        const words = segment.map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
        if (words[0] === "rtk") words.shift();
        if (words[0] === "proxy") words.shift();
        const reader = words.shift();
        if (!["cat", "head", "tail", "sed"].includes(reader ?? "")) return;
        if (reader === "sed" && words.some(word => /^-i/.test(word))) return;
        for (const word of words) {
          if (word === ">" || word === "<") break;
          if (!/[`$]/.test(word)) addPath(word);
          if (skills.size >= 32) break;
        }
      };
      for (const token of tokens.slice(0, 4096)) {
        if ([";", "&&", "||", "|", "\n"].includes(token)) { inspect(); segment = []; }
        else segment.push(token);
      }
      inspect();
    }
  }
  return { ...(tool ? { tool: tool.slice(0, 160) } : {}), ...toolSource(item, tool?.slice(0, 160)), skills: [...skills.values()].slice(0, 32) };
}

export interface UsageBadge { label: string; kind: "scope" | "source" | "owner"; }
export interface UsageGroup { key: string; name: string; source: string; evidence?: SkillEvidence["evidence"]; subtitle?: string; badges?: UsageBadge[]; spans: TraceSpan[]; }
export function groupUsage(spans: TraceSpan[]) {
  const skills = new Map<string, UsageGroup>();
  const tools = new Map<string, UsageGroup>();
  for (const span of spans) {
    const tool = span.operationUsage?.tool;
    if (tool) {
      const key = span.operationUsage?.toolIdentity ?? tool;
      const origin = span.operationUsage?.toolOrigin;
      const group = tools.get(key) ?? { key, name: tool, source: origin ? `${origin} · ${tool}` : tool, ...(origin ? { subtitle: origin, badges: origin.split(" · ").map((label, index): UsageBadge => ({ label, kind: index === 0 ? "source" : "owner" })) } : {}), spans: [] };
      group.spans.push(span); tools.set(key, group);
    }
    for (const skill of span.operationUsage?.skills ?? []) {
      const key = `${skill.evidence}:${skill.source}`;
      const metadata = skill.origin ? skill : { ...skill, ...skillSource(skill.source) };
      const subtitle = [metadata.scope, metadata.origin, metadata.packageName].filter(Boolean).join(" · ");
      const badges: UsageBadge[] = [];
      if (metadata.scope) badges.push({ label: metadata.scope, kind: "scope" });
      if (metadata.origin) badges.push({ label: metadata.origin, kind: "source" });
      if (metadata.packageName) badges.push({ label: metadata.packageName, kind: "owner" });
      const name = metadata.packageName ? `${metadata.packageName} / ${skill.name}` : skill.name;
      const group = skills.get(key) ?? { key, ...skill, name, ...(subtitle ? { subtitle, badges } : {}), spans: [] };
      if (!group.spans.some(value => value.id === span.id)) group.spans.push(span);
      skills.set(key, group);
    }
  }
  return { skills: [...skills.values()], tools: [...tools.values()].sort((a, b) => b.spans.length - a.spans.length || a.name.localeCompare(b.name)) };
}

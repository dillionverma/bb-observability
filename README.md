# Traces

See where an agent run spends its time. Inspect the tool call that failed without digging through logs.

A plugin for [BB](https://getbb.app).

## Highlights

- **Live waterfall.** Turns and tool calls aligned with their recorded timing.
- **Skills and tools.** Dedicated Skills and Tools tabs group recorded tool calls and detects skill-file reads or explicit `Skill` calls. Open an entry to inspect its source call; global and repo skill paths remain separate. Rows show scope (Global or Project) and source (Shared agents, Codex, Claude, Codex plugin, or BB) when the recorded path supports it. MCP tools retain server identity, so same-name tools from different servers stay separate. Unidentified sources have no label. Counts cover the loaded history. A read is evidence of a requested file, not proof that the skill instructions were followed.
- **Inspect on demand.** Inputs, outputs, metadata, and source lifecycle events.
- **Reported usage.** Input, output, and cache token snapshots with explicit coverage limits.
- **Two entry points.** A sidebar viewer and a panel tab inside each thread.

## Install

```sh
bb plugin install https://github.com/dillionverma/bb-observability
```

Requires BB 0.43+ and a compatible Plugin SDK (see `package.json`).

## Use

Open **Traces** in the sidebar or add a Traces tab to a thread panel. Switch between Activity, Skills, Tools, and Usage. The inspector opens only when a call is selected; selecting a skill or tool source call takes you to its Activity view. Token counts are provider-reported thread snapshots, not per-tool costs.

## Designed to stay responsive

Span lists are virtualized. The server keeps six bounded snapshots and fetches large payloads only when selected. The initial 400-event window can expand to 2,000 events. No external service or persistent index is required.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```

Focused fixes and reproducible bug reports are welcome. Include BB version, platform, and steps to reproduce.

## Compatibility

The repository and display name are independent of BB’s persistent plugin identity. The internal ID remains `observability` so existing settings, stored data, CLI commands, and integrations continue to work.

## The Ultra suite

Built for getting work done across multiple threads, agents, and projects. Install only the pieces you need.

- [Ultra Sidebar](https://github.com/dillionverma/bb-plugin-ultra-sidebar) — Organize parallel work.
- [Ultra Launcher](https://github.com/dillionverma/bb-plugin-ultra-launcher) — Start the next run.
- [Ultra Topbar](https://github.com/dillionverma/bb-plugin-ultra-topbar) — Turn threads into pull requests.
- [Linear Panel](https://github.com/dillionverma/bb-plugin-linear-panel) — Keep issues beside execution.
- [Usage Window](https://github.com/dillionverma/bb-plugin-usage-window) — Keep account capacity in view.

## License

MIT. See [LICENSE](LICENSE).

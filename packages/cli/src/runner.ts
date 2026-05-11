/**
 * Internal entry-point spawned by the CLI under tsx.
 * Args: <configPath> <port> <mode:"dev"|"run">
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Runtime,
  createCliChannel,
  createStudioChannel,
  startServer,
  type AgentConfig,
} from "@cadmus/kernel";
import { listAgents, readConfig, updateConfig } from "./workspace.js";

async function main() {
  const [configPath, portArg, mode] = process.argv.slice(2);
  if (!configPath) {
    console.error("runner: missing config path");
    process.exit(1);
  }

  // Eagerly load .env.local if present.
  await loadDotEnv();

  const url = pathToFileURL(resolve(configPath)).href;
  const mod = (await import(url)) as { default?: AgentConfig; agent?: AgentConfig };
  const config = mod.default ?? mod.agent;
  if (!config || !config.processors) {
    console.error(`config at ${configPath} did not export a default AgentConfig`);
    process.exit(1);
  }

  // Channel wiring depends on mode:
  //  - dev    : auto-add a Studio channel for canvas visualization (the
  //             real I/O happens via the kernel HTTP server's
  //             /api/inject + SSE, which already tags events with
  //             source "channel:studio").
  //  - others : wire stdin/stdout via the built-in CLI channel.
  // Both auto-adds are no-ops if the agent's config already declares
  // a channel with the same name.
  const existingChannelNames = new Set((config.channels ?? []).map((c) => c.name));
  if (mode === "dev") {
    if (!existingChannelNames.has("studio")) {
      config.channels = [...(config.channels ?? []), createStudioChannel()];
    }
  } else {
    if (!existingChannelNames.has("cli")) {
      config.channels = [...(config.channels ?? []), createCliChannel()];
    }
  }

  const runtime = new Runtime(config, { verbose: true });
  await runtime.start();

  if (mode === "dev") {
    const port = Number(portArg) || 4000;

    // Workspace info (optional — only meaningful when running under
    // ~/.cadmus). Studio uses this to show the agent sidebar.
    const workspaceInfo = (() => {
      try {
        const agents = listAgents();
        if (agents.length === 0) return undefined;
        const cfg = readConfig();
        const activeAgent = cfg.activeAgent ?? config.agentId;
        return {
          activeAgent,
          agents: agents.map((a) => ({
            name: a.name,
            path: a.path,
            active: a.name === activeAgent,
          })),
          onSwitch: async (name: string) => {
            updateConfig({ activeAgent: name });
          },
        };
      } catch {
        return undefined;
      }
    })();

    startServer(runtime, { port, workspace: workspaceInfo });
    console.log("");
    console.log(`Studio UI: http://localhost:${process.env.CADMUS_STUDIO_PORT ?? 3001}`);
    console.log(`Inject:    curl -X POST http://localhost:${port}/api/inject -d '{"text":"hello"}'`);
    console.log("");
  } else {
    // CLI channel reads stdin; we just need to terminate when stdin closes.
    process.stdin.on("end", () => {
      // give in-flight processors a moment, then exit
      setTimeout(() => {
        void runtime.stop().then(() => process.exit(0));
      }, 1000);
    });
  }

  process.on("SIGINT", () => {
    void runtime.stop().then(() => process.exit(0));
  });
}

async function loadDotEnv(): Promise<void> {
  const candidates = [".env.local", ".env"];
  for (const f of candidates) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    const fs = await import("node:fs");
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

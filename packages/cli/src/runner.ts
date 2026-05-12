/**
 * Internal entry-point spawned by the CLI under tsx.
 * Args: <configPath> <port> <mode:"dev"|"run">
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Runtime,
  createCliChannel,
  createStudioChannel,
  startServer,
  type AgentConfig,
} from "@cadmus/kernel";
import { AGENTS_DIR, listAgents, readConfig, updateConfig } from "./workspace.js";

const CONFIG_CANDIDATES = [
  "cadmus.config.ts",
  "cadmus.config.mts",
  "cadmus.config.js",
  "cadmus.config.mjs",
];

function findConfigInDir(dir: string): string | null {
  for (const c of CONFIG_CANDIDATES) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Build a workspace from the parent of the running config — used in local
 * dev (`cadmus dev examples/foo/cadmus.config.ts`). Sidebar shows sibling
 * dirs that contain a cadmus.config.*. No `onSwitch` is provided — to load
 * a different agent, restart `cadmus dev` with the new path.
 */
function buildLocalWorkspace(configPath: string) {
  const dir = dirname(resolve(configPath));
  const parent = dirname(dir);
  const myName = basename(dir);
  if (!existsSync(parent)) return undefined;

  const agents: { name: string; path: string; active: boolean }[] = [];
  for (const entry of readdirSync(parent)) {
    const full = join(parent, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (!findConfigInDir(full)) continue;
    agents.push({ name: entry, path: full, active: entry === myName });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  if (agents.length === 0) return undefined;

  return { activeAgent: myName, agents };
}

async function main() {
  const [configPath, portArg, mode] = process.argv.slice(2);
  if (!configPath) {
    console.error("runner: missing config path");
    process.exit(1);
  }

  // Anchor storage paths to the agent's install directory.
  // Agent configs use relative paths like `.cadmus/timeline.db` and
  // `createMemory({ path: ".cadmus/memory.db" })`. SQLite resolves those
  // against cwd, so launching `cadmus start` from a random shell location
  // stranded the timeline + memory DBs in that shell's cwd — outside
  // ~/.cadmus/, invisible to `cadmus uninstall`, and silently re-attached
  // by the next install. Setting CADMUS_AGENT_DIR here lets the kernel
  // (timeline) and tools (memory) resolve relative storage paths against
  // the agent dir while leaving cwd alone for fs/shell tools.
  const configDir = dirname(resolve(configPath));
  if (!process.env.CADMUS_AGENT_DIR) {
    process.env.CADMUS_AGENT_DIR = configDir;
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

    // Workspace info shown in the Studio sidebar.
    //
    // - If the running config lives inside ~/.cadmus/agents/ (production —
    //   `cadmus start` always lands here), use the global workspace and
    //   `onSwitch` writes to ~/.cadmus/config.json.
    // - Otherwise (local dev — `cadmus dev examples/foo/cadmus.config.ts`),
    //   build a workspace from sibling directories of the running config
    //   and `onSwitch` re-spawns the supervisor onto the chosen sibling.
    const workspaceInfo = (() => {
      try {
        const resolvedConfig = resolve(configPath);
        const isInstalled = dirname(dirname(resolvedConfig)) === resolve(AGENTS_DIR);
        if (isInstalled) {
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
        }
        return buildLocalWorkspace(resolvedConfig);
      } catch {
        return undefined;
      }
    })();

    // The layout file lives next to the running config so example authors
    // can ship a curated layout (`cadmus.layout.json`) alongside the example,
    // and users who drag and save in Studio overwrite their local copy.
    const layoutPath = resolve(dirname(configPath), "cadmus.layout.json");

    startServer(runtime, { port, workspace: workspaceInfo, layoutPath });
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

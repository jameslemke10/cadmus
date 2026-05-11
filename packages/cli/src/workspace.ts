/**
 * Cadmus's global workspace at ~/.cadmus/.
 *
 * Layout:
 *   ~/.cadmus/
 *     cli/                  installed framework (clone of the repo)
 *     config.json           { activeAgent, apiKeys }
 *     agents/<name>/
 *       cadmus.config.ts    the agent's definition
 *       node_modules/@cadmus/kernel   symlink to ../../cli/packages/kernel
 *       .cadmus/timeline.db (created on first run)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME = homedir();
export const CADMUS_HOME = process.env.CADMUS_HOME ?? join(HOME, ".cadmus");
export const CLI_DIR = join(CADMUS_HOME, "cli");
export const AGENTS_DIR = join(CADMUS_HOME, "agents");
export const CONFIG_PATH = join(CADMUS_HOME, "config.json");
export const KERNEL_DIR = join(CLI_DIR, "packages", "kernel");
export const TOOLS_DIR = join(CLI_DIR, "packages", "tools");

export interface CadmusConfig {
  activeAgent?: string;
  /** Secrets applied to the runner's env. LLM keys + channel tokens live here. */
  apiKeys?: {
    GOOGLE_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    TELEGRAM_BOT_TOKEN?: string;
  };
  port?: number;
  studioPort?: number;
}

export function readConfig(): CadmusConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CadmusConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CadmusConfig): void {
  mkdirSync(CADMUS_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function updateConfig(patch: Partial<CadmusConfig>): CadmusConfig {
  const current = readConfig();
  const merged: CadmusConfig = {
    ...current,
    ...patch,
    apiKeys: { ...(current.apiKeys ?? {}), ...(patch.apiKeys ?? {}) },
  };
  writeConfig(merged);
  return merged;
}

export interface AgentEntry {
  name: string;
  path: string;
  configPath: string;
  active: boolean;
}

export function listAgents(): AgentEntry[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const config = readConfig();
  const active = config.activeAgent;
  const out: AgentEntry[] = [];
  for (const name of readdirSync(AGENTS_DIR)) {
    const path = join(AGENTS_DIR, name);
    if (!statSync(path).isDirectory()) continue;
    const configFile = findAgentConfig(path);
    if (!configFile) continue;
    out.push({
      name,
      path,
      configPath: configFile,
      active: name === active,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgentConfig(dir: string): string | null {
  const candidates = ["cadmus.config.ts", "cadmus.config.mts", "cadmus.config.js", "cadmus.config.mjs"];
  for (const c of candidates) {
    const p = resolve(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

export function getActiveAgent(): AgentEntry | null {
  const all = listAgents();
  if (all.length === 0) return null;
  const config = readConfig();
  const active = all.find((a) => a.name === config.activeAgent);
  return active ?? all[0];
}

/**
 * Symlink @cadmus/kernel and @cadmus/tools into an agent's node_modules so
 * its config can `import` them without a separate npm install.
 */
export function linkKernelInto(agentDir: string): void {
  const scope = join(agentDir, "node_modules", "@cadmus");
  mkdirSync(scope, { recursive: true });

  for (const [name, src] of [
    ["kernel", KERNEL_DIR],
    ["tools", TOOLS_DIR],
  ] as const) {
    if (!existsSync(src)) continue;
    const linkPath = join(scope, name);
    if (existsSync(linkPath)) continue;
    try {
      symlinkSync(src, linkPath, "dir");
    } catch {
      // ignore — non-fatal
    }
  }
}

/** Apply API keys from config.json into process.env (called before runner spawn). */
export function applyApiKeysToEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cfg = readConfig();
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(cfg.apiKeys ?? {})) {
    if (v && !out[k]) out[k] = v;
  }
  return out;
}

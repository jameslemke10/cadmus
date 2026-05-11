#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTS_DIR,
  CADMUS_HOME,
  CLI_DIR,
  CONFIG_PATH,
  applyApiKeysToEnv,
  findAgentConfig,
  getActiveAgent,
  linkKernelInto,
  listAgents,
  readConfig,
  updateConfig,
} from "./workspace.js";
import { readSecret, selectFromList } from "./prompts.js";
import {
  KERNEL_LOG,
  STUDIO_LOG,
  clearPidFile,
  elapsedSince,
  ensureRuntimeDirs,
  isAlive,
  readPidFile,
  tailFile,
  writePidFile,
} from "./daemon.js";
import { openSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(here, "..", "templates");

const args = process.argv.slice(2);
const cmd = args[0];

const HELP = `cadmus — open-source agent framework

Daily use
  cadmus start              Boot the active agent's kernel + Studio UI
  cadmus start --daemon     Boot in the background, logs to ~/.cadmus/logs/
  cadmus status             Show daemon status, pid, uptime, log paths
  cadmus stop               Kill any running cadmus processes
  cadmus list               Show installed agents (★ marks the active one)
  cadmus use <name>         Switch the active agent

Setup
  cadmus setup              Interactive: pick provider, paste API key
  cadmus update             Pull latest framework from main and rebuild
  cadmus config             Edit settings (alias for setup)

Agents
  cadmus add <name>         Create a new agent under ~/.cadmus/agents/<name>/
  cadmus rm <name>          Move an agent to ~/.Trash/cadmus-<name>-<ts>
  cadmus export <name>      Export agent to <name>.cadmus.json (--with-timeline optional)
  cadmus import <file>      Import an agent from a .cadmus.json file (--as <newname> optional)

Other
  cadmus inspect            Print the active agent's timeline as JSON
  cadmus uninstall          Move all of ~/.cadmus to trash (with confirm)
  cadmus version            Print the CLI version
  cadmus help               Show this help

Env overrides
  GOOGLE_API_KEY            Default model is Gemini.
  ANTHROPIC_API_KEY         For Claude models.
  CADMUS_PORT               Kernel HTTP port (default 4000).
  CADMUS_STUDIO_PORT        Studio UI port (default 3001).
  CADMUS_HOME               Workspace location (default ~/.cadmus).
`;

// ── helpers ─────────────────────────────────────────────────────────────

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function blue(s: string): string {
  return `\x1b[34m${s}\x1b[0m`;
}

function die(msg: string, code = 1): never {
  console.error(red("✗ ") + msg);
  process.exit(code);
}

function printVersion(): void {
  const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  process.stdout.write(`cadmus ${pkg.version}\n`);
}

function resolveTsxBin(): string {
  const candidates = [
    resolve(here, "..", "node_modules", ".bin", "tsx"),
    resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx"),
    resolve(CLI_DIR, "node_modules", ".bin", "tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "npx";
}

function findStudioDir(): string | null {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "apps", "studio");
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const next = resolve(dir, "..");
    if (next === dir) break;
    dir = next;
  }
  const installed = resolve(CLI_DIR, "apps", "studio");
  if (existsSync(resolve(installed, "package.json"))) return installed;
  return null;
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort
  }
}

function copyRecursive(src: string, dest: string, replacements: Record<string, string>): void {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry), replacements);
    }
  } else {
    let content = readFileSync(src, "utf8");
    for (const [key, value] of Object.entries(replacements)) {
      content = content.split(`{{${key}}}`).join(value);
    }
    writeFileSync(dest, content);
  }
}

// ── commands ────────────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  const active = getActiveAgent();
  if (!active) {
    console.log("");
    console.log(yellow("  No agents installed yet."));
    console.log(`  Run ${bold("cadmus add <name>")} to create one,`);
    console.log(`  or reinstall — the installer ships Cadmus and Claudius by default.`);
    console.log("");
    process.exit(1);
  }

  const daemon = args.includes("--daemon") || args.includes("-d");
  const config = readConfig();
  const port = Number(process.env.CADMUS_PORT ?? config.port ?? 4000);
  const studioPort = Number(process.env.CADMUS_STUDIO_PORT ?? config.studioPort ?? 3001);
  const tsxBin = resolveTsxBin();
  const runnerScript = resolve(here, "runner.js");
  const studioDir = findStudioDir();
  const env = applyApiKeysToEnv(process.env);

  // If a daemon is already running, refuse rather than orphan a second one.
  if (daemon) {
    const existing = readPidFile();
    if (existing && isAlive(existing.pid)) {
      console.log("");
      console.log(yellow(`  cadmus daemon already running (pid ${existing.pid}, agent ${existing.agent}).`));
      console.log(`  Use ${bold("cadmus stop")} first, or ${bold("cadmus status")} to inspect.`);
      console.log("");
      process.exit(1);
    } else if (existing) {
      // Stale pid file — clean up.
      clearPidFile();
    }
  }

  console.log("");
  console.log(`  ${bold("cadmus")}${daemon ? dim(" — background") : ""}`);
  console.log(`  ${dim("─".repeat(8))}`);
  console.log(`  agent  : ${green(active.name)}`);
  console.log(`  kernel : http://localhost:${port}`);
  if (studioDir) console.log(`  studio : http://localhost:${studioPort}${daemon ? "" : dim("  (starting…)")}`);
  console.log("");

  if (daemon) {
    ensureRuntimeDirs();
    const kernelLogFd = openSync(KERNEL_LOG, "a");
    const studioLogFd = openSync(STUDIO_LOG, "a");

    const kernel = spawn(
      tsxBin,
      [runnerScript, active.configPath, String(port), "dev"],
      {
        stdio: ["ignore", kernelLogFd, kernelLogFd],
        env,
        detached: true,
      },
    );
    kernel.unref();

    if (studioDir) {
      const studio = spawn("npx", ["next", "dev", "-p", String(studioPort)], {
        cwd: studioDir,
        stdio: ["ignore", studioLogFd, studioLogFd],
        env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
        detached: true,
      });
      studio.unref();
    }

    writePidFile({
      pid: kernel.pid ?? -1,
      startedAt: new Date().toISOString(),
      agent: active.name,
      kernelPort: port,
      studioPort,
    });

    console.log(green("✓ ") + `running in background (pid ${kernel.pid}).`);
    console.log(`  logs   : ${KERNEL_LOG}`);
    console.log(`           ${STUDIO_LOG}`);
    console.log(`  status : ${bold("cadmus status")}`);
    console.log(`  stop   : ${bold("cadmus stop")}`);
    console.log("");
    // Don't open a browser when daemonized — too surprising.
    process.exit(0);
  }

  // Foreground (default).
  const kernel = spawn(
    tsxBin,
    [runnerScript, active.configPath, String(port), "dev"],
    { stdio: "inherit", env },
  );

  let studio: ReturnType<typeof spawn> | null = null;
  if (studioDir) {
    studio = spawn("npx", ["next", "dev", "-p", String(studioPort)], {
      cwd: studioDir,
      stdio: "inherit",
      env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
    });
  }

  const browserDelay = studioDir ? 4000 : 1500;
  setTimeout(() => {
    void openBrowser(`http://localhost:${studioDir ? studioPort : port}`);
  }, browserDelay);

  const cleanup = () => {
    studio?.kill();
    kernel.kill();
  };
  process.on("SIGINT", () => {
    cleanup();
    setTimeout(() => process.exit(0), 200);
  });
  process.on("SIGTERM", cleanup);
  kernel.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

async function cmdStatus(): Promise<void> {
  const record = readPidFile();
  console.log("");
  console.log(`  ${bold("cadmus status")}`);
  console.log(`  ${dim("─".repeat(13))}`);

  if (!record) {
    console.log(`  ${dim("no daemon registered.")}`);
    console.log(`  start one with ${bold("cadmus start --daemon")}, or ${bold("cadmus start")} for foreground.`);
    console.log("");
    return;
  }

  const alive = isAlive(record.pid);
  if (!alive) {
    console.log(`  ${yellow("✗")} pid ${record.pid} is not running (stale pid file).`);
    console.log(`  clearing.`);
    clearPidFile();
    console.log("");
    return;
  }

  console.log(`  ${green("●")} running`);
  console.log(`  agent    : ${green(record.agent)}`);
  console.log(`  pid      : ${record.pid}`);
  console.log(`  uptime   : ${elapsedSince(record.startedAt)}`);
  console.log(`  kernel   : http://localhost:${record.kernelPort}`);
  console.log(`  studio   : http://localhost:${record.studioPort}`);
  console.log(`  logs     : ${KERNEL_LOG}`);
  console.log(`             ${STUDIO_LOG}`);
  console.log("");

  if (args.includes("--logs") || args.includes("--tail")) {
    console.log(`  ${dim("--- last 20 lines of kernel.log ---")}`);
    console.log(tailFile(KERNEL_LOG, 20));
    console.log("");
  }
}

async function cmdStop(): Promise<void> {
  // 1. If a daemon is registered, kill its pid directly.
  const record = readPidFile();
  if (record && isAlive(record.pid)) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  clearPidFile();

  // 2. Sweep for any foreground runners + Studio dev servers.
  const patterns = ["cadmus-cli runner", "tsx.*runner.js", "next dev -p"];
  for (const pattern of patterns) {
    try {
      const result = spawn("pkill", ["-f", pattern], { stdio: "ignore" });
      result.on("exit", () => undefined);
    } catch {
      // ignore
    }
  }
  // 3. Anything still on the standard ports.
  try {
    spawn("sh", ["-c", `lsof -ti :4000 | xargs kill 2>/dev/null; lsof -ti :3001 | xargs kill 2>/dev/null`], {
      stdio: "ignore",
    });
  } catch {
    // ignore
  }
  console.log(green("✓ ") + "stopped any running cadmus processes");
}

function cmdList(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log(yellow("  no agents installed"));
    console.log(`  run ${bold("cadmus add <name>")} to create one`);
    return;
  }
  console.log("");
  for (const a of agents) {
    const marker = a.active ? green("★") : " ";
    console.log(`  ${marker} ${bold(a.name)}  ${dim(a.path)}`);
  }
  console.log("");
  const config = readConfig();
  if (!config.activeAgent && agents.length > 0) {
    console.log(`  ${dim("(no active agent set — first one will be used)")}`);
  }
}

function cmdUse(): void {
  const name = args[1];
  if (!name) die("usage: cadmus use <name>");
  const all = listAgents();
  const match = all.find((a) => a.name === name);
  if (!match) die(`agent not found: ${name}`);
  updateConfig({ activeAgent: name });
  console.log(green("✓ ") + `active agent: ${bold(name)}`);
}

async function cmdSetup(): Promise<void> {
  console.log("");
  console.log(`  ${bold("Cadmus setup")}`);
  console.log(`  ${dim("─".repeat(13))}`);
  console.log("");

  const config = readConfig();

  console.log("  Cadmus needs an API key for at least one LLM provider.");
  console.log("");

  // Build menu options. Show "(current: …)" when a key is already saved
  // so re-runs are clear about what they'd overwrite.
  const googleHint = config.apiKeys?.GOOGLE_API_KEY
    ? `current: ${maskKey(config.apiKeys.GOOGLE_API_KEY)}`
    : "aistudio.google.com/apikey";
  const anthropicHint = config.apiKeys?.ANTHROPIC_API_KEY
    ? `current: ${maskKey(config.apiKeys.ANTHROPIC_API_KEY)}`
    : "console.anthropic.com/settings/keys";

  const provider = await selectFromList({
    prompt: `  ${bold("Which provider?")}`,
    options: [
      { label: "Google Gemini", value: "google", hint: googleHint },
      { label: "Anthropic Claude", value: "anthropic", hint: anthropicHint },
      { label: "Skip — set keys later (cadmus setup, env vars, or .env.local)", value: "skip" },
    ],
    defaultIndex: 0,
  });

  const apiKeys: NonNullable<typeof config.apiKeys> = { ...(config.apiKeys ?? {}) };

  if (provider === "google") {
    console.log("");
    console.log(`  Get a key: ${blue("https://aistudio.google.com/apikey")}`);
    const key = (await readSecret("  Paste GOOGLE_API_KEY (hidden): ")).trim();
    if (key) apiKeys.GOOGLE_API_KEY = key;
  } else if (provider === "anthropic") {
    console.log("");
    console.log(`  Get a key: ${blue("https://console.anthropic.com/settings/keys")}`);
    const key = (await readSecret("  Paste ANTHROPIC_API_KEY (hidden): ")).trim();
    if (key) apiKeys.ANTHROPIC_API_KEY = key;
  } else {
    console.log("");
    console.log(yellow("  ⚠ no provider configured."));
    console.log(
      "    set GOOGLE_API_KEY / ANTHROPIC_API_KEY in your env (or a .env.local in cwd),",
    );
    console.log("    or run cadmus setup again.");
  }

  // ── Channel step ────────────────────────────────────────────────
  // Studio always works out of the box (the runner auto-adds a studio
  // channel in dev mode), so this step is purely for external channels
  // like Telegram. Defaults to "Skip" because the most common path is
  // "just try Studio first."

  console.log("");
  const telegramHint = apiKeys.TELEGRAM_BOT_TOKEN
    ? `current: ${maskKey(apiKeys.TELEGRAM_BOT_TOKEN)}`
    : "t.me/botfather to get a token";

  const channelChoice = await selectFromList({
    prompt: `  ${bold("Connect an external channel?")}`,
    options: [
      {
        label: "Skip — Studio only",
        value: "skip",
        hint: "talk to your agent in the browser",
      },
      {
        label: "Telegram bot",
        value: "telegram",
        hint: telegramHint,
      },
    ],
    defaultIndex: 0,
  });

  if (channelChoice === "telegram") {
    console.log("");
    console.log(`  ${bold("Get a bot token from BotFather:")}`);
    console.log(`    1. Open Telegram (phone, desktop, or ${blue("https://web.telegram.org")})`);
    console.log(`    2. Search for ${bold("@BotFather")} and start a chat`);
    console.log(`    3. Send ${bold("/newbot")} and follow the prompts (pick a name, then a username)`);
    console.log(`    4. BotFather replies with your token — paste it below`);
    console.log("");
    const token = (await readSecret("  Paste TELEGRAM_BOT_TOKEN (hidden): ")).trim();
    if (token) {
      apiKeys.TELEGRAM_BOT_TOKEN = token;
      console.log(`  ${dim(`Saved. Switch to the telly agent with: ${bold("cadmus use telly")}`)}`);
    }
  }

  // ── Tool step ──────────────────────────────────────────────────
  // Optional secrets for built-in tools. Web search works without a key
  // (DuckDuckGo fallback); Brave is a higher-quality upgrade.

  console.log("");
  const braveHint = apiKeys.BRAVE_SEARCH_API_KEY
    ? `current: ${maskKey(apiKeys.BRAVE_SEARCH_API_KEY)}`
    : "optional — improves web_search quality";

  const toolChoice = await selectFromList({
    prompt: `  ${bold("Configure web tools?")}`,
    options: [
      {
        label: "Skip — DuckDuckGo is the default",
        value: "skip",
        hint: "no key needed for basic search",
      },
      {
        label: "Add Brave Search API key",
        value: "brave",
        hint: braveHint,
      },
    ],
    defaultIndex: 0,
  });

  if (toolChoice === "brave") {
    console.log("");
    console.log(`  Get a key: ${blue("https://brave.com/search/api/")}`);
    console.log(`  ${dim("(free tier: 2k queries/month, no credit card)")}`);
    const key = (await readSecret("  Paste BRAVE_SEARCH_API_KEY (hidden): ")).trim();
    if (key) apiKeys.BRAVE_SEARCH_API_KEY = key;
  }

  updateConfig({ apiKeys });
  console.log("");
  console.log(green("✓ ") + `saved to ${CONFIG_PATH}`);
  console.log("");
  console.log(`  ${dim("Studio (the live brain canvas + chat panel) will open at")}`);
  console.log(`  ${dim("http://localhost:3001 when you start cadmus.")}`);

  const start = await selectFromList({
    prompt: `  ${bold("Start cadmus now?")}`,
    options: [
      { label: "Yes — boot kernel + Studio", value: "yes" },
      { label: "Not yet — just save the key", value: "no" },
    ],
    defaultIndex: 0,
  });

  if (start === "yes") {
    console.log("");
    await cmdStart();
  } else {
    console.log("");
    console.log(`  ready when you are: ${bold("cadmus start")}`);
    console.log("");
  }
}

function maskKey(k: string): string {
  if (k.length <= 8) return "*".repeat(k.length);
  return k.slice(0, 4) + "…" + k.slice(-4);
}

async function cmdAdd(): Promise<void> {
  const name = args[1] ?? `agent-${Date.now().toString(36).slice(-4)}`;
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    die(`invalid agent name "${name}" — use letters, digits, hyphens, underscores`);
  }
  const target = join(AGENTS_DIR, name);
  if (existsSync(target)) die(`agent already exists: ${target}`);

  mkdirSync(target, { recursive: true });
  const templateDir = join(templatesDir, "agent-starter");
  if (!existsSync(templateDir)) die(`template missing: ${templateDir}`);
  copyRecursive(templateDir, target, { AGENT_NAME: name });

  linkKernelInto(target);
  updateConfig({ activeAgent: name });

  console.log("");
  console.log(green("✓ ") + `created ${bold(name)} at ${dim(target)}`);
  console.log("");
  console.log(`  ${bold("cadmus start")}     run it`);
  console.log(`  ${bold("cadmus list")}      see all agents`);
  console.log("");
}

interface AgentExport {
  format: "cadmus-agent-export-1";
  exported_at: string;
  name: string;
  config: string;
  readme?: string;
  memories?: unknown;
  timeline?: unknown[];
}

async function cmdExport(): Promise<void> {
  const name = args[1];
  if (!name) die("usage: cadmus export <name> [-o <file>] [--with-timeline]");
  const all = listAgents();
  const match = all.find((a) => a.name === name);
  if (!match) die(`agent not found: ${name}`);

  const withTimeline = args.includes("--with-timeline");
  const outIdx = args.indexOf("-o");
  const outPath = outIdx > 0 && args[outIdx + 1]
    ? resolve(process.cwd(), args[outIdx + 1])
    : resolve(process.cwd(), `${name}.cadmus.json`);

  const configContent = readFileSync(match.configPath, "utf8");
  const readmePath = join(match.path, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;

  const memoriesPath = join(match.path, ".cadmus", "memories.json");
  const memories = existsSync(memoriesPath)
    ? JSON.parse(readFileSync(memoriesPath, "utf8")) as unknown
    : undefined;

  let timeline: unknown[] | undefined;
  if (withTimeline) {
    const timelineDb = join(match.path, ".cadmus", "timeline.db");
    if (existsSync(timelineDb)) {
      const { Timeline } = await import(
        pathToFileURL(resolve(CLI_DIR, "packages", "kernel", "dist", "timeline.js")).href
      ).catch(() => import(
        pathToFileURL(resolve(here, "..", "..", "kernel", "dist", "timeline.js")).href
      ));
      const t = new (Timeline as new (path: string) => { all(): unknown[]; close(): void })(timelineDb);
      timeline = t.all();
      t.close();
    }
  }

  const payload: AgentExport = {
    format: "cadmus-agent-export-1",
    exported_at: new Date().toISOString(),
    name,
    config: configContent,
    readme,
    memories,
    timeline,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log("");
  console.log(green("✓ ") + `exported ${bold(name)} → ${dim(outPath)}`);
  console.log(dim(`  ${memories ? "+ memories" : "no memories"}, ${timeline ? `+ timeline (${timeline.length} events)` : "no timeline"}`));
  console.log("");
}

async function cmdImport(): Promise<void> {
  const filePath = args[1];
  if (!filePath) die("usage: cadmus import <file> [--as <name>]");
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) die(`file not found: ${abs}`);

  let payload: AgentExport;
  try {
    payload = JSON.parse(readFileSync(abs, "utf8")) as AgentExport;
  } catch (err) {
    die(`could not parse export file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (payload.format !== "cadmus-agent-export-1") {
    die(`unrecognized export format: ${payload.format}`);
  }

  const asIdx = args.indexOf("--as");
  const targetName = asIdx > 0 && args[asIdx + 1] ? args[asIdx + 1] : payload.name;
  if (!/^[a-z0-9_-]+$/i.test(targetName)) {
    die(`invalid name "${targetName}" — letters, digits, hyphens, underscores only`);
  }
  const target = join(AGENTS_DIR, targetName);
  if (existsSync(target)) {
    die(`agent already exists: ${targetName}\n  pick a new name with --as <name>`);
  }

  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "cadmus.config.ts"), payload.config);
  if (payload.readme) writeFileSync(join(target, "README.md"), payload.readme);

  if (payload.memories) {
    mkdirSync(join(target, ".cadmus"), { recursive: true });
    writeFileSync(
      join(target, ".cadmus", "memories.json"),
      JSON.stringify(payload.memories, null, 2),
    );
  }

  // Note: importing the timeline is intentionally skipped for V0.1 — replaying
  // events into a fresh DB requires kernel awareness we haven't built yet.
  // The export carries the events; future versions will replay them.

  linkKernelInto(target);
  updateConfig({ activeAgent: targetName });

  console.log("");
  console.log(green("✓ ") + `imported as ${bold(targetName)}`);
  console.log(dim(`  ${target}`));
  if (payload.timeline) {
    console.log(yellow("  ⚠ ") + `${payload.timeline.length} timeline events in the file were not replayed`);
    console.log(dim("    (timeline replay is a future feature — config + memories were imported)"));
  }
  console.log("");
  console.log(`  ${bold("cadmus start")}     run it`);
  console.log("");
}

async function cmdRm(): Promise<void> {
  const name = args[1];
  if (!name) die("usage: cadmus rm <name>");
  const target = join(AGENTS_DIR, name);
  if (!existsSync(target)) die(`agent not found: ${name}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  Move ${bold(name)} to trash? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log(dim("  cancelled"));
    return;
  }

  const trash = trashDir();
  const dest = join(trash, `cadmus-agent-${name}-${Date.now()}`);
  mkdirSync(trash, { recursive: true });
  renameSync(target, dest);

  // Clear active if it was this one.
  const config = readConfig();
  if (config.activeAgent === name) {
    const remaining = listAgents();
    updateConfig({ activeAgent: remaining[0]?.name });
  }

  console.log(green("✓ ") + `moved to ${dim(dest)}`);
}

async function cmdUninstall(): Promise<void> {
  if (!existsSync(CADMUS_HOME)) {
    console.log("nothing to uninstall");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(yellow(`  This will move ${CADMUS_HOME} to trash.`));
  console.log(yellow("  Your agents and timelines will be preserved there until you empty trash."));
  const answer = (await rl.question("  Continue? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log(dim("  cancelled"));
    return;
  }

  const trash = trashDir();
  mkdirSync(trash, { recursive: true });
  const dest = join(trash, `cadmus-${Date.now()}`);
  renameSync(CADMUS_HOME, dest);

  // Best-effort: also remove the symlinked binary from PATH dirs.
  for (const d of ["/opt/homebrew/bin/cadmus", "/usr/local/bin/cadmus", `${process.env.HOME}/.local/bin/cadmus`]) {
    try {
      if (existsSync(d)) {
        const fs = await import("node:fs");
        fs.unlinkSync(d);
      }
    } catch {
      // ignore
    }
  }

  console.log(green("✓ ") + `moved to ${dim(dest)}`);
  console.log(dim("  the cadmus command is no longer linked"));
}

function trashDir(): string {
  const home = process.env.HOME ?? "/tmp";
  if (process.platform === "darwin") return join(home, ".Trash");
  // Linux XDG-ish; macOS handles ~/.Trash natively.
  return join(home, ".local", "share", "Trash", "files");
}

async function cmdInspect(): Promise<void> {
  const active = getActiveAgent();
  if (!active) die("no active agent");
  const dbPath = process.env.CADMUS_TIMELINE ?? join(active.path, ".cadmus", "timeline.db");
  if (!existsSync(dbPath)) die(`no timeline at ${dbPath}`);
  const { Timeline } = await import(
    pathToFileURL(resolve(CLI_DIR, "packages", "kernel", "dist", "timeline.js")).href
  ).catch(() => import(
    pathToFileURL(resolve(here, "..", "..", "kernel", "dist", "timeline.js")).href
  ));
  const t = new (Timeline as new (path: string) => { all(): unknown[]; close(): void })(dbPath);
  console.log(JSON.stringify(t.all(), null, 2));
  t.close();
}

async function cmdUpdate(): Promise<void> {
  const installScript = resolve(CLI_DIR, "install.sh");
  if (!existsSync(installScript)) {
    die(
      `install.sh not found at ${installScript}.\n  Did you install via the curl one-liner?`,
    );
  }
  console.log("");
  console.log(`  ${bold("cadmus update")}`);
  console.log(`  ${dim("─".repeat(13))}`);
  console.log(`  Pulling latest from main; rebuilding kernel, tools, and CLI.`);
  console.log(`  Your installed agents and API keys stay put.`);
  console.log("");

  const child = spawn("bash", [installScript], {
    stdio: "inherit",
    env: { ...process.env, CADMUS_HOME },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function cmdDev(): Promise<void> {
  // Old-style: explicit config file path. Mostly for headless / CI.
  const configPath = args[1] ? resolve(process.cwd(), args[1]) : null;
  if (!configPath || !existsSync(configPath)) die("usage: cadmus dev <path/to/cadmus.config.ts>");
  const port = Number(process.env.CADMUS_PORT ?? "4000");
  const tsxBin = resolveTsxBin();
  const runnerScript = resolve(here, "runner.js");
  const env = applyApiKeysToEnv(process.env);
  const child = spawn(tsxBin, [runnerScript, configPath, String(port), "dev"], {
    stdio: "inherit",
    env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ── dispatch ────────────────────────────────────────────────────────────

(async () => {
  switch (cmd) {
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case "list":
    case "ls":
      return cmdList();
    case "use":
    case "switch":
      return cmdUse();
    case "setup":
    case "config":
      return cmdSetup();
    case "update":
      return cmdUpdate();
    case "add":
    case "init":
      return cmdAdd();
    case "rm":
    case "remove":
    case "delete":
      return cmdRm();
    case "export":
      return cmdExport();
    case "import":
      return cmdImport();
    case "uninstall":
      return cmdUninstall();
    case "inspect":
      return cmdInspect();
    case "dev":
      return cmdDev();
    case "version":
    case "--version":
    case "-v":
      return printVersion();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      console.error(red("unknown command: ") + cmd);
      process.stdout.write(HELP);
      process.exit(1);
  }
})().catch((err: unknown) => {
  console.error(red("✗ ") + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});

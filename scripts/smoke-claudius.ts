/**
 * Smoke test for the v1 framework end-to-end.
 *
 * - Imports the real Claudius config from examples/.
 * - Starts the runtime with a fresh in-memory timeline / memory.
 * - Injects a user message, waits for the LLM round-trip.
 * - Prints what landed on the timeline so we can see how it actually performs.
 *
 * Run:
 *   GOOGLE_API_KEY=... npx tsx scripts/smoke-claudius.ts
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Runtime, type AgentConfig } from "@cadmus/kernel";

async function main() {
// Lift API key from the local Cadmus config if env doesn't have it.
if (!process.env.GOOGLE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  const configPath = resolve(homedir(), ".cadmus", "config.json");
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      apiKeys?: { GOOGLE_API_KEY?: string; ANTHROPIC_API_KEY?: string };
    };
    if (cfg.apiKeys?.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = cfg.apiKeys.GOOGLE_API_KEY;
    if (cfg.apiKeys?.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.apiKeys.ANTHROPIC_API_KEY;
  }
}

if (!process.env.GOOGLE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("no API key in env or ~/.cadmus/config.json — aborting");
  process.exit(1);
}

const configMod = (await import(
  resolve(process.cwd(), "examples/claudius/cadmus.config.ts")
)) as { default: AgentConfig };
const config = configMod.default;

// Override storage to in-memory so we don't leave artifacts behind.
config.storage = { timelinePath: ":memory:" };

const runtime = new Runtime(config, { verbose: false });
await runtime.start();
console.log(`runtime started: ${config.name} (${config.agentId})`);
console.log(`processors: ${config.processors.map((p) => p.name).join(", ")}`);
console.log(`tools: ${Object.keys(config.tools ?? {}).join(", ")}`);
console.log("");

console.log("→ injecting: 'hi, what's 2+2?'");
const inputEvent = await runtime.inject("hi, what's 2+2?", "smoke-test", "text");
console.log(`  input event ${inputEvent.id} appended\n`);

// Wait for the pipeline to settle.
const deadline = Date.now() + 30_000;
let lastCount = 0;
let settled = false;
let lastChange = Date.now();
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const count = runtime.timeline.count();
  if (count !== lastCount) {
    lastCount = count;
    lastChange = Date.now();
  } else if (Date.now() - lastChange > 3000 && count > 1) {
    // No new events in 3s and we have at least one beyond input — call it done.
    settled = true;
    break;
  }
}

console.log(`pipeline ${settled ? "settled" : "timed out"} with ${runtime.timeline.count()} events:\n`);
const events = runtime.timeline.all();
for (const e of events) {
  const data = JSON.stringify(e.data, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : "      " + l))
    .join("\n");
  console.log(`  [${e.seq}] ${e.type}${e.source ? `  (${e.source})` : ""}`);
  console.log(`      ${data.slice(0, 500)}${data.length > 500 ? "…" : ""}`);
}

console.log("");
const output = events.find((e) => e.type === "output");
if (output) {
  console.log("✓ output event received");
  console.log(`  reply: ${(output.data as { text?: string }).text}`);
} else {
  console.log("✗ no output event — pipeline didn't reach the user");
}

const errors = events.filter((e) => e.type === "error");
if (errors.length > 0) {
  console.log("");
  console.log(`✗ ${errors.length} error event(s):`);
  for (const err of errors) console.log(`  - ${JSON.stringify(err.data)}`);
}

await runtime.stop();
process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

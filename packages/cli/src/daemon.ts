/**
 * Daemon helpers: pid file + log file paths, "is process alive" check.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { CADMUS_HOME } from "./workspace.js";

const RUN_DIR = join(CADMUS_HOME, "run");
const LOGS_DIR = join(CADMUS_HOME, "logs");

export const PID_FILE = join(RUN_DIR, "cadmus.pid");
export const KERNEL_LOG = join(LOGS_DIR, "kernel.log");
export const STUDIO_LOG = join(LOGS_DIR, "studio.log");

export function ensureRuntimeDirs(): void {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

export interface DaemonRecord {
  pid: number;
  startedAt: string;
  agent: string;
  kernelPort: number;
  studioPort: number;
}

export function writePidFile(record: DaemonRecord): void {
  ensureRuntimeDirs();
  writeFileSync(PID_FILE, JSON.stringify(record, null, 2) + "\n");
}

export function readPidFile(): DaemonRecord | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as DaemonRecord;
  } catch {
    return null;
  }
}

export function clearPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

/** Is the given pid currently a live process? Uses kill(pid, 0). */
export function isAlive(pid: number): boolean {
  try {
    // Signal 0 = ask the kernel "is this pid alive?" without actually signalling.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Human-friendly "5m 12s" elapsed since an ISO timestamp. */
export function elapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

/**
 * Probe whether a TCP port is free to bind. Used as a pre-flight before
 * spawning kernel + Studio, so collisions surface as a clean message
 * instead of an unhandled EADDRINUSE stack trace.
 *
 * If `host` is omitted, listens on the wildcard address (::) — matches
 * how Next.js binds the Studio port, so we catch IPv6-only squatters too.
 * For the kernel we pass "127.0.0.1" explicitly because that's the iface
 * the kernel binds to.
 */
export function isPortFree(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    try {
      if (host) tester.listen(port, host);
      else tester.listen(port);
    } catch {
      resolve(false);
    }
  });
}

/** Tail the last N lines of a file. Returns "" if the file doesn't exist. */
export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  try {
    const stat = statSync(path);
    if (stat.size === 0) return "";
    const content = readFileSync(path, "utf8");
    const split = content.split("\n");
    return split.slice(-lines - 1).join("\n");
  } catch {
    return "";
  }
}

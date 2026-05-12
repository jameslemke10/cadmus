# Channel

A bridge between an external system (CLI, Studio, voice, HTTP) and the timeline. Channels emit `input` events from external sources and route `output` events back out. Vocabulary defined in [glossary.md](glossary.md).

## Status

**v1 (draft).** Implemented in [packages/kernel/src/types.ts](../packages/kernel/src/types.ts) and used by the bundled CLI, Studio, and Scheduler channels. External-platform channels (Slack, Discord, etc.) live in separate packages.

## Channel interface

```ts
interface Channel {
  /** Unique name. Used as the `channel` field on input / output events. */
  name: string;

  /**
   * Event types this channel emits onto the timeline. Typically ["input"].
   * Declared so the runtime and Studio can show channel topology.
   */
  inboundEvents?: string[];

  /**
   * Event types this channel routes off the timeline. Typically ["output"].
   */
  outboundEvents?: string[];

  /** Begin listening to the external system. Idempotent. */
  start: (ctx: ChannelContext) => Promise<void>;

  /** Stop and disconnect. Should drain in-flight work where reasonable. */
  stop: () => Promise<void>;

  /** Free-form per-instance config. */
  config?: Record<string, unknown>;
}

interface ChannelContext {
  emit: (type: string, data: Record<string, unknown>) => Promise<CadmusEvent>;
  timeline: TimelineReader;
  subscribe: (listener: (event: CadmusEvent) => void) => () => void;
  log: (msg: string, data?: unknown) => void;
}
```

## How a channel works

1. **`start(ctx)`** — the channel connects to its external system (Slack socket, IMAP server, web socket, etc.).
2. **Inbound** — when external traffic arrives, the channel calls:
   ```ts
   ctx.emit("input", {
     channel: this.name,
     kind: "text",
     text: "...",
     // optional channel-specific fields
   });
   ```
3. **Outbound** — the channel subscribes to the timeline via `ctx.subscribe()` and watches for `output` events with `data.channel === this.name` (or `"*"` for broadcast).
4. **Routing** — on a matching `output`, the channel translates the payload into a message for the external system and delivers it.
5. **`stop()`** — graceful disconnect.

## Reserved channel names

These are conventional names with documented semantics. Don't redefine them.

- `cli` — local terminal bridge. Reads from stdin, writes to stdout.
- `studio` — Studio web UI chat panel.
- `app` — programmatic / SDK consumers calling the kernel directly.
- `system` — synthetic events the kernel itself injects (e.g., scheduler firings). No external destination.

Platform channels use the platform name verbatim: `slack`, `discord`, `whatsapp`, `email`. One per platform.

## Conformance

A channel is considered conforming if:

- `start()` is idempotent — calling it twice without an intervening `stop()` is a no-op.
- All `input` events it emits have `data.channel === channel.name`.
- All `input` events it emits have `data.kind` from the canonical set ([events-v1.md](events-v1.md#input)) or a documented custom kind.
- It handles `output` events whose `data.channel` matches its name OR is `"*"`.
- It does NOT emit events with types other than those declared in `inboundEvents`.
- It does NOT consume events with types other than those declared in `outboundEvents`.

The runtime supplies an `assertChannelConforms(channel)` test harness (planned) that exercises start/stop/inbound/outbound paths against a mock external system.

## Conventions

- **Channels do not interpret.** They translate between an external transport and timeline events. Logic (parsing intent, formatting responses, deciding what to say) belongs in processors.
- **One channel per external system instance.** A bot watching two workspace tokens is two channels, not one.
- **Channels can be inbound-only.** A scheduler channel emits `input` from cron firings but never routes anything out.

## Reference implementation

`@cadmus/channels/cli` — built into the kernel as the local default. Reads stdin → emits `input` with `channel: "cli"`; subscribes to `output` events for `channel: "cli"` → writes to stdout.

External channels live in `@cadmus/channels/<name>` packages:

- `@cadmus/channels/slack`
- `@cadmus/channels/discord`
- `@cadmus/channels/email`

## Deferred / not in v1

- **Channel-typed events** (`channel_inbound` / `channel_outbound` as event types). Rejected; direction lives in the type name (`input` vs `output`), origin lives in the payload (`data.channel`).
- **Channel groups / routing rules.** "Send to all Slack channels except DMs" — too speculative; channels handle their own filtering.
- **Bidirectional persistent threading.** Mapping timeline events back to specific external threads (a Slack thread, an email reply chain) is the channel's concern in v1. May be standardized later.
- **Channel authentication / authorization.** Per-user identity inside a channel is the channel's concern, not framework-level.

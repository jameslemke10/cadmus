/**
 * Conformance — runs the public assertXConforms harnesses against the
 * built-in implementations. If these fail, every spec-compliant backend
 * downstream would also fail, so this is the first line of defense.
 */

import { test } from "node:test";
import { Timeline } from "../src/timeline.js";
import { createCliChannel } from "../src/channels/cli.js";
import {
  assertChannelStructure,
  assertTimelineConforms,
} from "../src/conformance/index.js";

test("SQLite Timeline conforms to TimelineStore", async () => {
  await assertTimelineConforms(() => new Timeline(":memory:"));
});

test("createCliChannel passes structural conformance", () => {
  // We don't run the lifecycle harness because the CLI channel hooks
  // process.stdin and would leak listeners across tests. Structural
  // checks (name / inboundEvents / outboundEvents / start+stop are
  // functions) are enough at this layer.
  assertChannelStructure(createCliChannel());
});

/**
 * Conformance test harnesses for Cadmus's core abstractions.
 *
 * Each harness verifies that an implementation satisfies the contract
 * documented in the corresponding spec file. Run them in your own test
 * suite to certify a third-party backend / channel / etc.
 *
 *   import {
 *     assertTimelineConforms,
 *     assertMemoryStoreConforms,
 *     assertChannelConforms,
 *   } from "@cadmus/kernel/conformance";
 */

export { assertTimelineConforms } from "./timeline.js";
export { assertMemoryStoreConforms } from "./memory.js";
export {
  assertChannelStructure,
  assertChannelLifecycle,
  assertChannelConforms,
} from "./channel.js";

/**
 * oh-my-pi/pi-ai/open-sdk — internal exports needed by amazon-bedrock.ts
 * and other provider implementations that aren't in the public pi-ai index.
 *
 * Usage (via ExtensionAPI in extensions):
 *   const creds = await pi.pi.resolveAwsCredentials({ region: "us-east-1" });
 */
// AWS provider internals
export { resolveAwsCredentials } from "./providers/aws-credentials";
export { decodeEventStream } from "./providers/aws-eventstream";
export { signRequest } from "./providers/aws-sigv4";
export { transformMessages } from "./providers/transform-messages";
export { streamBedrock } from "./providers/amazon-bedrock";
export type { BedrockOptions, BedrockThinkingDisplay } from "./providers/amazon-bedrock";

// Utilities not in public API
export { AssistantMessageEventStream } from "./utils/event-stream";
export { appendRawHttpRequestDumpFor400, withHttpStatus } from "./utils/http-inspector";
export type { RawHttpRequestDump } from "./utils/http-inspector";
export { parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils/json-parse";
export { normalizeToolCallId, resolveCacheRetention } from "./utils";
export { toolWireSchema } from "./utils/schema/wire";

// Idle/timeout handling for streams
export { getStreamIdleTimeoutMs, getOpenAIStreamIdleTimeoutMs, getStreamFirstEventTimeoutMs, getOpenAIStreamFirstEventTimeoutMs } from "./utils/idle-iterator";
export type { IdleTimeoutIteratorOptions } from "./utils/idle-iterator";


// Request debug
export { isRequestDebugEnabled } from "./utils/request-debug";
export type { RequestDebugHeaders, RequestDebugPayload, RequestDebugResponseLog, RequestDebugSession } from "./utils/request-debug";

// Stream markup healing (Kimi, DeepSeek, thinking blocks)
export { StreamMarkupHealing } from "./utils/stream-markup-healing";
export type { HealedToolCall, StreamMarkupHealingPattern, StreamMarkupHealingOptions, StreamMarkupHealingEvent } from "./utils/stream-markup-healing";

// SSE debug
export { notifyRawSseEvent } from "./utils/sse-debug";

// SDK stream timeout
export { resolveSdkTimeoutMs, createSdkStreamRequestOptions } from "./utils/sdk-stream-timeout";

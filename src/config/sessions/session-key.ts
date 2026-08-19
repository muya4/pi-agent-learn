/**
 * 会话键解析（config 层）：根据 SessionScope 与 MsgContext 推导或解析 sessionKey。
 * 与 routing/session-key 的 buildAgentMainSessionKey 等配合，用于持久化与多端会话一致。
 */
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { resolveGroupSessionKey } from "./group.js";
import type { SessionScope } from "./types.js";

/** 根据 scope 与上下文决定会话桶：global 固定为 "global"，否则按群组或发送者 */
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") {
    return "global";
  }
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) {
    return resolvedGroup.key;
  }
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return normalizeExplicitSessionKey(explicit, ctx);
  }
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw;
  }
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: canonicalMainKey,
  });
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    return canonical;
  }
  return `agent:${DEFAULT_AGENT_ID}:${raw}`;
}

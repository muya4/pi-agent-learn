import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { loadConfig } from "../config.js";
import type { SessionScope } from "./types.js";


// resolveMainSessionKey的参数是什么？
// cfg?: { session?: { scope?: SessionScope; mainKey?: string }; agents?: { list?: Array<{ id?: string; default?: boolean }> } }
// cfg的内容是什么？
// cfg是配置文件中的配置，包含 session 和 agents 配置。它的作用是什么？
// 它的作用是管理 session 和 agents 的配置，当 session 和 agents 配置发生变化时，会触发 resolveMainSessionKey 函数，重新计算 session 和 agents 的配置。
export function resolveMainSessionKey(cfg?: {
  session?: { scope?: SessionScope; mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  if (cfg?.session?.scope === "global") {
    return "global";
  }
  const agents = cfg?.agents?.list ?? [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  // agentId的具体数据是什么，举个例子
  // { id: "123", default: true }
  const agentId = normalizeAgentId(defaultAgentId);
  // mainKey的具体数据是什么？ 举个例子
  // 'main'
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  // buildAgentMainSessionKey的参数是什么？
  // { agentId: string; mainKey: string }
  // agentId的内容是什么？
  // '123' 类型是 string
  // mainKey的内容是什么？
  // 'main' 类型是 string
  // buildAgentMainSessionKey的返回值是什么？
  // 'agent:123:main' 类型是string
  return buildAgentMainSessionKey({ agentId, mainKey });
}

export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(loadConfig());
}

export { resolveAgentIdFromSessionKey };

export function resolveAgentMainSessionKey(params: {
  cfg?: { session?: { mainKey?: string } };
  agentId: string;
}): string {
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

export function resolveExplicitAgentSessionKey(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId?: string | null;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return undefined;
  }
  return resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
}

export function canonicalizeMainSessionAlias(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId: string;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return raw;
  }

  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  const agentMainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  const agentMainAliasKey = buildAgentMainSessionKey({
    agentId,
    mainKey: "main",
  });

  const isMainAlias =
    raw === "main" || raw === mainKey || raw === agentMainSessionKey || raw === agentMainAliasKey;

  if (params.cfg?.session?.scope === "global" && isMainAlias) {
    return "global";
  }
  if (isMainAlias) {
    return agentMainSessionKey;
  }
  return raw;
}

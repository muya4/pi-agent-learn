import { normalizeProviderId } from "../agents/model-selection.js";
import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
} from "../channels/plugins/catalog.js";
import {
  getChatChannelMeta,
  listChatChannels,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";
import { hasAnyWhatsAppAuth } from "../web/accounts.js";
import type { OpenClawConfig } from "./config.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";

type PluginEnableChange = {
  pluginId: string;
  reason: string;
};

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
};

const CHANNEL_PLUGIN_IDS = Array.from(
  new Set([
    ...listChatChannels().map((meta) => meta.id),
    ...listChannelPluginCatalogEntries().map((entry) => entry.id),
  ]),
);

const PROVIDER_PLUGIN_IDS: Array<{ pluginId: string; providerId: string }> = [
  { pluginId: "google-gemini-cli-auth", providerId: "google-gemini-cli" },
  { pluginId: "qwen-portal-auth", providerId: "qwen-portal" },
  { pluginId: "copilot-proxy", providerId: "copilot-proxy" },
  { pluginId: "minimax-portal-auth", providerId: "minimax-portal" },
];

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordHasKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function accountsHaveKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const account of Object.values(value)) {
    if (!isRecord(account)) {
      continue;
    }
    for (const key of keys) {
      if (hasNonEmptyString(account[key])) {
        return true;
      }
    }
  }
  return false;
}

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

type StructuredChannelConfigSpec = {
  envAny?: readonly string[];
  envAll?: readonly string[];
  stringKeys?: readonly string[];
  numberKeys?: readonly string[];
  accountStringKeys?: readonly string[];
};

const STRUCTURED_CHANNEL_CONFIG_SPECS: Record<string, StructuredChannelConfigSpec> = {
  telegram: {
    envAny: ["TELEGRAM_BOT_TOKEN"],
    stringKeys: ["botToken", "tokenFile"],
    accountStringKeys: ["botToken", "tokenFile"],
  },
  discord: {
    envAny: ["DISCORD_BOT_TOKEN"],
    stringKeys: ["token"],
    accountStringKeys: ["token"],
  },
  irc: {
    envAll: ["IRC_HOST", "IRC_NICK"],
    stringKeys: ["host", "nick"],
    accountStringKeys: ["host", "nick"],
  },
  slack: {
    envAny: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
    stringKeys: ["botToken", "appToken", "userToken"],
    accountStringKeys: ["botToken", "appToken", "userToken"],
  },
  signal: {
    stringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
    numberKeys: ["httpPort"],
    accountStringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
  },
  imessage: {
    stringKeys: ["cliPath"],
  },
};

function envHasAnyKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (hasNonEmptyString(env[key])) {
      return true;
    }
  }
  return false;
}

function envHasAllKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (!hasNonEmptyString(env[key])) {
      return false;
    }
  }
  return keys.length > 0;
}

function hasAnyNumberKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (typeof entry[key] === "number") {
      return true;
    }
  }
  return false;
}

function isStructuredChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv,
  spec: StructuredChannelConfigSpec,
): boolean {
  if (spec.envAny && envHasAnyKeys(env, spec.envAny)) {
    return true;
  }
  if (spec.envAll && envHasAllKeys(env, spec.envAll)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, channelId);
  if (!entry) {
    return false;
  }
  if (spec.stringKeys && spec.stringKeys.some((key) => hasNonEmptyString(entry[key]))) {
    return true;
  }
  if (spec.numberKeys && hasAnyNumberKeys(entry, spec.numberKeys)) {
    return true;
  }
  if (spec.accountStringKeys && accountsHaveKeys(entry.accounts, spec.accountStringKeys)) {
    return true;
  }
  return recordHasKeys(entry);
}

function isWhatsAppConfigured(cfg: OpenClawConfig): boolean {
  if (hasAnyWhatsAppAuth(cfg)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, "whatsapp");
  if (!entry) {
    return false;
  }
  return recordHasKeys(entry);
}

function isGenericChannelConfigured(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return recordHasKeys(entry);
}

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (channelId === "whatsapp") {
    return isWhatsAppConfigured(cfg);
  }
  const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
  if (spec) {
    return isStructuredChannelConfigured(cfg, channelId, env, spec);
  }
  return isGenericChannelConfigured(cfg, channelId);
}

function collectModelRefs(cfg: OpenClawConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      refs.push(value.trim());
    }
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) {
      return;
    }
    const model = agent.model;
    if (typeof model === "string") {
      pushModelRef(model);
    } else if (isRecord(model)) {
      pushModelRef(model.primary);
      const fallbacks = model.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const entry of fallbacks) {
          pushModelRef(entry);
        }
      }
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  const defaults = cfg.agents?.defaults as Record<string, unknown> | undefined;
  collectFromAgent(defaults);

  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) {
        collectFromAgent(entry);
      }
    }
  }
  return refs;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);

  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) {
        continue;
      }
      const provider = normalizeProviderId(String(profile.provider ?? ""));
      if (provider === normalized) {
        return true;
      }
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) {
        return true;
      }
    }
  }

  const modelRefs = collectModelRefs(cfg);
  for (const ref of modelRefs) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) {
      return true;
    }
  }

  return false;
}

function buildChannelToPluginIdMap(registry: PluginManifestRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels) {
      if (channelId && !map.has(channelId)) {
        map.set(channelId, record.id);
      }
    }
  }
  return map;
}

function resolvePluginIdForChannel(
  channelId: string,
  channelToPluginId: ReadonlyMap<string, string>,
): string {
  // Third-party plugins can expose a channel id that differs from their
  // manifest id; plugins.entries must always be keyed by manifest id.
  const builtInId = normalizeChatChannelId(channelId);
  if (builtInId) {
    return builtInId;
  }
  return channelToPluginId.get(channelId) ?? channelId;
}

function collectCandidateChannelIds(cfg: OpenClawConfig): string[] {
  const channelIds = new Set<string>(CHANNEL_PLUGIN_IDS);
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return Array.from(channelIds);
  }
  for (const key of Object.keys(configuredChannels)) {
    if (key === "defaults" || key === "modelByChannel") {
      continue;
    }
    const normalizedBuiltIn = normalizeChatChannelId(key);
    channelIds.add(normalizedBuiltIn ?? key);
  }
  return Array.from(channelIds);
}

function resolveConfiguredPlugins(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): PluginEnableChange[] {
  
  const changes: PluginEnableChange[] = [];
  // Build reverse map: channel ID → plugin ID from installed plugin manifests.
  // 这行代码做了什么？
  // 构建通道到插件 ID 的映射
  const channelToPluginId = buildChannelToPluginIdMap(registry);
  // 这行代码做了什么？
  // 收集候选通道 ID
  for (const channelId of collectCandidateChannelIds(cfg)) {
    // 这行代码做了什么？
    // 解析通道 ID 对应的插件 ID，并检查通道是否配置
    const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({ pluginId, reason: `${channelId} configured` });
    }
  }

  for (const mapping of PROVIDER_PLUGIN_IDS) {
    if (isProviderConfigured(cfg, mapping.providerId)) {
      changes.push({
        pluginId: mapping.pluginId,
        reason: `${mapping.providerId} auth configured`,
      });
    }
  }
  const backendRaw =
    typeof cfg.acp?.backend === "string" ? cfg.acp.backend.trim().toLowerCase() : "";
  const acpConfigured =
    cfg.acp?.enabled === true || cfg.acp?.dispatch?.enabled === true || backendRaw === "acpx";
  if (acpConfigured && (!backendRaw || backendRaw === "acpx")) {
    changes.push({
      pluginId: "acpx",
      reason: "ACP runtime configured",
    });
  }
  return changes;
}

function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  // 这行代码做了什么？
  // 检查插件是否显式禁用
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const channelConfig = channels?.[builtInChannelId];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      return true;
    }
  }
  const entry = cfg.plugins?.entries?.[pluginId];
  return entry?.enabled === false;
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function resolvePreferredOverIds(pluginId: string): string[] {
  const normalized = normalizeChatChannelId(pluginId);
  if (normalized) {
    return getChatChannelMeta(normalized).preferOver ?? [];
  }
  const catalogEntry = getChannelPluginCatalogEntry(pluginId);
  return catalogEntry?.meta.preferOver ?? [];
}

function shouldSkipPreferredPluginAutoEnable(
  cfg: OpenClawConfig,
  entry: PluginEnableChange,
  configured: PluginEnableChange[],
): boolean {
  for (const other of configured) {
    if (other.pluginId === entry.pluginId) {
      continue;
    }
    if (isPluginDenied(cfg, other.pluginId)) {
      continue;
    }
    if (isPluginExplicitlyDisabled(cfg, other.pluginId)) {
      continue;
    }
    const preferOver = resolvePreferredOverIds(other.pluginId);
    if (preferOver.includes(entry.pluginId)) {
      return true;
    }
  }
  return false;
}

function registerPluginEntry(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  // 为什么normalizeChatChannelId？
  // 因为插件 ID 可能不规范，需要规范化
  const builtInChannelId = normalizeChatChannelId(pluginId);
  // 如果插件 ID 是内置通道 ID，则直接注册
  if (builtInChannelId) {
    // 这行代码做了什么？
    // 获取通道配置, as 是什么语法？
    // as 是类型断言，表示将 existing 类型断言为 Record<string, unknown> 
    // 这个channels为什么要用类型断言？
    // 因为cfg.channels可能不是Record<string, unknown>，需要类型断言
    // channels的内容是什么？
    // ChannelsConfig
    const channels = cfg.channels as Record<string, unknown> | undefined;
    
    const existing = channels?.[builtInChannelId];
    const existingRecord =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    // 返回的内容是什么含义？举个例子？
    // return的内容是什么？

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...existingRecord,
          enabled: true,
        },
      },
    };
  }
  const entries = {
    ...cfg.plugins?.entries,
    [pluginId]: {
      ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
      enabled: true,
    },
  };
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function formatAutoEnableChange(entry: PluginEnableChange): string {
  
  // reason 的 trim()是什么？
  // 去掉reason两端的空格
  let reason = entry.reason.trim();
  const channelId = normalizeChatChannelId(entry.pluginId);
  // getChatChannelMeta的返回值是什么？
  // { label: string; preferOver: string[] }
  // channelId的内容是什么？
  // 通道ID
  if (channelId) {
    // 这行代码做了什么？
    // 获取通道标签
    const label = getChatChannelMeta(channelId).label;
    reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
  }
  return `${reason}, enabled automatically.`;
}

export function applyPluginAutoEnable(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Pre-loaded manifest registry. When omitted, the registry is loaded from
   *  the installed plugins on disk. Pass an explicit registry in tests to
   *  avoid filesystem access and control what plugins are "installed". */
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  // 这行代码做了什么？
  // 获取环境变量
  const env = params.env ?? process.env;
  // 这行代码做了什么？
  // 加载插件清单
  const registry = params.manifestRegistry ?? loadPluginManifestRegistry({ config: params.config });
  // 这行代码做了什么？
  // 解析配置文件
  // configured的内容是什么？
  // { pluginId: string; reason: string }[]
  const configured = resolveConfiguredPlugins(params.config, env, registry);
  // 这行代码做了什么？
  // 如果配置文件没有配置插件，则返回
  if (configured.length === 0) {
    return { config: params.config, changes: [] };
  }

  // next的内容是什么？
  // OpenClawConfig
  let next = params.config;
  const changes: string[] = [];

  if (next.plugins?.enabled === false) {
    return { config: next, changes };
  }

  for (const entry of configured) {
    const builtInChannelId = normalizeChatChannelId(entry.pluginId);
    // 这行代码做了什么？
    // 检查插件是否被拒绝
    if (isPluginDenied(next, entry.pluginId)) {
      continue;
    }
    // 这行代码做了什么？
    // 检查插件是否显式禁用
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    // 这行代码做了什么？
    // 检查插件是否应该被跳过
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured)) {
      continue;
    }
    // 这行代码做了什么？
    // 检查插件是否应该被允许
    const allow = next.plugins?.allow;
    // 这行代码做了什么？
    // 检查插件是否应该被允许
    const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
    const alreadyEnabled =
      builtInChannelId != null
        ? (() => {
            const channels = next.channels as Record<string, unknown> | undefined;
            const channelConfig = channels?.[builtInChannelId];
            if (
              !channelConfig ||
              typeof channelConfig !== "object" ||
              Array.isArray(channelConfig)
            ) {
              return false;
            }
            return (channelConfig as { enabled?: unknown }).enabled === true;
          })()
        : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }
    // 这行代码做了什么？
    // 注册插件
    // next是OpenClawConfig, registerPluginEntry的返回值也是OpenClawConfig, 修改了next的plugins和channels的内容，做了深拷贝,
    // 功能是注册插件，将插件的enabled设置为true
    // 表示插件已经启用 ， 
    next = registerPluginEntry(next, entry.pluginId);
    // 这行代码做了什么？
    // 确保插件被允许
    if (allowMissing || !builtInChannelId) {
      // 这行代码做了什么？
      // 确保插件被允许
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    changes.push(formatAutoEnableChange(entry));
  }

  return { config: next, changes };
}

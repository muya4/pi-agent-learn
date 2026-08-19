/**
 * 网关服务器实现：startGatewayServer 启动完整网关进程。
 * 流程：读配置与迁移、校验、自动启用插件、激活 secrets、加载插件注册表、启动 HTTP/WS、
 * 发现、维护定时器、Tailscale、sidecars（canvas、plugin services）、配置热重载等。
 * 会设置 process.env.OPENCLAW_GATEWAY_PORT 供 canvas/浏览器等使用。
 */
import path from "node:path"; // 路径拼接（配置、静态资源、workspace 等）

// --- Agent 运行时：多 agent 作用域、Pi 嵌入执行、skills、子 agent ---
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js"; // agentId → workspace 目录、默认 agent
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js"; // 当前活跃 Pi 会话数（重启/关闭前等待）
import { registerSkillsChangeListener } from "../agents/skills/refresh.js"; // skills 变更时刷新远程/本地 skill 缓存
import { initSubagentRegistry } from "../agents/subagent-registry.js"; // 子 agent 注册表初始化

// --- 自动回复：入站消息派发与 pending 计数 ---
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js"; // 待发送回复数（graceful shutdown 用）

// --- Canvas：A2UI 可视化工作区宿主 ---
import type { CanvasHostServer } from "../canvas-host/server.js"; // Canvas HTTP 服务类型

// --- 消息通道：Telegram/Discord/Slack 等插件 ---
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js"; // 通道 ID 类型、已加载 channel 插件列表

// --- CLI 辅助：命令格式化、默认依赖注入 ---
import { formatCliCommand } from "../cli/command-format.js"; // 日志/错误里展示可复制的 CLI 示例
import { createDefaultDeps } from "../cli/deps.js"; // Gateway 内复用 CLI 同款 deps（发消息、读配置等）

// --- 配置：读写 openclaw.json、迁移、会话键、插件自动启用 ---
import { isRestartEnabled } from "../config/commands.js"; // 是否允许 SIGUSR1/重启类命令
import {
  CONFIG_PATH,
  type OpenClawConfig,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js"; // 主配置路径、类型、Nix 模式、加载/迁移/快照/写回
import { formatConfigIssueLines } from "../config/issue-format.js"; // 配置校验错误格式化输出
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js"; // 按配置自动启用 extensions
import { resolveMainSessionKey } from "../config/sessions.js"; // 解析 main 会话 sessionKey

// --- 基础设施：事件、心跳、重启、远程 skills、系统事件 ---
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js"; // agent 运行事件订阅与上下文清理
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js"; // Control UI 静态资源路径与构建检测
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js"; // 是否开启诊断事件
import { logAcceptedEnvOption } from "../infra/env.js"; // 启动时记录已接受的环境变量开关
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js"; // shell 执行审批请求转发到客户端
import { onHeartbeatEvent } from "../infra/heartbeat-events.js"; // 心跳事件订阅
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js"; // 定时 heartbeat 任务 runner
import { getMachineDisplayName } from "../infra/machine-name.js"; // 本机展示名（presence/发现）
import { ensureOpenClawCliOnPath } from "../infra/path-env.js"; // 把 openclaw 可执行目录补进 PATH
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js"; // 网关重启策略与 defer 检查（有活跃 run 时延迟）
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js"; // 移动端/远程 node 的 skills 与 bin 同步
import { enqueueSystemEvent } from "../infra/system-events.js"; // 向会话 enqueue 系统事件（启动/关闭等）
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js"; // 启动后检查 npm 更新并广播

// --- 日志 ---
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js"; // 诊断日志周期心跳
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js"; // 分 subsystem 的结构化日志

// --- 插件：注册表、运行时、全局 hook、sidecar 服务 ---
import { getGlobalHookRunner, runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js"; // 插件 lifecycle hook 与 gateway_stop
import { createEmptyPluginRegistry } from "../plugins/registry.js"; // 空插件注册表（随后 load extensions 填充）
import { createPluginRuntime } from "../plugins/runtime/index.js"; // 插件运行时上下文（tools/channels/hooks）
import type { PluginServicesHandle } from "../plugins/services.js"; // 插件后台服务句柄类型

// --- 进程队列、运行时类型 ---
import { getTotalQueueSize } from "../process/command-queue.js"; // 全局命令队列深度（关闭前 drain）
import type { RuntimeEnv } from "../runtime.js"; // 抽象 runtime（log/exit/spawn）

// --- Secrets：运行时快照、auth 面诊断 ---
import type { CommandSecretAssignment } from "../secrets/command-config.js"; // 命令级 secret 引用类型
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js"; // gateway 认证面路径与状态评估
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  resolveCommandSecretsFromActiveRuntimeSnapshot,
} from "../secrets/runtime.js"; // secrets 快照准备/激活/清理/命令解析

// --- 向导 ---
import { runOnboardingWizard } from "../wizard/onboarding.js"; // WS wizard.* 方法背后的 onboard 流程

// --- Gateway 本地模块：认证、通道健康、配置热重载、事件 ---
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js"; // WS/HTTP 认证暴力破解限流
import { startChannelHealthMonitor } from "./channel-health-monitor.js"; // 周期性探测各 channel 健康
import { startGatewayConfigReloader } from "./config-reload.js"; // 配置文件变更热重载
import type { ControlUiRootState } from "./control-ui.js"; // Control UI 静态根目录状态
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js"; // 可推送的 gateway 事件名与 update 载荷类型
import { ExecApprovalManager } from "./exec-approval-manager.js"; // 执行审批 pending 状态机
import { NodeRegistry } from "./node-registry.js"; // 已连接 node 客户端注册（invoke/event）
import type { startBrowserControlServerIfEnabled } from "./server-browser.js"; // Playwright 浏览器控制 sidecar 类型
import { createChannelManager } from "./server-channels.js"; // 启动/停止各 messaging channel
import { createAgentEventHandler } from "./server-chat.js"; // agent/chat 流式事件 → WS 广播
import { createGatewayCloseHandler } from "./server-close.js"; // 优雅关闭（drain runs、停 channel）
import { buildGatewayCronService } from "./server-cron.js"; // 内置 cron 调度服务
import { startGatewayDiscovery } from "./server-discovery-runtime.js"; // mDNS/Bonjour 局域网发现
import { applyGatewayLaneConcurrency } from "./server-lanes.js"; // agent/session 并发 lane 限制
import { startGatewayMaintenanceTimers } from "./server-maintenance.js"; // 媒体清理、dedupe 等维护定时器
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js"; // WS 方法名/事件名清单（hello-ok）
import { coreGatewayHandlers } from "./server-methods.js"; // 汇总 core RPC handler + 鉴权分发
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js"; // exec.approval.* RPC
import { safeParseJson } from "./server-methods/nodes.helpers.js"; // node 相关 JSON 安全解析
import { createSecretsHandlers } from "./server-methods/secrets.js"; // secrets.reload/resolve RPC
import { hasConnectedMobileNode } from "./server-mobile-nodes.js"; // 是否有 iOS/Android node 在线
import { loadGatewayModelCatalog } from "./server-model-catalog.js"; // 启动时加载可用模型目录
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js"; // node 事件订阅路由
import { loadGatewayPlugins, setFallbackGatewayContext } from "./server-plugins.js"; // 加载 extensions 并合并 gateway handlers
import { createGatewayReloadHandlers } from "./server-reload-handlers.js"; // 配置重载时的增量 apply
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js"; // 端口/bind/auth/controlUi 等运行时解析
import { createGatewayRuntimeState } from "./server-runtime-state.js"; // 创建 HTTP/WS 服务器与运行时 Map
import { resolveSessionKeyForRun } from "./server-session-key.js"; // agent run → sessionKey
import { logGatewayStartup } from "./server-startup-log.js"; // 启动完成摘要日志
import { startGatewaySidecars } from "./server-startup.js"; // canvas/browser/plugin services 等 sidecar
import { startGatewayTailscaleExposure } from "./server-tailscale.js"; // Tailscale Serve/Funnel 暴露
import { createWizardSessionTracker } from "./server-wizard-sessions.js"; // 进行中的 onboard wizard 会话
import { attachGatewayWsHandlers } from "./server-ws-runtime.js"; // 挂载 WebSocket 连接与 message-handler

// --- Gateway server 子目录：健康快照、就绪探针、TLS ---
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js"; // health/presence 缓存与版本号（广播 stateVersion）
import { createReadinessChecker } from "./server/readiness.js"; // /ready 探针（channels/plugins 就绪）
import { loadGatewayTlsRuntime } from "./server/tls.js"; // 可选 mTLS/TLS 证书加载

// --- 启动期认证与 Control UI 安全 ---
import {
  ensureGatewayStartupAuth,
  mergeGatewayAuthConfig,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js"; // 启动时生成/合并 token、Tailscale 认证配置
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js"; // 首次启动写入 Control UI allowedOrigins

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

// 认证限流配置类型
type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

function logGatewayAuthSurfaceDiagnostics(prepared: {
  sourceConfig: OpenClawConfig;
  warnings: Array<{ code: string; path: string; message: string }>;
}): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: Pick<GatewayServerOptions, "auth" | "tailscale">,
): OpenClawConfig {
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the onboarding wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

/**
 * 启动网关：绑定端口、加载配置与插件、启动 HTTP/WS、发现、维护、Tailscale、sidecars、配置重载。
 * 返回 GatewayServer（含 close、broadcast 等）；调用方负责在进程退出时 close()。
 */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // ----------------- 阶段 0：测试模式与环境初始化 ------------
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  /** 让浏览器/canvas 等子模块能拿到当前网关端口 */
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });

  // ----------------- 阶段 1：读取配置、迁移旧格式、校验 ------------
  // configSnapshot: ConfigFileSnapshot
  // {
  //   path: string;
  //   exists: boolean;
  //   raw: string | null;
  //   parsed: unknown;
  //   resolved: OpenClawConfig;
  //   valid: boolean;
  //   config: OpenClawConfig;
  // }
  // ----------------------------------------- 读取配置文件 -----------------------------------
  let configSnapshot = await readConfigFileSnapshot();
  // ----------------------------------------- 检测遗留配置项 -----------------------------------
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      log.warn(
        "gateway: legacy config entries detected but no auto-migration changes were produced; continuing with validation.",
      );
    } else {
      await writeConfigFile(migrated);
      if (changes.length > 0) {
        log.info(
          `gateway: migrated legacy config entries:\n${changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
    }
  }
  // 为什么这里使用了两次 readConfigFileSnapshot？
  // 第一次是读取配置文件，第二次是读取配置文件并验证
  configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.exists && !configSnapshot.valid) {
    const issues =
      configSnapshot.issues.length > 0
        ? formatConfigIssueLines(configSnapshot.issues, "", { normalizeRoot: true }).join("\n")
        : "Unknown validation issue.";
    throw new Error(
      `Invalid config at ${configSnapshot.path}.\n${issues}\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`,
    );
  }

  // ----------------- 阶段 2：按配置自动启用 plugins 并写回 ------------
  const autoEnable = applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length > 0) {
    try {
      await writeConfigFile(autoEnable.config);
      log.info(
        `gateway: auto-enabled plugins:\n${autoEnable.changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    } catch (err) {
      log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    }
  }

  // ----------------- 阶段 3：定义 secrets 激活闭包（供启动/热重载复用）------------
  // secrets 激活闭包是什么?
  // 是一个闭包，用于管理 secrets 的激活状态,.
  // secrets 是什么？
  // 是配置文件中的 secrets 配置，包含 secretRefs 和 secretDefaults 配置。它的作用是什么？
  // 它的作用是管理 secrets 的激活状态，当 secrets 激活时，会触发 secrets 激活闭包，当 secrets 激活失败时，会触发 secrets 激活闭包。
  let secretsDegraded = false;
  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      // sessionKey的数据是什么，举个例子
      // 'agent:123:main' 类型是 string
      sessionKey: resolveMainSessionKey(cfg),
      // code的内容是什么？
      // 'SECRETS_RELOADER_DEGRADED' 类型是 string
      // 'SECRETS_RELOADER_RECOVERED' 类型是 string
      contextKey: code,
    });
  };
  // secretsActivationTail的内容是什么？
  // Promise<void>
  // Promise.resolve()的作用是什么？
  // 创建一个已解决的Promise对象，返回一个Promise对象，状态为fulfilled，值为undefined
  let secretsActivationTail: Promise<void> = Promise.resolve();
  // 这个是什么语法
  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };
  
  //
  const activateRuntimeSecrets = async (
    config: OpenClawConfig,
    params: { reason: "startup" | "reload" | "restart-check"; activate: boolean },
  ) =>
    await runWithSecretsActivationLock(async () => {
      try {
        const prepared = await prepareSecretsRuntimeSnapshot({ config });
        if (params.activate) {
          activateSecretsRuntimeSnapshot(prepared);
          logGatewayAuthSurfaceDiagnostics(prepared);
        }
        for (const warning of prepared.warnings) {
          logSecrets.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          emitSecretsStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          logSecrets.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (params.reason !== "startup") {
            emitSecretsStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (params.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });

  // ----------------- 阶段 4：启动前 preflight（校验 config + secrets 预检查）------------
  let cfgAtStart: OpenClawConfig;
  {
    const freshSnapshot = await readConfigFileSnapshot();
    if (!freshSnapshot.valid) {
      const issues =
        freshSnapshot.issues.length > 0
          ? formatConfigIssueLines(freshSnapshot.issues, "", { normalizeRoot: true }).join("\n")
          : "Unknown validation issue.";
      throw new Error(`Invalid config at ${freshSnapshot.path}.\n${issues}`);
    }
    const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(
      freshSnapshot.config,
      {
        auth: opts.auth,
        tailscale: opts.tailscale,
      },
    );
    await activateRuntimeSecrets(startupPreflightConfig, {
      reason: "startup",
      activate: false,
    });
  }

  // ----------------- 阶段 5：生成/合并 auth token，激活 secrets ------------
  cfgAtStart = loadConfig();
  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: cfgAtStart,
    env: process.env,
    authOverride: opts.auth,
    tailscaleOverride: opts.tailscale,
    persist: true,
  });
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  cfgAtStart = (
    await activateRuntimeSecrets(cfgAtStart, {
      reason: "startup",
      activate: true,
    })
  ).config;

  // ----------------- 阶段 6：诊断、重启策略、Control UI origins 种子 ------------
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  cfgAtStart = await maybeSeedControlUiAllowedOriginsAtStartup({
    config: cfgAtStart,
    writeConfig: writeConfigFile,
    LOg,
  });

  // ----------------- 阶段 7：加载 extensions，合并 WS RPC 方法列表 ------------
  initSubagentRegistry();
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  const { pluginRegistry, gatewayMethods: baseGatewayMethods } = minimalTestGateway
    ? { pluginRegistry: emptyPluginRegistry, gatewayMethods: baseMethods }
    : loadGatewayPlugins({
        cfg: cfgAtStart,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayHandlers,
        baseMethods,
      });
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  let pluginServices: PluginServicesHandle | null = null;

  // ----------------- 阶段 8：解析运行时配置（bind/auth/tailscale/hooks/canvas）------------
  const runtimeConfig = await resolveGatewayRuntimeConfig({
    cfg: cfgAtStart,
    port,
    bind: opts.bind,
    host: opts.host,
    controlUiEnabled: opts.controlUiEnabled,
    openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
    openResponsesEnabled: opts.openResponsesEnabled,
    auth: opts.auth,
    tailscale: opts.tailscale,
  });
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  let hooksConfig = runtimeConfig.hooksConfig;
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // ----------------- 阶段 9：认证限流、Control UI 静态资源、向导会话 ------------
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  let controlUiRootState: ControlUiRootState | undefined;
  if (controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
    const resolvedOverridePath = path.resolve(controlUiRootOverride);
    controlUiRootState = resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
    if (!resolvedOverride) {
      log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
  } else if (controlUiEnabled) {
    let resolvedRoot = resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    if (!resolvedRoot) {
      const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
      if (!ensureResult.ok && ensureResult.message) {
        log.warn(`gateway: ${ensureResult.message}`);
      }
      resolvedRoot = resolveControlUiRootSync({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
    }
    controlUiRootState = resolvedRoot
      ? {
          kind: isPackageProvenControlUiRootSync(resolvedRoot, {
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          })
            ? "bundled"
            : "resolved",
          path: resolvedRoot,
        }
      : { kind: "missing" };
  }

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  // ----------------- 阶段 10：TLS、channel 管理器、就绪探针 ------------
  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime: createPluginRuntime().channel,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
  });

  // ----------------- 阶段 11：创建 HTTP/WS 运行时（核心网络栈）------------
  const {
    // 一共有 几个返回值？14个  
    canvasHost, //canvasHost 是 canvas host 的运行时对象。它的类型是 CanvasHostServer。它的作用是Canvas主机。
    httpServer, //httpServer 是 http server 的运行时对象。它的类型是 HttpServer。它的作用是HTTP服务器。
    httpServers, //httpServers 是 http servers 的运行时对象。它的类型是 HttpServer[]。它的作用是存储当前的http服务器。
    httpBindHosts, //httpBindHosts 是 http bind hosts 的运行时对象。它的类型是 string[]。它的作用是存储当前的http绑定主机。
    wss, // wss 是 wss 的运行时对象。它的类型是 WssServer。它的作用是WebSocket服务器。
    clients, // clients 是 clients 的运行时对象。它的类型是 GatewayClient[]。
    broadcast, // broadcast 是 broadcast 的运行时对象。它的类型是 Broadcast。它的作用是广播事件。
    broadcastToConnIds, // broadcastToConnIds 是 broadcastToConnIds 的运行时对象。它的类型是 BroadcastToConnIds。它的作用是广播事件到指定的连接ID。
    agentRunSeq,  // agentRunSeq 是 agentRunSeq 的运行时对象。它的类型是 AgentRunSeq。它的作用是存储当前的agent运行序列。
    dedupe, // dedupe 是 dedupe 的运行时对象。它的类型是 Dedupe。它的作用是去重。
    chatRunState, // chatRunState 是 chatRunState 的运行时对象。它的类型是 ChatRunState。它的作用是存储当前的聊天状态。
    chatRunBuffers, // chatRunBuffers 是 chatRunBuffers 的运行时对象。它的类型是 ChatRunBuffer[]。它的作用是存储当前的聊天缓冲区。
    chatDeltaSentAt, // chatDeltaSentAt 是 chatDeltaSentAt 的运行时对象。它的类型是 number。它的作用是存储当前的聊天delta发送时间。
    addChatRun, // addChatRun 是 addChatRun 的运行时对象。它的类型是 AddChatRun。它的作用是添加一个聊天运行。
    removeChatRun, // removeChatRun 是 removeChatRun 的运行时对象。它的类型是 RemoveChatRun。它的作用是删除一个聊天运行。
    chatAbortControllers, // chatAbortControllers 是 chatAbortControllers 的运行时对象。它的类型是 ChatAbortController[]。它的作用是存储当前的聊天abort控制器。
    toolEventRecipients, // toolEventRecipients 是 toolEventRecipients 的运行时对象。它的类型是 ToolEventRecipients。它的作用是存储当前的工具事件接收者。
  } = await createGatewayRuntimeState({
    cfg: cfgAtStart,
    bindHost,
    port,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot: controlUiRootState,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    gatewayTls,
    hooksConfig: () => hooksConfig,
    pluginRegistry,
    deps,
    canvasRuntime,
    canvasHostEnabled,
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    logCanvas,
    log,
    logHooks,
    logPlugins,
    getReadiness,
  });

  // ----------------- 阶段 12：Node 注册表/订阅、cron、并发 lane ------------
  let bonjourStop: (() => Promise<void>) | null = null;
  // 这个nodeRegistry一个类，维护了哪些函数？
  // 1. registerNode 注册一个node
  // 2. unregisterNode 注销一个node
  // 3. sendEvent 发送一个事件到node
  // 4. getNode 获取一个node
  // 5. getNodes 获取所有node
  // 6. getNodeCount 获取node数量
  // node 是什么？
  // node是OpenClaw的客户端，它是一个对象，包含了客户端的ID、名称、IP地址、端口、版本等信息, 举个实例？

  const nodeRegistry = new NodeRegistry();
  // nodePresenceTimers 是一个Map，维护了哪些函数？
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();

  // nodeSubscriptions 是一个对象，维护了哪些函数？
  // 1. subscribe 订阅一个node node的内容是sessionKey，举个例子：nodeId: "123", sessionKey: "456"
  // 2. unsubscribe 取消订阅一个node
  // 3. unsubscribeAll 取消订阅所有node
  // 4. sendToSession 发送一个事件到指定的session
  // 5. sendToAllSubscribed 发送一个事件到所有订阅的node
  // 6. sendToAllSubscribed 发送一个事件到所有订阅的node
  // 7. sendToAllSubscribed 发送一个事件到所有订阅的node
  // 8. sendToAllSubscribed 发送一个事件到所有订阅的node
  const nodeSubscriptions = createNodeSubscriptionManager();

  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const nodeSubscribe = nodeSubscriptions.subscribe;
  const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
  const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
  applyGatewayLaneConcurrency(cfgAtStart);

  let cronState = buildGatewayCronService({
    cfg: cfgAtStart,
    deps,
    broadcast,
  });
  let { cron, storePath: cronStorePath } = cronState;

  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;

  // ----------------- 阶段 13：局域网发现（mDNS/Bonjour）------------
  if (!minimalTestGateway) {
    const machineDisplayName = await getMachineDisplayName();
    const discovery = await startGatewayDiscovery({
      machineDisplayName,
      port,
      gatewayTls: gatewayTls.enabled
        ? { enabled: true, fingerprintSha256: gatewayTls.fingerprintSha256 }
        : undefined,
      wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
      wideAreaDiscoveryDomain: cfgAtStart.discovery?.wideArea?.domain,
      tailscaleMode,
      mdnsMode: cfgAtStart.discovery?.mdns?.mode,
      logDiscovery,
    });
    bonjourStop = discovery.bonjourStop;
  }

  // ----------------- 阶段 14：远程 node skills 缓存与变更监听 ------------
  if (!minimalTestGateway) {
    setSkillsRemoteRegistry(nodeRegistry);
    void primeRemoteSkillsCache();
  }
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
        if (event.reason === "remote-node") {
          return;
        }
        if (skillsRefreshTimer) {
          clearTimeout(skillsRefreshTimer);
        }
        skillsRefreshTimer = setTimeout(() => {
          skillsRefreshTimer = null;
          const latest = loadConfig();
          void refreshRemoteBinsForConnectedNodes(latest);
        }, skillsRefreshDelayMs);
      });

  // ----------------- 阶段 15：维护定时器（health tick、dedupe、媒体清理）------------
  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  let mediaCleanup: ReturnType<typeof setInterval> | null = null;
  if (!minimalTestGateway) {
    ({ tickInterval, healthInterval, dedupeCleanup, mediaCleanup } = startGatewayMaintenanceTimers({
      broadcast,
      nodeSendToAllSubscribed,
      getPresenceVersion,
      getHealthVersion,
      refreshGatewayHealthSnapshot,
      logHealth,
      dedupe,
      chatAbortControllers,
      chatRunState,
      chatRunBuffers,
      chatDeltaSentAt,
      removeChatRun,
      agentRunSeq,
      nodeSendToSession,
      ...(typeof cfgAtStart.media?.ttlHours === "number"
        ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
        : {}),
    }));
  }

  // ----------------- 阶段 16：Agent / Heartbeat 事件 → WS 广播 ------------
  const agentUnsub = minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          broadcast,
          broadcastToConnIds,
          nodeSendToSession,
          agentRunSeq,
          chatRunState,
          resolveSessionKeyForRun,
          clearAgentRunContext,
          toolEventRecipients,
        }),
      );

  const heartbeatUnsub = minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  let heartbeatRunner: HeartbeatRunner = minimalTestGateway
    ? {
        stop: () => {},
        updateConfig: () => {},
      }
    : startHeartbeatRunner({ cfg: cfgAtStart });

  // ----------------- 阶段 17：Channel 健康监控、cron 启动、出站投递恢复 ------------
  const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
  const healthCheckDisabled = healthCheckMinutes === 0;
  let channelHealthMonitor = healthCheckDisabled
    ? null
    : startChannelHealthMonitor({
        channelManager,
        checkIntervalMs: (healthCheckMinutes ?? 5) * 60_000,
      });

  if (!minimalTestGateway) {
    void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));
  }

  if (!minimalTestGateway) {
    void (async () => {
      const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
      const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
      const logRecovery = log.child("delivery-recovery");
      await recoverPendingDeliveries({
        deliver: deliverOutboundPayloads,
        log: logRecovery,
        cfg: cfgAtStart,
      });
    })().catch((err) => log.error(`Delivery recovery failed: ${String(err)}`));
  }

  // ----------------- 阶段 18：Exec 审批与 secrets 相关 RPC handlers ------------
  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  const secretsHandlers = createSecretsHandlers({
    reloadSecrets: async () => {
      const active = getActiveSecretsRuntimeSnapshot();
      if (!active) {
        throw new Error("Secrets runtime snapshot is not active.");
      }
      const prepared = await activateRuntimeSecrets(active.sourceConfig, {
        reason: "reload",
        activate: true,
      });
      return { warningCount: prepared.warnings.length };
    },
    resolveSecrets: async ({ commandName, targetIds }) => {
      const { assignments, diagnostics, inactiveRefPaths } =
        resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName,
          targetIds: new Set(targetIds),
        });
      if (assignments.length === 0) {
        return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
      }
      return { assignments, diagnostics, inactiveRefPaths };
    },
  });

  const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

  // ----------------- 阶段 19：组装 gatewayRequestContext（RPC handler 共享上下文）------------
  const gatewayRequestContext: import("./server-methods/types.js").GatewayRequestContext = {
    deps,
    cron,
    cronStorePath,
    execApprovalManager,
    loadGatewayModelCatalog,
    getHealthCache,
    refreshHealthSnapshot: refreshGatewayHealthSnapshot,
    logHealth,
    logGateway: log,
    incrementPresenceVersion,
    getHealthVersion,
    broadcast,
    broadcastToConnIds,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    hasConnectedMobileNode: hasMobileNodeConnected,
    hasExecApprovalClients: () => {
      for (const gatewayClient of clients) {
        const scopes = Array.isArray(gatewayClient.connect.scopes)
          ? gatewayClient.connect.scopes
          : [];
        if (scopes.includes("operator.admin") || scopes.includes("operator.approvals")) {
          return true;
        }
      }
      return false;
    },
    nodeRegistry,
    agentRunSeq,
    chatAbortControllers,
    chatAbortedRuns: chatRunState.abortedRuns,
    chatRunBuffers: chatRunState.buffers,
    chatDeltaSentAt: chatRunState.deltaSentAt,
    addChatRun,
    removeChatRun,
    registerToolEventRecipient: toolEventRecipients.add,
    dedupe,
    wizardSessions,
    findRunningWizard,
    purgeWizardSession,
    getRuntimeSnapshot,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    wizardRunner,
    broadcastVoiceWakeChanged,
  };

  setFallbackGatewayContext(gatewayRequestContext);

  // ----------------- 阶段 20：挂载 WebSocket（connect + RPC 分发）------------
  attachGatewayWsHandlers({
    wss,
    clients,
    port,
    gatewayHost: bindHost ?? undefined,
    canvasHostEnabled: Boolean(canvasHost),
    canvasHostServerPort,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    browserRateLimiter: browserAuthRateLimiter,
    gatewayMethods,
    events: GATEWAY_EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: {
      ...pluginRegistry.gatewayHandlers,
      ...execApprovalHandlers,
      ...secretsHandlers,
    },
    broadcast,
    context: gatewayRequestContext,
  });

  // ----------------- 阶段 21：启动日志、npm 更新检查、Tailscale 暴露 ------------
  logGatewayStartup({
    cfg: cfgAtStart,
    bindHost,
    bindHosts: httpBindHosts,
    port,
    tlsEnabled: gatewayTls.enabled,
    log,
    isNixMode,
  });
  const stopGatewayUpdateCheck = minimalTestGateway
    ? () => {}
    : scheduleGatewayUpdateCheck({
        cfg: cfgAtStart,
        log,
        isNixMode,
        onUpdateAvailableChange: (updateAvailable) => {
          const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
          broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
        },
      });
  const tailscaleCleanup = minimalTestGateway
    ? null
    : await startGatewayTailscaleExposure({
        tailscaleMode,
        resetOnExit: tailscaleConfig.resetOnExit,
        port,
        controlUiBasePath,
        logTailscale,
      });

  // ----------------- 阶段 22：Sidecars（browser、plugin services、启动 channels）------------
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  if (!minimalTestGateway) {
    ({ browserControl, pluginServices } = await startGatewaySidecars({
      cfg: cfgAtStart,
      pluginRegistry,
      defaultWorkspaceDir,
      deps,
      startChannels,
      log,
      logHooks,
      logChannels,
      logBrowser,
    }));
  }

  // ----------------- 阶段 23：gateway_start 插件 hook ------------
  if (!minimalTestGateway) {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("gateway_start")) {
      void hookRunner.runGatewayStart({ port }, { port }).catch((err) => {
        log.warn(`gateway_start hook failed: ${String(err)}`);
      });
    }
  }

  // ----------------- 阶段 24：配置文件热重载 watcher ------------
  const configReloader = minimalTestGateway
    ? { stop: async () => {} }
    : (() => {
        const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
          deps,
          broadcast,
          getState: () => ({
            hooksConfig,
            heartbeatRunner,
            cronState,
            browserControl,
            channelHealthMonitor,
          }),
          setState: (nextState) => {
            hooksConfig = nextState.hooksConfig;
            heartbeatRunner = nextState.heartbeatRunner;
            cronState = nextState.cronState;
            cron = cronState.cron;
            cronStorePath = cronState.storePath;
            browserControl = nextState.browserControl;
            channelHealthMonitor = nextState.channelHealthMonitor;
          },
          startChannel,
          stopChannel,
          logHooks,
          logBrowser,
          logChannels,
          logCron,
          logReload,
          createHealthMonitor: (checkIntervalMs: number) =>
            startChannelHealthMonitor({ channelManager, checkIntervalMs }),
        });

        return startGatewayConfigReloader({
          initialConfig: cfgAtStart,
          readSnapshot: readConfigFileSnapshot,
          onHotReload: async (plan, nextConfig) => {
            const previousSnapshot = getActiveSecretsRuntimeSnapshot();
            const prepared = await activateRuntimeSecrets(nextConfig, {
              reason: "reload",
              activate: true,
            });
            try {
              await applyHotReload(plan, prepared.config);
            } catch (err) {
              if (previousSnapshot) {
                activateSecretsRuntimeSnapshot(previousSnapshot);
              } else {
                clearSecretsRuntimeSnapshot();
              }
              throw err;
            }
          },
          onRestart: async (plan, nextConfig) => {
            await activateRuntimeSecrets(nextConfig, { reason: "restart-check", activate: false });
            requestGatewayRestart(plan, nextConfig);
          },
          log: {
            info: (msg) => logReload.info(msg),
            warn: (msg) => logReload.warn(msg),
            error: (msg) => logReload.error(msg),
          },
          watchPath: CONFIG_PATH,
        });
      })();

  // ----------------- 阶段 25：注册 close 处理器，返回 GatewayServer ------------
  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
    updateCheckStop: stopGatewayUpdateCheck,
    nodePresenceTimers,
    broadcast,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    mediaCleanup,
    agentUnsub,
    heartbeatUnsub,
    chatRunState,
    clients,
    configReloader,
    browserControl,
    wss,
    httpServer,
    httpServers,
  });

  return {
    close: async (opts) => {
      await runGlobalGatewayStopSafely({
        event: { reason: opts?.reason ?? "gateway stopping" },
        ctx: { port },
        onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
      });
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      authRateLimiter?.dispose();
      browserAuthRateLimiter.dispose();
      channelHealthMonitor?.stop();
      clearSecretsRuntimeSnapshot();
      await close(opts);
    },
  };
}

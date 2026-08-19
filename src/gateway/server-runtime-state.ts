import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import {
  createGatewayBroadcaster,
  type GatewayBroadcastFn,
  type GatewayBroadcastToConnIdsFn,
} from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
  type PluginRoutePathContext,
} from "./server/plugins-http.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean; // 控制UI是否启用。
  controlUiBasePath: string; // 控制UI基础路径。
  controlUiRoot?: ControlUiRootState; // 控制UI根状态。
  openAiChatCompletionsEnabled: boolean; // OpenAI聊天完成是否启用。
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean; // OpenAI响应是否启用。
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string; // 严格传输安全头。
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter; // 认证速率限制器。
  gatewayTls?: GatewayTlsRuntime; // 网关TLS运行时。
  hooksConfig: () => HooksConfigResolved | null; // 钩子配置。
  pluginRegistry: PluginRegistry; // 插件注册表。
  deps: CliDeps; // 依赖。
  canvasRuntime: RuntimeEnv; // 画布运行时。
  canvasHostEnabled: boolean; // 画布主机是否启用。
  allowCanvasHostInTests?: boolean; // 允许画布主机在测试中启用。
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>; // 钩子日志。
  logPlugins: ReturnType<typeof createSubsystemLogger>; // 插件日志。
  getReadiness?: ReadinessChecker; // 获取就绪状态。
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn; // 广播到连接ID。
  agentRunSeq: Map<string, number>; // 代理运行序列。
  dedupe: Map<string, DedupeEntry>; // 去重。
  chatRunState: ReturnType<typeof createChatRunState>; // 聊天运行状态。
  chatRunBuffers: Map<string, string>; // 聊天运行缓冲区。
  chatDeltaSentAt: Map<string, number>; // 聊天delta发送时间。
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  // canvasHost 是 canvas host 的运行时对象。它的类型是 CanvasHostHandler 
  // CanvasHostHandler 功能上实现了什么效果？它是一个函数，接受一个 params 参数，返回一个 Promise<CanvasHostHandler> 对象。
  // 它的作用是创建一个 canvas host 的运行时对象。
  // 它的参数是：
  // runtime: RuntimeEnv; // 画布运行时。
  // rootDir: string; // 画布根目录。
  // basePath: string; // 画布基础路径。
  // allowInTests: boolean; // 允许画布在测试中启用。
  // liveReload: boolean; // 允许画布在测试中启用。
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  // clients 是客户端集合。它的类型是 Set<GatewayWsClient>。它的作用是存储当前的客户端。
  const clients = new Set<GatewayWsClient>();
  // broadcast 是广播函数。它的类型是 GatewayBroadcastFn。它的作用是广播事件。也就是把事件通过wss 发到客户端 
  // 发送的内容举个例子？ 就是通过wss 发到客户端 ,字段有哪些？ 比如 event: string, payload: unknown, opts?: GatewayBroadcastOpts,
  // 比如我发送一个事件叫 "agent"，内容是 { "id": "123", "name": "John" }
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

  // createGatewayHooksRequestHandler 是创建钩子请求处理函数。它的类型是 createGatewayHooksRequestHandler。它的作用是创建一个钩子请求处理函数。
  // 它的参数是：
  // deps: CliDeps; // 依赖。
  // getHooksConfig: () => HooksConfigResolved | null; // 获取钩子配置。
  // bindHost: string; // 绑定主机。
  // port: number; // 端口。
  // logHooks: ReturnType<typeof createSubsystemLogger>; // 钩子日志。
  
  //一句话：createGatewayHooksRequestHandler 是为了让 Gateway 
  // 接收外部 HTTP Webhook；Hook 用来 
  // 从邮发件、CI、监控等系统触「唤醒」或「跑一轮 Agent」，
  // 是 Channel 聊天之外的自动化入口
  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });


  // 一句话：createGatewayPluginRequestHandler 是为了让 Gateway
  //  接收外部 HTTP 插件请求；
  // Plugin 用来 扩展 Gateway 功能，比如: 
  // - 自定义 AI 模型

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
    return shouldEnforceGatewayAuthForPluginPath(params.pluginRegistry, pathContext);
  };

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  if (!isLoopbackHost(params.bindHost)) {
    params.log.warn(
      "⚠️  Gateway is binding to a non-loopback address. " +
        "Ensure authentication is configured before exposing to public networks.",
    );
  }
  if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    params.log.warn(
      "⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. " +
        "Host-header origin fallback weakens origin checks and should only be used as break-glass.",
    );
  }
  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  /// 循环遍历 bindHosts 数组，创建 HTTP 服务器
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      clients,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      controlUiRoot: params.controlUiRoot,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      strictTransportSecurityHeader: params.strictTransportSecurityHeader,
      handleHooksRequest,
      handlePluginRequest,
      shouldEnforcePluginGatewayAuth,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
      getReadiness: params.getReadiness,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }


  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  // 循环遍历 httpServers 数组, 升级处理？
  for (const server of httpServers) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      clients,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
    });
  }

  // agentRunSeq 举个例子？
  // 比如我有一个 agentRunSeq 的 map，key 是 agentRunId，value 是 agentRunSeq
  const agentRunSeq = new Map<string, number>();
  // dedupe 举个例子？
  // dedupeEntry 的类型是 DedupeEntry，它的字段有哪些？
  // - id: string; // 去重ID。
  // - createdAt: number; // 创建时间。
  // - updatedAt: number; // 更新时间。
  // - data: unknown; // 数据。
  // - expiresAt: number; // 过期时间。
  // - maxAge: number; // 最大年龄。
  // - maxCount: number; // 最大数量。
  const dedupe = new Map<string, DedupeEntry>();
  // chatRunState 举个例子？
  // - registry: ChatRunRegistry; // 聊天运行注册表。
  const chatRunState = createChatRunState();
  // chatRunRegistry 的类型是 ChatRunRegistry，它的字段有哪些？
  // - add: (sessionId: string, entry: ChatRunEntry) => void; // 添加聊天运行。
  // - remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined; // 删除聊天运行。
  const chatRunRegistry = chatRunState.registry;
  // chatRunBuffers 举个例子？
  // chatRunBuffers 的类型是 Map<string, string>，它的字段有哪些？
  // - key: string; // 聊天运行ID。
  // - value: string; // 聊天运行缓冲区。
  const chatRunBuffers = chatRunState.buffers;
  // chatDeltaSentAt 举个例子？
  // chatDeltaSentAt 的类型是 Map<string, number>，它的字段有哪些？
  // - key: string; // 聊天运行ID。
  // - value: number; // 聊天delta发送时间。
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  // addChatRun 举个例子？
  // addChatRun 的类型是 (sessionId: string, entry: ChatRunEntry) => void，它的字段有哪些？
  // - sessionId: string; // 会话ID。
  const addChatRun = chatRunRegistry.add;
  // removeChatRun 举个例子？
  // removeChatRun 的类型是 (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined，它的字段有哪些？
  // - sessionId: string; // 会话ID。
  // - clientRunId: string; // 客户端运行ID。
  // - sessionKey?: string; // 会话密钥。
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  // toolEventRecipients 举个例子？
  // toolEventRecipients 的类型是 ToolEventRecipientRegistry，它的字段有哪些？
  // - add: (sessionId: string, entry: ToolEventRecipientEntry) => void; // 添加工具事件接收者。
  // - remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ToolEventRecipientEntry | undefined; // 删除工具事件接收者。
  const toolEventRecipients = createToolEventRecipientRegistry();


  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  };
}

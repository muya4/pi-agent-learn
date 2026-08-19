# OpenClaw CLI → Gateway 源码阅读清单

> 基准命令：`openclaw gateway run --port 18789 --bind loopback`  
> 基准 argv：
>
> ```text
> [
>   "C:\\Program Files\\nodejs\\node.exe",          // argv[0]
>   "E:\\openclaw-main\\openclaw-main\\openclaw.mjs", // argv[1]
>   "gateway", "run", "--port", "18789", "--bind", "loopback"  // argv[2..]
> ]
> ```
>
> 配套 Canvas：[openclaw-CLI-call-chain.canvas.tsx](file:///C:/Users/Administrator/.cursor/projects/e-openclaw-main/canvases/openclaw-CLI-call-chain.canvas.tsx)

---

## 怎么用这份清单

1. 按阶段顺序打开文件（勾选 `- [ ]`）。
2. 每个文件先读「关注点」，再对照「关键变量」。
3. 换命令时：先写出完整 `argv`，再重算 `tokens` / `path` / `primary` / `opts`。
4. 建议在 IDE 用「转到行」对照注释（`run-main.ts` 已有逐步数据注释）。

---

## 阶段 0：包装入口

### 0.1 `openclaw.mjs`

- 读完
- 关注点：Node ≥ 22.12；可选 compile cache；`import("./dist/entry.js")`
- 关键变量：`process.argv` 已是完整数组；本文件不含业务逻辑
- 读完标准：知道真正入口是 `dist/entry.js`（源码 `src/entry.ts`）

---

## 阶段 1：`src/entry.ts`（进程级启动）

### 1.1 主模块守卫

- 读完
- 位置：`isMainModule` + `ENTRY_WRAPPER_PAIRS`（约 L21–49）
- 关注点：经 `openclaw.mjs` 启动时 `true`；被 `index.js` import 时 `false`（防双开 gateway）
- 关键变量：`currentFile=.../entry.js`，`argv[1]=.../openclaw.mjs` → wrapper 映射命中

### 1.2 `shouldForceReadOnlyAuthStore`

- 读完
- 位置：约 L27–36，调用约 L62–64
- 关注点：`argv.slice(2).filter(!startsWith("-"))` → `tokens`，扫描相邻 `secrets`+`audit`
- 关键变量（基准）：
  - `tokens = ["gateway","run","18789","loopback"]` → `false`
  - `secrets audit` → `tokens=["secrets","audit"]` → `true` → `OPENCLAW_AUTH_STORE_READONLY="1"`

### 1.3 `ensureExperimentalWarningSuppressed` + respawn

- 读完
- 位置：约 L71–136，调用约 L181
- 关注点：为何 respawn；`--disable-warning` 不能写进 `NODE_OPTIONS`
- 关键变量：
  - 父进程 spawn argv ≈ `["--disable-warning=ExperimentalWarning","openclaw.mjs","gateway","run",...]`
  - `OPENCLAW_NODE_OPTIONS_READY="1"` 防无限 respawn
  - 返回 `true` → 父进程不跑 `runCli`
- 跳过条件：`--help/--version`、`OPENCLAW_NO_RESPAWN`、已 ready、已有 disable-warning

### 1.4 `attachChildProcessBridge`

- 读完
- 文件：`src/process/child-process-bridge.ts`
- 关注点：父进程 SIGINT → `child.kill(SIGINT)`；子进程 exit 后 `detach`
- 关键变量（Windows）：`defaultSignals = ["SIGTERM","SIGINT","SIGBREAK"]`

### 1.5 `parseCliProfileArgs` / `applyCliProfileEnv`

- 读完
- 文件：`src/cli/profile.ts`；调用在 entry 约 L182–192
- 关注点：剥离 `--dev` / `--profile`，改写 `process.argv`
- 关键变量（基准）：`{ ok:true, profile:null, argv: 原样 }`
- 关键变量（`--dev`）：`profile="dev"`，`OPENCLAW_STATE_DIR=~/.openclaw-dev`，`GATEWAY_PORT=19001`

### 1.6 version / help 快路径 → `runCli`

- 读完
- 位置：约 L139–205
- 关注点：`--version` / `--help` 不加载完整 CLI；否则 `import("./cli/run-main.js").then(runCli)`
- 关键变量（基准）：两个快路径均为 `false` → 进入 `runCli(process.argv)`

---

## 阶段 2：`src/cli/run-main.ts`（CLI 调度）

> 本文件函数已带「实际参数」注释，可直接对照。

### 2.1 `rewriteUpdateFlagArgv`

- 读完
- 关注点：`--update` → 子命令 `update`
- 关键变量（基准）：无 `--update` → 原样返回

### 2.2 `shouldEnsureCliPath`

- 读完
- 关注点：哪些命令跳过 PATH 注入
- 关键变量（基准）：`path=["gateway","run"]` → `true` → `ensureOpenClawCliOnPath()`

### 2.3 `shouldSkipPluginCommandRegistration`

- 读完
- 关注点：builtin primary / 无 primary / gateway 三种分支
- 关键变量：预注册后 `hasBuiltinPrimary` 取决于 `program.commands` 是否已有 `"gateway"`

### 2.4 `runCli`（整条主流程）

- 读完（建议逐段对照注释里的 13 步）
- 关键变量摘要：

  | 步骤         | 变量                      | 基准值                           |
  | ---------- | ----------------------- | ----------------------------- |
  | normalize  | `normalizedArgv`        | 与输入相同                         |
  | profile    | `parsedProfile`         | `{ ok:true, profile:null }`   |
  | route      | `tryRouteCli`           | `false`（gateway 通常不走）         |
  | build      | `program`               | Commander 根 + placeholders    |
  | rewrite    | `parseArgv`             | 同 `normalizedArgv`            |
  | primary    | `primary`               | `"gateway"`                   |
  | core 预注册   | `registerCoreCliByName` | `false`                       |
  | subcli 预注册 | `registerSubCliByName`  | `true` → `registerGatewayCli` |
  | parse      | `program.parseAsync`    | 命中 `gateway run` action       |


### 2.5 `isCliMainModule`

- 读完
- 关注点：正常路径是 entry 调 `runCli`，此处通常 `false`

---

## 阶段 3：argv / 路由辅助

### 3.1 `src/cli/argv.ts`

- 读完 `getCommandPathWithRootOptions` / `getPrimaryCommand`
- 关键变量：`depth=1` → `["gateway"]`；`depth=2` → `["gateway","run"]`
- 关注点：跳过 `--port`/`--bind` 等 flag，只收 positional

### 3.2 `src/cli/route.ts`

- 读完 `tryRouteCli`
- 关注点：route-first 快路径；`OPENCLAW_DISABLE_ROUTE_FIRST`；gateway 通常 return false

### 3.3 `src/cli/windows-argv.ts`

- 扫一眼即可
- 关注点：Windows 引号/控制字符拆分；非 win32 原样返回

---

## 阶段 4：Commander 组装

### 4.1 `src/cli/program/build-program.ts`

- 读完
- 关注点：`new Command()` → ctx → help → preAction → `registerProgramCommands`
- 关键变量：`argv = process.argv` 传给注册函数

### 4.2 `src/cli/program/command-registry.ts`

- 读完 `registerProgramCommands` / `registerCoreCliCommands` / `registerCoreCliByName` / `registerLazyCoreCommand`
- 关键变量（基准）：`primary="gateway"` 不在 `coreEntries` → 挂全部 core placeholder；`registerCoreCliByName("gateway")` → `false`
- 关注点：placeholder.action → 真注册 → `reparseProgramFromActionArgs`

### 4.3 `src/cli/program/register.subclis.ts`

- 读完 `registerSubCliCommands` / `registerSubCliByName` / `registerLazyCommand`
- 关键变量（buildProgram 时）：只挂 `gateway` placeholder
- 关键变量（runCli 预注册）：`removeCommandByName` → `entry.register` → `registerGatewayCli`
- 关注点：`entries` 列表里 `gateway` 的 `register` 动态 import `gateway-cli`

### 4.4 `src/cli/program/action-reparse.ts`

- 读完
- 关注点：lazy 命中后二次 `parseAsync`；理解 `fallbackArgv` / `rawArgs`

### 4.5 `src/cli/program/context.ts` + `program-context.ts`

- 扫一眼
- 关注点：`ProgramContext`（version、channelOptions）如何挂到 `program`

---

## 阶段 5：Gateway CLI

### 5.1 `src/cli/gateway-cli/register.ts`

- 读完 `registerGatewayCli`
- 关注点子命令树：

  | 子命令                                           | 去向                               |
  | --------------------------------------------- | -------------------------------- |
  | `run`（及默认）                                    | `runGatewayCommand`              |
  | `status/install/start/stop/restart/uninstall` | `daemon-cli` service             |
  | `health` / `call` / `usage-cost`              | `callGatewayCli` → WS RPC        |
  | `probe`                                       | `gatewayStatusCommand`           |
  | `discover`                                    | Bonjour `discoverGatewayBeacons` |


### 5.2 `src/cli/gateway-cli/run.ts`

- 读完 `resolveGatewayRunOptions` / `runGatewayCommand` / `addGatewayRunCommand`
- 关键变量（Commander opts）：
  ```text
  { port:"18789", bind:"loopback", force:false, verbose:false, wsLog:"auto", ... }
  ```
- 关键变量（解析后）：`port=18789`（number），`bind="loopback"`，`cfg=loadConfig()`
- 关注点：mode 门禁、auth、`runGatewayLoop({ lockPort, start })`

### 5.3 `src/cli/gateway-cli/call.ts`

- 读完 `gatewayCallOpts` / `callGatewayCli`
- 关键变量：`method="health"`，`timeoutMs=10000`，`mode=CLI`，`clientName=CLI`

### 5.4 `src/cli/gateway-cli/run-loop.ts`

- 读完 `runGatewayLoop`
- 关键变量：`lockPort=18789`，`server = await start()`，`while(true)` + `restartResolver`
- 关注点：SIGINT/SIGTERM stop；SIGUSR1 restart；锁释放

### 5.5 `src/cli/daemon-cli/register-service-commands.ts`

- 扫一眼 `addGatewayServiceCommands`
- 关注点：父命令 `--port/--token` 经 `inheritOptionFromParent` 合并

---

## 阶段 6：Gateway 服务端启动

### 6.1 `src/gateway/server.impl.ts` — `startGatewayServer`

- 读完启动前半（配置 / secrets / auth / plugins）
- 读完 `attachGatewayWsHandlers` 调用处（约 L881）
- 关键变量：`port=18789`，`opts={ bind:"loopback" }`，`OPENCLAW_GATEWAY_PORT="18789"`
- 关注点：`listGatewayMethods` → `loadGatewayPlugins` → `resolveGatewayRuntimeConfig` → runtime state

### 6.2 `src/gateway/server-runtime-state.ts`

- 读完 `createGatewayRuntimeState`
- 关键变量：`bindHost="127.0.0.1"`，`wss`，`clients=Set`

### 6.3 `src/gateway/server-methods-list.ts`

- 扫一眼 `BASE_METHODS` / `GATEWAY_EVENTS` / `listGatewayMethods`
- 关注点：RPC 方法名清单与推送事件清单

### 6.4 `src/gateway/server-methods.ts`

- 读完 `coreGatewayHandlers` 合并、`handleGatewayRequest`、`authorizeGatewayMethod`
- 关键变量：`method="health"` → 免 scope；handler = `healthHandlers.health`

### 6.5 `src/gateway/server-methods/health.ts`

- 读完
- 关键变量：`params={}` → `wantsProbe=false` → cache 或 `refreshHealthSnapshot` → `respond(true, snap)`

---

## 阶段 7：WS 连接与 CLI RPC 客户端

### 7.1 `src/gateway/server-ws-runtime.ts`

- 读完 `attachGatewayWsHandlers`（薄包装）

### 7.2 `src/gateway/server/ws-connection.ts`

- 读完 `connection` 回调开头
- 关键变量：`connId=uuid`；首包 `{ event:"connect.challenge", payload:{ nonce, ts } }`

### 7.3 `src/gateway/server/ws-connection/message-handler.ts`

- 读完 connect 握手成功路径
- 读完握手后 `validateRequestFrame` → `handleGatewayRequest`（约 L1134–1202）
- 关键变量：`{ type:"req", id, method:"health", params:{} }`

### 7.4 `src/gateway/call.ts` + `src/gateway/client.ts`

- 读完 `callGateway` / `callGatewayWithScopes` / `GatewayClient.request`
- 关键变量：`url="ws://127.0.0.1:18789"`，connect → helloOk → `request("health",{})` → `res` payload

---

## 对照实验（建议动手）


| #   | 命令                                                  | 重点观察                                        |
| --- | --------------------------------------------------- | ------------------------------------------- |
| 1   | `openclaw gateway run --port 18789 --bind loopback` | entry respawn → runCli → startGatewayServer |
| 2   | `openclaw --version`                                | 快路径；不 respawn；不进 runCli                     |
| 3   | `openclaw --dev gateway run`                        | `profile="dev"`，state dir、默认 port           |
| 4   | `openclaw secrets audit`                            | `tokens` → `OPENCLAW_AUTH_STORE_READONLY`   |
| 5   | 另开终端 `openclaw gateway health --json`               | CLI WS 客户端 → health handler                 |
| 6   | `openclaw gateway call cron.list --params "{}"`     | 通用 RPC method 分发                            |
| 7   | `OPENCLAW_NO_RESPAWN=1 openclaw gateway run ...`    | 跳过 ExperimentalWarning respawn              |


---

## 阅读顺序速查（仅路径）

```text
openclaw.mjs
src/entry.ts
src/process/child-process-bridge.ts
src/cli/profile.ts
src/cli/run-main.ts          ← 已有逐步参数注释
src/cli/argv.ts
src/cli/route.ts
src/cli/program/build-program.ts
src/cli/program/command-registry.ts
src/cli/program/register.subclis.ts
src/cli/program/action-reparse.ts
src/cli/gateway-cli/register.ts
src/cli/gateway-cli/run.ts
src/cli/gateway-cli/run-loop.ts
src/cli/gateway-cli/call.ts
src/gateway/server.impl.ts
src/gateway/server-runtime-state.ts
src/gateway/server-methods-list.ts
src/gateway/server-methods.ts
src/gateway/server-methods/health.ts
src/gateway/server-ws-runtime.ts
src/gateway/server/ws-connection.ts
src/gateway/server/ws-connection/message-handler.ts
src/gateway/call.ts
src/gateway/client.ts
```

---

## 扩展阅读（本清单之后）

- `docs/concepts/architecture.md` — 架构总览
- `docs/concepts/memory.md` — 记忆系统
- `src/gateway/server-methods/agent.ts` / `chat.ts` — Agent / Chat RPC
- `src/memory/` + `extensions/memory-core` — 记忆索引与工具
- Channel 插件（如 Telegram）如何注册 `gatewayMethods`

---

## 进度记录（可选）


| 阶段                | 完成日期 | 备注  |
| ----------------- | ---- | --- |
| 0 包装入口            |      |     |
| 1 entry / respawn |      |     |
| 2 run-main        |      |     |
| 3 argv / route    |      |     |
| 4 Commander       |      |     |
| 5 Gateway CLI     |      |     |
| 6 server.impl     |      |     |
| 7 WS / RPC        |      |     |
| 对照实验 1–7          |      |     |



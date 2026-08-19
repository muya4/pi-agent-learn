import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { getCommandPathWithRootOptions, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

/**
 * 把 argv 里的 `--update` 旗标改写成子命令名 `update`，方便 Commander 识别。
 *
 * 例 1（无 --update，原样返回）：
 *   输入 argv = ["node.exe","openclaw.mjs","gateway","run","--port","18789"]
 *   indexOf("--update") → -1
 *   返回同一引用 argv（未复制）
 *
 * 例 2（有 --update）：
 *   输入 argv = ["node.exe","openclaw.mjs","--update"]
 *   index = 2
 *   next = [...argv] 浅拷贝
 *   splice(2, 1, "update") → 删掉 "--update"，插入 "update"
 *   返回 ["node.exe","openclaw.mjs","update"]
 */
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

/**
 * 是否需要为「主命令」做懒注册（预注册 primary 子命令）。
 * 有 -h/--help/-V/--version 时返回 false，避免为了看帮助去加载命令实现。
 *
 * 例 1：
 *   argv = ["node.exe","openclaw.mjs","gateway","run","--port","18789"]
 *   hasHelpOrVersion(argv) → false
 *   返回 true（需要注册 primary）
 *
 * 例 2：
 *   argv = ["node.exe","openclaw.mjs","--help"]
 *   hasHelpOrVersion(argv) → true
 *   返回 false
 *
 * 注意：当前 runCli 体内未直接调用本函数；逻辑等价于「有 primary 且非 help/version 时预注册」。
 */
export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

/**
 * 是否跳过「插件 CLI 命令」注册。
 * - 已有内置 primary（core 命令已挂上）→ 跳过，避免插件覆盖同名命令
 * - 没有 primary（如纯 --help）→ 仅当 help/version 时跳过
 * - 有 primary 但不是 builtin（如 gateway）→ 不跳过，允许插件挂额外命令
 *
 * 例 1（gateway，非 builtin）：
 *   params = {
 *     argv: ["node.exe","openclaw.mjs","gateway","run","--port","18789"],
 *     primary: "gateway",
 *     hasBuiltinPrimary: false,
 *   }
 *   hasBuiltinPrimary=false → 不进第一分支
 *   primary 有值 → 不进第二分支
 *   返回 false → 继续 registerPluginCliCommands
 *
 * 例 2（setup，builtin）：
 *   params = { argv: [...],"setup"], primary: "setup", hasBuiltinPrimary: true }
 *   返回 true → 跳过插件注册
 *
 * 例 3（仅 --help）：
 *   params = { argv: [...,"--help"], primary: null, hasBuiltinPrimary: false }
 *   hasHelpOrVersion → true → 返回 true → 跳过
 */
export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

/**
 * 是否要把 openclaw CLI 目录加入 PATH（ensureOpenClawCliOnPath）。
 * 快路径命令（status/health/sessions、config get/unset、models list/status）跳过，减启动开销。
 *
 * 例 1（gateway run → 需要 PATH）：
 *   argv = ["node.exe","openclaw.mjs","gateway","run","--port","18789","--bind","loopback"]
 *   hasHelpOrVersion → false
 *   getCommandPathWithRootOptions(argv, 2)
 *     → path = ["gateway","run"]
 *   primary="gateway", secondary="run"
 *   不在豁免列表 → 返回 true → 调用 ensureOpenClawCliOnPath()
 *
 * 例 2（status → 跳过）：
 *   argv = ["node.exe","openclaw.mjs","status"]
 *   path = ["status"] → primary="status" → 返回 false
 *
 * 例 3（config get → 跳过）：
 *   argv = ["node.exe","openclaw.mjs","config","get","gateway.port"]
 *   path = ["config","get"] → 返回 false
 *
 * 例 4（无子命令）：
 *   argv = ["node.exe","openclaw.mjs"]
 *   primary=undefined → 返回 true（仍确保 PATH，方便默认交互）
 */
export function shouldEnsureCliPath(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

/**
 * CLI 主入口：规范化 argv → 加载 env → 可选快路由 → buildProgram → 预注册 primary → parseAsync。
 *
 * 基准输入（由 entry.ts 传入）：
 *   argv = [
 *     "C:\\Program Files\\nodejs\\node.exe",
 *     "E:\\openclaw-main\\openclaw-main\\openclaw.mjs",
 *     "gateway", "run", "--port", "18789", "--bind", "loopback",
 *   ]
 *
 * 数据流逐步：
 *   1) normalizeWindowsArgv(argv)
 *        → 通常不变（已由 entry 规范化过）
 *        normalizedArgv = 同上
 *
 *   2) parseCliProfileArgs(normalizedArgv)
 *        → { ok:true, profile:null, argv: 同上 }
 *        （若有 --dev：profile="dev"，argv 去掉 --dev，并 applyCliProfileEnv）
 *        normalizedArgv = parsedProfile.argv
 *
 *   3) loadDotEnv / normalizeEnv
 *        → 读 .env，规范化 OPENCLAW_* 等
 *
 *   4) shouldEnsureCliPath(normalizedArgv) → true
 *        → ensureOpenClawCliOnPath()
 *
 *   5) assertSupportedRuntime()
 *        → Node/Bun 版本不达标则抛错退出
 *
 *   6) tryRouteCli(normalizedArgv)
 *        path=["gateway","run"] → findRoutedCommand 通常 null → false
 *        （命中 route-first 命令时直接 run 并 return，不走 Commander）
 *
 *   7) enableConsoleCapture()
 *        → console 输出同时进结构化日志
 *
 *   8) buildProgram()
 *        → program = Commander 根；内部 registerProgramCommands 挂 placeholder
 *
 *   9) parseArgv = rewriteUpdateFlagArgv(normalizedArgv)
 *        → 无 --update，parseArgv === normalizedArgv
 *
 *  10) primary = getPrimaryCommand(parseArgv) → "gateway"
 *
 *  11) registerCoreCliByName(program, ctx, "gateway", parseArgv)
 *        → coreEntries 无 gateway → false（不改 program）
 *      registerSubCliByName(program, "gateway")
 *        → remove placeholder → import gateway-cli → registerGatewayCli(program)
 *
 *  12) hasBuiltinPrimary =
 *        primary!==null && program.commands.some(c => c.name()==="gateway")
 *        → true（子树已挂上，名字是 gateway）
 *      注意：gateway 是 subcli 注册的，hasBuiltinPrimary 这里按「program 上是否已有该名」判断，
 *      若 registerSubCliByName 成功则为 true → shouldSkipPluginCommandRegistration=true → 跳过插件 CLI
 *
 *  13) program.parseAsync(parseArgv)
 *        → 匹配 gateway → run → action
 *        → runGatewayCommand(resolveGatewayRunOptions({ port:"18789", bind:"loopback", ... }))
 */
export async function runCli(argv: string[] = process.argv) {
  // —— 阶段 1：argv 规范化 + profile ——
  // 返回值 normalizedArgv 是：["node.exe","openclaw.mjs","gateway","run","--port","18789","--bind","loopback"]
  let normalizedArgv = normalizeWindowsArgv(argv);
  // parseCliProfileArgs 会解析参数中的 --dev 或 --profile 选项，并应用相应的环境变量
  // 比如：--dev → OPENCLAW_PROFILE="dev", STATE_DIR="~/.openclaw-dev", GATEWAY_PORT="19001"
  const parsedProfile = parseCliProfileArgs(normalizedArgv);
  // 如果解析失败，则抛出错误
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    // 例：--dev → OPENCLAW_PROFILE="dev", STATE_DIR="~/.openclaw-dev", GATEWAY_PORT="19001"
    // 应用环境变量到 process.env
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  // 剥掉 --dev/--profile 后的 argv；基准 profile=null 时与输入相同
  normalizedArgv = parsedProfile.argv;

  // —— 阶段 2：环境 ——
  // 读 .env，规范化 OPENCLAW_* 等环境变量
  loadDotEnv({ quiet: true });
  // 规范化 OPENCLAW_* 等，比如：OPENCLAW_PROFILE="dev", STATE_DIR="~/.openclaw-dev", GATEWAY_PORT="19001"
  normalizeEnv();
  // 是否要把 openclaw CLI 目录加入 PATH（ensureOpenClawCliOnPath）。

  if (shouldEnsureCliPath(normalizedArgv)) {
    // 基准 gateway → true：把 openclaw 可执行目录加入 PATH，比如：C:\Users\Administrator\.openclaw\cli
    ensureOpenClawCliOnPath();
  }

  // 确保支持的运行时版本
  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  // —— 阶段 3：route-first 快路径（gateway 通常不命中）——
  if (await tryRouteCli(normalizedArgv)) {
    // 如果命中 route-first 命令，则直接返回
    return;
  }

  // 捕获所有控制台输出到结构化日志，同时保持 stdout/stderr 行为,
  //  例如：console.log("Hello, world!") → {"level":"info","message":"Hello, world!"}
  enableConsoleCapture();

  // —— 阶段 4：构建 Commander 程序 ——
  const { buildProgram } = await import("./program.js");
  // program 上已挂 core/subcli 的 lazy placeholder（含 gateway placeholder）

  // 构建 Commander 程序, 内部 registerProgramCommands 挂 placeholder,
  // 比如：gateway placeholder, 这样在后续的 parse 时，可以命中 gateway 命令
  const program = buildProgram();

  // 全局错误处理器，防止未处理的拒绝/异常导致崩溃，
  // 记录错误并优雅退出，而不是崩溃无 trace。
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  // —— 阶段 5：预注册 primary，再 parse ——
  // 基准：parseArgv 不变；primary = "gateway"
  // rewriteUpdateFlagArgv 会把 argv 里的 `--update` 旗标改写成子命令名 `update`，方便 Commander 识别。
  // 例：["node.exe","openclaw.mjs","gateway","run","--port","18789","--bind","loopback","--update"]
  // → ["node.exe","openclaw.mjs","gateway","run","--port","18789","--bind","loopback","update"]
  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary command (builtin or subcli) so help and command parsing
  // are correct even with lazy command registration.
  // getPrimaryCommand 会获取 argv 中的主命令，比如：["node.exe","openclaw.mjs","gateway","run","--port","18789","--bind","loopback"]
  // → "gateway"
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    // primary="gateway"：真注册 gateway 子树，替换 buildProgram 时挂的 placeholder
    // 比如：gateway 不在 coreEntries → return false 
    // getProgramContext 会获取 program 的上下文，
    // 比如：program.commands.some(c => c.name()==="gateway")
    //  → true
    const { getProgramContext } = await import("./program/program-context.js");
    const ctx = getProgramContext(program);
    // ctx 不为空，则注册 gateway 子树
    if (ctx) {
      const { registerCoreCliByName } = await import("./program/command-registry.js");
      // gateway 不在 coreEntries → return false
      await registerCoreCliByName(program, ctx, primary, parseArgv);
    }
    // 注册 gateway 子树
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    // entries 命中 gateway → registerGatewayCli(program)
    await registerSubCliByName(program, primary);
  }

  // 预注册成功后 program.commands 里已有 name()==="gateway" → hasBuiltinPrimary=true
  const hasBuiltinPrimary =
    primary !== null && program.commands.some((command) => command.name() === primary);
  const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
    argv: parseArgv,
    primary,
    hasBuiltinPrimary,
  });
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadValidatedConfigForPluginRegistration } =
      await import("./program/register.subclis.js");
    const config = await loadValidatedConfigForPluginRegistration();
    if (config) {
      registerPluginCliCommands(program, config);
    }
  }

  // 解析 ["...","gateway","run","--port","18789","--bind","loopback"]
  // → gateway.run.action(opts) → runGatewayCommand(...)
  await program.parseAsync(parseArgv);
}

/**
 * 判断当前模块是否作为 CLI 主入口运行（供测试/其它入口复用）。
 *
 * 例：
 *   currentFile = fileURLToPath(import.meta.url)
 *     → ".../dist/cli/run-main.js"（或 .mjs）
 *   isMainModule({ currentFile })
 *     → 仅当 argv[1] 指向本文件时为 true
 *   正常路径是 openclaw.mjs → entry.ts → import runCli，此处通常为 false
 */
export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}

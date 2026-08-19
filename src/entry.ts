#!/usr/bin/env node
/**
 * OpenClaw 主入口：仅当作为主模块时执行 CLI 启动逻辑。
 * 被 openclaw.mjs 通过 dist/entry 加载后，负责：环境规范化、ExperimentalWarning 抑制（必要时 respawn）、
 * 根命令 version/help 快速路径、以及通过 run-main 的 runCli(argv) 启动完整 Commander 程序。
 * 若本文件被 dist/index.js 等作为依赖 import，isMainModule 为 false，不执行任何启动逻辑，避免重复启动网关导致端口/锁冲突。
 */
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation, isRootVersionInvocation } from "./cli/argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { shouldSkipRespawnForArgv } from "./cli/respawn-policy.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

/** 用于 isMainModule 判断：哪些 wrapper 对应 entry 主入口 */
const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

/** openclaw secrets audit 时强制只读 auth store，避免误写 */
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // Imported as a dependency — skip all entry-point side effects.
} else {
  process.title = "openclaw";
  installProcessWarningFilter();
  normalizeEnv();
  if (!isTruthyEnvValue(process.env.NODE_DISABLE_COMPILE_CACHE)) {
    try {
      enableCompileCache();
    } catch {
      // Best-effort only; never block startup.
    }
  }

  if (shouldForceReadOnlyAuthStore(process.argv)) {
    process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  }

  if (process.argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }

  const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

  /** 检查当前进程是否已通过 NODE_OPTIONS 或 execArgv 抑制 ExperimentalWarning */
  function hasExperimentalWarningSuppressed(): boolean {
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {
      return true;
    }
    for (const arg of process.execArgv) {
      if (arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings") {
        return true;
      }
    }
    return false;
  }

  /**
   * 若需要抑制 ExperimentalWarning 且尚未抑制，则 respawn 子进程并传入 --disable-warning=ExperimentalWarning。
   * 返回 true 表示已 spawn 子进程，当前进程不应继续跑 CLI；返回 false 表示无需 respawn，继续执行。
   */
  function ensureExperimentalWarningSuppressed(): boolean {
    if (shouldSkipRespawnForArgv(process.argv)) {
      return false;
    }
    if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
      return false;
    }
    if (isTruthyEnvValue(process.env.OPENCLAW_NODE_OPTIONS_READY)) {
      return false;
    }
    if (hasExperimentalWarningSuppressed()) {
      return false;
    }

    process.env.OPENCLAW_NODE_OPTIONS_READY = "1";
    // 必须通过 execArgv 传参：NODE_OPTIONS 中不允许 --disable-warning
    const child = spawn(
      process.execPath,
      [EXPERIMENTAL_WARNING_FLAG, ...process.execArgv, ...process.argv.slice(1)],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    attachChildProcessBridge(child);

    child.once("exit", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exit(code ?? 1);
    });

    child.once("error", (error) => {
      console.error(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exit(1);
    });

    // Parent must not continue running the CLI.
    return true;
  }

  /** 根命令 version 快速路径：直接打出版本并 exit，不加载完整 program */
  function tryHandleRootVersionFastPath(argv: string[]): boolean {
    if (!isRootVersionInvocation(argv)) {
      return false;
    }
    Promise.all([import("./version.js"), import("./infra/git-commit.js")])
      .then(([{ VERSION }, { resolveCommitHash }]) => {
        const commit = resolveCommitHash({ moduleUrl: import.meta.url });
        console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
        process.exit(0);
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to resolve version:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
    return true;
  }

  /** 根命令 help 快速路径：只 buildProgram + outputHelp 后 exit */
  function tryHandleRootHelpFastPath(argv: string[]): boolean {
    if (!isRootHelpInvocation(argv)) {
      return false;
    }
    import("./cli/program.js")
      .then(({ buildProgram }) => {
        buildProgram().outputHelp();
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to display help:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
    return true;
  }

  process.argv = normalizeWindowsArgv(process.argv);

  // 若 respawn 了子进程，这里不会执行到
  if (!ensureExperimentalWarningSuppressed()) {
    const parsed = parseCliProfileArgs(process.argv);
    if (!parsed.ok) {
      // Keep it simple; Commander will handle rich help/errors after we strip flags.
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    if (parsed.profile) {
      applyCliProfileEnv({ profile: parsed.profile });
      // Keep Commander and ad-hoc argv checks consistent.
      process.argv = parsed.argv;
    }

    if (!tryHandleRootVersionFastPath(process.argv) && !tryHandleRootHelpFastPath(process.argv)) {
      import("./cli/run-main.js")
        .then(({ runCli }) => runCli(process.argv))
        .catch((error) => {
          console.error(
            "[openclaw] Failed to start CLI:",
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          process.exitCode = 1;
        });
    }
  }
}

/**
 * 端口工具：检测端口占用、格式化占用信息、确保端口可用及统一 EADDRINUSE 错误处理。
 * 网关启动前可调用 ensurePortAvailable(port)；失败时用 handlePortError 输出友好信息。
 */
import { danger, info, shouldLogVerbose, warn } from "../globals.js";
import { logDebug } from "../logger.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { isErrno } from "./errors.js";
import { formatPortDiagnostics } from "./ports-format.js";
import { inspectPortUsage } from "./ports-inspect.js";
import { tryListenOnPort } from "./ports-probe.js";
import type { PortListener, PortListenerKind, PortUsage, PortUsageStatus } from "./ports-types.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

export async function describePortOwner(port: number): Promise<string | undefined> {
  const diagnostics = await inspectPortUsage(port);
  if (diagnostics.listeners.length === 0) {
    return undefined;
  }
  return formatPortDiagnostics(diagnostics).join("\n");
}

/** 尝试在指定端口 listen；若 EADDRINUSE 则抛出 PortInUseError，便于上层统一提示 */
export async function ensurePortAvailable(port: number): Promise<void> {
  try {
    await tryListenOnPort({ port });
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      throw new PortInUseError(port);
    }
    throw err;
  }
}

/** 统一处理端口错误：EADDRINUSE 时输出占用详情并 exit；其他错误原样抛出 */
export async function handlePortError(
  err: unknown,
  port: number,
  context: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
  if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
    const details =
      err instanceof PortInUseError
        ? (err.details ?? (await describePortOwner(port)))
        : await describePortOwner(port);
    runtime.error(danger(`${context} failed: port ${port} is already in use.`));
    if (details) {
      runtime.error(info("Port listener details:"));
      runtime.error(details);
      if (/openclaw|src\/index\.ts|dist\/index\.js/.test(details)) {
        runtime.error(
          warn(
            "It looks like another OpenClaw instance is already running. Stop it or pick a different port.",
          ),
        );
      }
    }
    runtime.error(
      info("Resolve by stopping the process using the port or passing --port <free-port>."),
    );
    runtime.exit(1);
  }
  runtime.error(danger(`${context} failed: ${String(err)}`));
  if (shouldLogVerbose()) {
    const stdout = (err as { stdout?: string })?.stdout;
    const stderr = (err as { stderr?: string })?.stderr;
    if (stdout?.trim()) {
      logDebug(`stdout: ${stdout.trim()}`);
    }
    if (stderr?.trim()) {
      logDebug(`stderr: ${stderr.trim()}`);
    }
  }
  runtime.exit(1);
  throw new Error("unreachable");
}

export { PortInUseError };
export type { PortListener, PortListenerKind, PortUsage, PortUsageStatus };
export { buildPortHints, classifyPortListener, formatPortDiagnostics } from "./ports-format.js";
export { inspectPortUsage } from "./ports-inspect.js";

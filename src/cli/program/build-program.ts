/**
 * 构建 OpenClaw CLI 的 Commander 根程序。
 * 创建 Command、ProgramContext，挂载 help、preaction 钩子，并注册所有核心与插件子命令。
 */
import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext } from "./program-context.js";

export function buildProgram() {
  const program = new Command();
  const ctx = createProgramContext();
  const argv = process.argv;

  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  /** 注册 setup/onboard/gateway/agent/channels/send 等核心命令及插件子命令 */
  registerProgramCommands(program, ctx, argv);

  return program;
}

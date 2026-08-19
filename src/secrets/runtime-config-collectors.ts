import type { OpenClawConfig } from "../config/config.js";
import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import type { ResolverContext } from "./runtime-shared.js";

export function collectConfigAssignments(params: {
  config: OpenClawConfig;
  context: ResolverContext;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;

  // 这两个函数是一样的吗？
  // 不一样，collectCoreConfigAssignments 是用来收集核心配置赋值的函数，它接受一个 config 参数，返回一个 void。
  // collectChannelConfigAssignments 是用来收集通道配置赋值的函数，它接受一个 config 参数，返回一个 void。
  // 但是他们传入的都是params的config？, 明明是一样的？
  // 因为 params.config 是传入的配置，defaults 是传入的默认配置，context 是传入的上下文对象。
  collectCoreConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });

  collectChannelConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });
}

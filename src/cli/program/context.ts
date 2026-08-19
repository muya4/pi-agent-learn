import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

export function createProgramContext(): ProgramContext {
  // 缓存 channelOptions
  let cachedChannelOptions: string[] | undefined;
  // 获取 channelOptions
  const getChannelOptions = (): string[] => {
    // 如果 cachedChannelOptions 为空，则调用 resolveCliChannelOptions 获取 channelOptions
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  // 返回 ProgramContext
  return {
    programVersion: VERSION,
    get channelOptions() {
      return getChannelOptions();
    },
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}

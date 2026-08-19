/**
 * 通道插件加载：根据 ChannelId 从当前插件注册表加载 ChannelPlugin。
 * 实际注册表来自 plugins/runtime 的 requireActivePluginRegistry，插件由各 extension 在网关/CLI 启动时注册。
 */
import { createChannelRegistryLoader } from "./registry-loader.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

const loadPluginFromRegistry = createChannelRegistryLoader<ChannelPlugin>((entry) => entry.plugin);

/** 按通道 id 加载插件；未注册或加载失败时返回 undefined */
export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  return loadPluginFromRegistry(id);
}

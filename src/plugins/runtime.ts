/**
 * 插件运行时状态：在 globalThis 上维护当前进程的“当前插件注册表”单例。
 * 网关/CLI 启动时通过 setActivePluginRegistry 注入已加载的注册表；通道、dock、网关方法等通过 requireActivePluginRegistry 读取。
 */
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

/** 设置当前进程的活跃插件注册表（通常由网关启动流程在加载插件后调用） */
export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

/** 获取当前注册表；若尚未设置则创建一个空注册表并返回（避免通道/网关在未加载插件时抛错） */
export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    state.version += 1;
  }
  return state.registry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}

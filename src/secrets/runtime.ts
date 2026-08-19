import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import {
  collectCommandSecretAssignmentsFromSnapshot,
  type CommandSecretAssignment,
} from "./command-config.js";
import { resolveSecretRefValues } from "./resolve.js";
import { collectAuthStoreAssignments } from "./runtime-auth-collectors.js";
import { collectConfigAssignments } from "./runtime-config-collectors.js";
import {
  applyResolvedAssignments,
  createResolverContext,
  type SecretResolverWarning,
} from "./runtime-shared.js";

export type { SecretResolverWarning } from "./runtime-shared.js";

export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
};

type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
};

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
  };
}

function cloneRefreshContext(context: SecretsRuntimeRefreshContext): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    loadAuthStore: context.loadAuthStore,
  };
}

function clearActiveSecretsRuntimeState(): void {
  activeSnapshot = null;
  activeRefreshContext = null;
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}

function collectCandidateAgentDirs(config: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveOpenClawAgentDir()));
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId)));
  }
  return [...dirs];
}

function resolveRefreshAgentDirs(
  config: OpenClawConfig,
  context: SecretsRuntimeRefreshContext,
): string[] {
  const configDerived = collectCandidateAgentDirs(config);
  if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
    return configDerived;
  }
  return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}
// 这个函数做了什么事情？
// 这个函数是用来准备 secrets runtime snapshot 的函数，它接受一个 params 参数，返回一个 PreparedSecretsRuntimeSnapshot 对象。
// PreparedSecretsRuntimeSnapshot 对象的类型是：
// {
//   sourceConfig: OpenClawConfig;
//   config: OpenClawConfig;
//   authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
//   warnings: SecretResolverWarning[];
// } 
  export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
// loadAuthstore 的数据是什么，类型，举个例子, 它的作用是什么？在业务层面
/*
  {
    version: 1,
    profiles: {
      "profile1": {
        "username": "user1",
        "password": "pass1"
      }
    }
  }
  loadAuthStore 是用来加载 auth store 的函数，它接受一个 agentDir 参数，返回一个 AuthProfileStore 对象。 

*/

 // 为什么要接受agentDir参数？
 // 因为 auth store 是存储在 agentDir 目录下的，所以需要接受 agentDir 参数来加载 auth store。
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
}): Promise<PreparedSecretsRuntimeSnapshot> {

  //sourceConfig 是原始配置，resolvedConfig 是解析后的配置，context 是创建的上下文对象。
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env ?? process.env, //process.env 是当前进程的环境变量
  });

  //collectConfigAssignments 是用来收集配置赋值的函数，它接受一个 config 参数，返回一个 void。
  //它会把 config 中的配置赋值收集起来，然后存储到 context 中。
  collectConfigAssignments({
    config: resolvedConfig,
    context, //context 是创建的上下文对象。
  });

  //loadAuthStore 是用来加载 auth store 的函数，它接受一个 agentDir 参数，返回一个 AuthProfileStore 对象。
  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
  
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry)))]
    : collectCandidateAgentDirs(resolvedConfig);

  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const agentDir of candidateDirs) {
    const store = structuredClone(loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    authStores.push({ agentDir, store });
  }

  if (context.assignments.length > 0) {
    const refs = context.assignments.map((assignment) => assignment.ref);
    const resolved = await resolveSecretRefValues(refs, {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    });
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
  };
  preparedSnapshotRefreshContext.set(snapshot, {
    env: { ...(params.env ?? process.env) } as Record<string, string | undefined>,
    explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
    loadAuthStore,
  });
  return snapshot;
}

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  const refreshContext =
    preparedSnapshotRefreshContext.get(snapshot) ??
    activeRefreshContext ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
    } satisfies SecretsRuntimeRefreshContext);
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  activeSnapshot = next;
  activeRefreshContext = cloneRefreshContext(refreshContext);
  setRuntimeConfigSnapshotRefreshHandler({
    refresh: async ({ sourceConfig }) => {
      if (!activeSnapshot || !activeRefreshContext) {
        return false;
      }
      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: sourceConfig,
        env: activeRefreshContext.env,
        agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
        loadAuthStore: activeRefreshContext.loadAuthStore,
      });
      activateSecretsRuntimeSnapshot(refreshed);
      return true;
    },
    clearOnRefreshFailure: clearActiveSecretsRuntimeState,
  });
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
  }
  return snapshot;
}

export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  commandName: string;
  targetIds: ReadonlySet<string>;
}): { assignments: CommandSecretAssignment[]; diagnostics: string[]; inactiveRefPaths: string[] } {
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return { assignments: [], diagnostics: [], inactiveRefPaths: [] };
  }
  const inactiveRefPaths = [
    ...new Set(
      activeSnapshot.warnings
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path),
    ),
  ];
  const resolved = collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig: activeSnapshot.sourceConfig,
    resolvedConfig: activeSnapshot.config,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths: new Set(inactiveRefPaths),
  });
  return {
    assignments: resolved.assignments,
    diagnostics: resolved.diagnostics,
    inactiveRefPaths,
  };
}

export function clearSecretsRuntimeSnapshot(): void {
  clearActiveSecretsRuntimeState();
}

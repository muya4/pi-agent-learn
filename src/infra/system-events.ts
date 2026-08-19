// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

// SystemEvent的类型是什么？
// { text: string; ts: number; contextKey?: string | null }
// text的内容是什么？
// 事件文本
// ts的内容是什么？
// 事件时间戳
// contextKey的内容是什么？
// 事件上下文键
export type SystemEvent = { text: string; ts: number; contextKey?: string | null };

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  /*
  tips:这是一个立即执行函数表达式，用于创建一个SessionQueue对象，并返回

  tips: 自定义系统的消息提示，会显示在对话框的顶部
  */
  // options的内容是什么？
  // { sessionKey: string; contextKey?: string | null }
  // sessionKey的内容是什么？
  // 'agent:123:main' 类型是 string
  // contextKey的内容是什么？
  // 'SECRETS_RELOADER_DEGRADED' 类型是 string
  const key = requireSessionKey(options?.sessionKey);

  // entry的内容是什么？
  // SessionQueue对象
  const entry =
    // 如果queues中存在key，则返回key对应的value
    // 如果queues中不存在key，则创建一个SessionQueue对象，并返回
    queues.get(key) ??
    // 创建一个SessionQueue对象，并返回
    (() => {
      const created: SessionQueue = {
        queue: [], // 队列
        lastText: null, // 最后一个文本
        lastContextKey: null, // 最后一个上下文键
      };
      queues.set(key, created); // 将SessionQueue对象添加到queues中
      return created; // 返回SessionQueue对象
    // 这个括号的作用是什么？
    // 这是一个立即执行函数表达式，用于创建一个SessionQueue对象，并返回
    })();
  
  const cleaned = text.trim();
  // 为什么要判断？
  // 如果cleaned为空，则返回false
  if (!cleaned) {
    return false;
  }
  // 为什么要调用normalizeContextKey函数？
  // 为了将contextKey转换为小写，并去掉两端的空格
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  entry.lastContextKey = normalizedContextKey;
  // === 是什么运算符？ 为什么不是 == ？ 严格相等运算符，比较两个值的类型和值。
  if (entry.lastText === cleaned) {
    return false;
  } 

  entry.lastText = cleaned;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
  });
  // 为什么要判断？
  // 如果entry.queue的长度大于MAX_EVENTS，则删除队列中的第一个元素
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift(); // 删除队列中的第一个元素
  }
  return true; // 返回true
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((event) => ({ ...event })) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
}

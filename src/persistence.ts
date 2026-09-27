import type { Rule } from './types';
import { uid, validateRules } from './validate';
import { SAMPLE_RULES } from './samples';
import {
  EMPTY_STORE,
  validateRegressionStore,
  type RegressionStore,
} from './regression';

/**
 * 版本化持久化层
 * ----------------
 * 规则表、回归基线 / 用例等所有需要持久化的浏览器存储键都经由本模块统一处理：
 *
 * 1. **信封 + schema version**：每个主键存储 `{ v, savedAt, data }` 信封，
 *    `v` 为业务数据的 schema 版本；读取时按版本号走顺序迁移链（migrate[n] 把
 *    数据从 n 迁移到 n+1），迁移链断号 / 抛错或遇到高于当前版本的数据一律隔离。
 * 2. **校验**：迁移链末端的数据必须通过该存储键当前版本的 validate 校验，
 *    校验失败（含 JSON 无法解析、结构无法识别）不覆盖任何状态，而是隔离到
 *    诊断区（独立的 localStorage 键 + 内存镜像），可整体下载为诊断 JSON。
 * 3. **原子写入**：先写入临时键 `<key>.__tmp__`（内容带一次性 nonce），
 *    读回校验确认本次写入完整且未被并发写入方替换后，再提交主键并清理临时键，
 *    刷新 / 崩溃落在任何一步都只会看到「上一份完整数据」或「本次完整数据」，
 *    绝不会出现半写入状态。
 * 4. **永不抛错**：存储不可用（隐私模式、配额耗尽等）时退回进程内内存存储，
 *    应用启动与正常使用不被阻塞。
 *
 * 历史 localStorage 键（裸数组 / 无版本号对象）作为 version 0 遗留数据被
 * 原地识别并迁移，主键名保持不变。
 */

// ---------- 通用类型 ----------

/** 主键中的版本化信封 */
export interface Envelope<T> {
  /** 业务数据的 schema 版本号，从 1 起 */
  v: number;
  /** 最近一次成功写入时间（ISO 字符串）；历史数据迁入时为 null */
  savedAt: string | null;
  /** 业务数据 */
  data: T;
}

/** 临时键中的内容：信封 + 一次性 nonce，用于识别并发写入方 */
interface TempEnvelope<T> {
  nonce: string;
  payload: Envelope<T>;
}

/** 数据被隔离到诊断区的原因 */
export type QuarantineReason =
  | 'unreadable' // JSON 无法解析（截断 / 编码损坏）
  | 'unknown-version' // 信封版本高于当前应用可识别的最高版本
  | 'invalid-data' // 结构无法识别，或未通过当前版本校验
  | 'migration-error'; // 迁移链断号或迁移函数抛错

/** 一条隔离记录（同时写入诊断区，可被下载） */
export interface QuarantineEntry {
  id: string;
  /** 存储键的逻辑名（如 rules / regression） */
  store: string;
  /** 出问题的 localStorage 主键 */
  storeKey: string;
  /** 隔离发生时间（ISO 字符串） */
  at: string;
  reason: QuarantineReason;
  /** 隔离前数据所处的 schema 版本（未知版本 / 迁移失败时可据此定位） */
  fromVersion?: number;
  /** 中文细节说明 */
  detail: string;
  /** 原始内容：JSON 可解析时为解析值，否则为字符串原文 */
  raw: unknown;
}

export interface LoadResult<T> {
  /** 可供应用直接使用的、当前版本的、已校验的数据 */
  value: T;
  /**
   * 本次加载经过的迁移路径（如 [0, 1] 表示 v0 遗留数据迁入 v1）；
   * 空数组表示数据本来就是当前版本（或使用了默认值）。
   */
  migratedFrom: number[];
  /** 本次加载隔离的损坏数据（每项也已写入诊断区） */
  quarantined: QuarantineEntry[];
  /** 是否从上次写入中断留下的临时键恢复（已提升为新主键并清理临时键） */
  recoveredFromTemp: boolean;
  /** 底层存储是否不可用（已全程退回内存，value 只能是默认值） */
  storageUnavailable: boolean;
}

export interface SaveResult {
  ok: boolean;
  /** 数据未通过当前版本校验：未写入任何键 */
  invalidData?: string;
  /** 临时键被并发写入方替换：本次写入已安全中止，未改动主键与对方的临时键 */
  abortedConflict?: boolean;
  /** 存储层报错（配额 / 不可用等）的细节 */
  storageError?: string;
}

/** 极简存储接口：localStorage 与测试内存存储共同实现 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistenceDeps {
  storage: StorageLike;
  now(): Date;
  id(): string;
}

/** 一个存储键的完整 schema 定义 */
export interface StoreDef<T> {
  /** 逻辑名，写入诊断记录 */
  name: string;
  /** 主存储键（沿用历史 localStorage 键名，不加版本后缀） */
  key: string;
  /** 当前应用读写的 schema 版本 */
  currentVersion: number;
  /**
   * 迁移链：migrate[n] 把业务数据从版本 n 迁移到 n+1。
   * 缺号即视为无法迁移；迁移函数抛错同样隔离。
   */
  migrate: Record<number, (data: unknown) => unknown>;
  /** 无版本号历史数据的起始版本（从该版本进入迁移链） */
  legacyVersion: number;
  /** 判断解析值是否为版本化信封 */
  isEnvelope(value: unknown): value is Envelope<unknown>;
  /** 判断解析值是否为受支持的无版本号历史数据 */
  isLegacy(value: unknown): boolean;
  /** 当前版本业务数据校验 / 规范化；不合法时抛 Error */
  validate(data: unknown): T;
  /** 无任何可读数据时的默认值（每次返回独立副本） */
  defaultValue(): T;
}

// ---------- 诊断区（损坏数据隔离） ----------

const DIAGNOSTICS_KEY = 'url-route-debugger.diagnostics.v1';
const MAX_DIAGNOSTIC_ENTRIES = 20;

/** 下载的诊断 JSON 文件结构 */
export interface DiagnosticFile {
  app: string;
  schemaVersion: 1;
  exportedAt: string;
  entries: QuarantineEntry[];
}

let entryCache: WeakMap<StorageLike, QuarantineEntry[]> | null = null;
const listeners = new Set<() => void>();

function cacheMap(): WeakMap<StorageLike, QuarantineEntry[]> {
  if (entryCache === null) entryCache = new WeakMap();
  return entryCache;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidEntry(v: unknown): v is QuarantineEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.store === 'string' &&
    typeof v.storeKey === 'string' &&
    typeof v.at === 'string' &&
    typeof v.reason === 'string' &&
    typeof v.detail === 'string' &&
    'raw' in v
  );
}

/** 诊断区自身采用宽松读取：任何损坏都静默丢弃，绝不再向上隔离 */
function readEntries(storage: StorageLike): QuarantineEntry[] {
  try {
    const raw = storage.getItem(DIAGNOSTICS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && Array.isArray(parsed.entries)) {
      return parsed.entries.filter(isValidEntry);
    }
  } catch {
    // 诊断区损坏：从空重新开始
  }
  return [];
}

/** 每个存储实例各自缓存镜像，避免测试中的多存储互相污染 */
function snapshot(storage: StorageLike): QuarantineEntry[] {
  const map = cacheMap();
  let entries = map.get(storage);
  if (entries === undefined) {
    entries = readEntries(storage);
    map.set(storage, entries);
  }
  return entries;
}

/** 将一条损坏数据记录到诊断区（localStorage 不可用时仅保留在内存） */
export function recordQuarantine(
  entry: QuarantineEntry,
  deps: PersistenceDeps = defaultDeps,
): QuarantineEntry {
  const entries = [...snapshot(deps.storage), entry].slice(-MAX_DIAGNOSTIC_ENTRIES);
  cacheMap().set(deps.storage, entries);
  try {
    deps.storage.setItem(
      DIAGNOSTICS_KEY,
      JSON.stringify({ v: 1, entries }),
    );
  } catch {
    // 诊断区写不进（配额 / 隐私模式）：内存镜像仍可在本次会话内下载
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 监听方报错不影响持久化流程
    }
  }
  return entry;
}

/** 当前已隔离的记录（供界面订阅展示） */
export function getQuarantineEntries(
  deps: PersistenceDeps = defaultDeps,
): readonly QuarantineEntry[] {
  return snapshot(deps.storage);
}

/** 订阅诊断区变化（供 React useSyncExternalStore 使用） */
export function subscribeQuarantine(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 清空诊断区（同时清掉内存镜像与 localStorage 键） */
export function clearQuarantine(deps: PersistenceDeps = defaultDeps): void {
  cacheMap().set(deps.storage, []);
  try {
    deps.storage.removeItem(DIAGNOSTICS_KEY);
  } catch {
    // 存储不可用时仅清内存
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 同上
    }
  }
}

/** 把诊断区内容下载为 JSON 文件（浏览器环境） */
export function downloadDiagnostics(
  deps: PersistenceDeps = defaultDeps,
): void {
  if (typeof document === 'undefined') return;
  const file: DiagnosticFile = {
    app: 'url-route-debugger',
    schemaVersion: 1,
    exportedAt: deps.now().toISOString(),
    entries: snapshot(deps.storage),
  };
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `storage-diagnostics-${deps.now().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 默认依赖（浏览器 localStorage + 内存兜底） ----------

const memoryStore = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (key) => (memoryStore.has(key) ? (memoryStore.get(key) as string) : null),
  setItem: (key, value) => void memoryStore.set(key, value),
  removeItem: (key) => void memoryStore.delete(key),
};

/** 浏览器 localStorage 的安全包装：任意方法抛错都退回共享内存存储 */
function browserStorage(): StorageLike {
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memoryStorage.getItem(key);
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memoryStorage.setItem(key, value);
      }
    },
    removeItem(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        memoryStorage.removeItem(key);
      }
    },
  };
}

export const defaultDeps: PersistenceDeps = {
  storage: typeof window === 'undefined' ? memoryStorage : browserStorage(),
  now: () => new Date(),
  id: uid,
};

/** 供测试使用的全新内存存储 */
export function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

// ---------- 信封识别与迁移链 ----------

/** 通用信封结构识别：`{ v: 正整数, savedAt, data }` */
export function isEnvelopeShape(v: unknown): v is Envelope<unknown> {
  if (!isRecord(v)) return false;
  if (typeof v.v !== 'number' || !Number.isInteger(v.v) || v.v < 1) return false;
  if (!('data' in v)) return false;
  return (
    v.savedAt === undefined || v.savedAt === null || typeof v.savedAt === 'string'
  );
}

function isTempEnvelope(v: unknown): v is TempEnvelope<unknown> {
  return (
    isRecord(v) &&
    typeof v.nonce === 'string' &&
    isEnvelopeShape(v.payload)
  );
}

type DecodedBlob<T> =
  | { kind: 'ok'; value: T; migratedFrom: number[] }
  | { kind: 'empty' }
  | {
      kind: 'bad';
      reason: QuarantineReason;
      detail: string;
      version?: number;
      /** JSON 可解析时的解析值（作为隔离 raw） */
      parsed?: unknown;
      /** JSON 不可解析时的字符串原文（作为隔离 raw） */
      text?: string;
    };

/**
 * 沿迁移链把 (startVersion, data) 推进到当前版本，并在末端做当前版本校验。
 */
function runMigrationChain<T>(
  def: StoreDef<T>,
  startVersion: number,
  data: unknown,
): DecodedBlob<T> {
  if (startVersion > def.currentVersion) {
    return {
      kind: 'bad',
      reason: 'unknown-version',
      version: startVersion,
      detail: `数据版本 v${startVersion} 高于当前应用支持的最高版本 v${def.currentVersion}，可能由更新版本的应用写入`,
      parsed: data,
    };
  }
  // 数据本来就是当前版本：没有发生任何迁移，路径为空
  if (startVersion === def.currentVersion) {
    try {
      return { kind: 'ok', value: def.validate(data), migratedFrom: [] };
    } catch (err) {
      return {
        kind: 'bad',
        reason: 'invalid-data',
        version: def.currentVersion,
        detail: `v${def.currentVersion} 数据校验失败：${
          err instanceof Error ? err.message : String(err)
        }`,
        parsed: data,
      };
    }
  }
  const path = [startVersion];
  let version = startVersion;
  let current = data;
  while (version < def.currentVersion) {
    const migrate = def.migrate[version];
    if (typeof migrate !== 'function') {
      return {
        kind: 'bad',
        reason: 'migration-error',
        version,
        detail: `缺少从 v${version} 到 v${version + 1} 的迁移函数，迁移链中断`,
        parsed: current,
      };
    }
    try {
      current = migrate(current);
    } catch (err) {
      return {
        kind: 'bad',
        reason: 'migration-error',
        version,
        detail: `从 v${version} 迁移到 v${version + 1} 失败：${
          err instanceof Error ? err.message : String(err)
        }`,
        parsed: current,
      };
    }
    version += 1;
    path.push(version);
  }
  try {
    return { kind: 'ok', value: def.validate(current), migratedFrom: path };
  } catch (err) {
    return {
      kind: 'bad',
      reason: 'invalid-data',
      version: def.currentVersion,
      detail: `v${def.currentVersion} 数据校验失败：${
        err instanceof Error ? err.message : String(err)
      }`,
      parsed: current,
    };
  }
}

/** 解析并迁移主键读到的字符串内容（标准信封或无版本历史数据） */
function decodeBlob<T>(def: StoreDef<T>, text: string): DecodedBlob<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      kind: 'bad',
      reason: 'unreadable',
      detail: `JSON 无法解析：${err instanceof Error ? err.message : String(err)}`,
      text,
    };
  }
  return decodeParsed(def, parsed);
}

/**
 * 解析临时键读到的字符串：必须是 {nonce, payload: 信封} 包装，
 * 取出 payload 后按标准信封走迁移链。
 */
function decodeTempBlob<T>(def: StoreDef<T>, text: string): DecodedBlob<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      kind: 'bad',
      reason: 'unreadable',
      detail: `JSON 无法解析：${err instanceof Error ? err.message : String(err)}`,
      text,
    };
  }
  if (!isTempEnvelope(parsed)) {
    return {
      kind: 'bad',
      reason: 'invalid-data',
      detail: '临时键内容不是 {nonce, payload} 临时信封',
      parsed,
    };
  }
  const payload = (parsed as TempEnvelope<unknown>).payload as Envelope<unknown>;
  return runMigrationChain(def, payload.v, payload.data);
}

function decodeParsed<T>(def: StoreDef<T>, parsed: unknown): DecodedBlob<T> {
  if (def.isEnvelope(parsed)) {
    return runMigrationChain(
      def,
      (parsed as Envelope<unknown>).v,
      (parsed as Envelope<unknown>).data,
    );
  }
  if (def.isLegacy(parsed)) {
    return runMigrationChain(def, def.legacyVersion, parsed);
  }
  return {
    kind: 'bad',
    reason: 'invalid-data',
    detail: '数据既不是版本化信封，也不是受支持的历史格式',
    parsed,
  };
}

// ---------- 读取 ----------

const TEMP_SUFFIX = '.__tmp__';

function readBlob(storage: StorageLike, key: string): string | null {
  return storage.getItem(key);
}

/**
 * 读取一个存储键。任何损坏 / 未知版本 / 迁移失败都不抛出：
 * 损坏内容隔离到诊断区，按「主键优先、临时键兜底」选出可用数据，
 * 都不可用时返回默认值。
 */
export function loadStore<T>(
  def: StoreDef<T>,
  deps: PersistenceDeps = defaultDeps,
): LoadResult<T> {
  const { storage } = deps;
  const tempKey = def.key + TEMP_SUFFIX;

  let mainText: string | null;
  let tempText: string | null;
  try {
    mainText = readBlob(storage, def.key);
    tempText = readBlob(storage, tempKey);
  } catch {
    // 存储完全不可用：默认值兜底，绝不阻塞启动
    return {
      value: def.defaultValue(),
      migratedFrom: [],
      quarantined: [],
      recoveredFromTemp: false,
      storageUnavailable: true,
    };
  }

  const quarantined: QuarantineEntry[] = [];
  const quarantine = (
    bad: Extract<DecodedBlob<T>, { kind: 'bad' }>,
    actualKey: string,
  ): void => {
    const entry: QuarantineEntry = {
      id: deps.id(),
      store: def.name,
      storeKey: actualKey,
      at: deps.now().toISOString(),
      reason: bad.reason,
      ...(bad.version !== undefined ? { fromVersion: bad.version } : {}),
      detail:
        actualKey === def.key
          ? bad.detail
          : `临时键 ${tempKey} 中发现未完成 / 损坏的写入：${bad.detail}`,
      raw: bad.text !== undefined ? bad.text : (bad.parsed as unknown),
    };
    recordQuarantine(entry, deps);
    quarantined.push(entry);
  };

  const main: DecodedBlob<T> =
    mainText === null ? { kind: 'empty' } : decodeBlob(def, mainText);
  const temp: DecodedBlob<T> =
    tempText === null ? { kind: 'empty' } : decodeTempBlob(def, tempText);

  if (temp.kind === 'bad') quarantine(temp, tempKey);

  let value: T;
  let migratedFrom: number[] = [];
  let recoveredFromTemp = false;

  if (main.kind === 'ok') {
    // 提交已完成：主键永远优先；临时键即使内容更新也是未提交的废弃写入
    value = main.value;
    migratedFrom = main.migratedFrom;
    if (temp.kind !== 'empty') {
      try {
        storage.removeItem(tempKey);
      } catch {
        // 残留临时键无害：下次读取会再次识别并清理
      }
    }
  } else {
    if (main.kind === 'bad') quarantine(main, def.key);
    if (temp.kind === 'ok') {
      // 主键缺失 / 损坏但临时键完整：上次写入在提交前后中断。
      // 提升时写回标准信封（而非临时包装），得到一个干净的新主键再清理临时键。
      value = temp.value;
      migratedFrom = temp.migratedFrom;
      recoveredFromTemp = true;
      try {
        storage.setItem(
          def.key,
          JSON.stringify({
            v: def.currentVersion,
            savedAt: null,
            data: temp.value,
          } satisfies Envelope<T>),
        );
        storage.removeItem(tempKey);
      } catch {
        // 提升失败也不影响本次内存中的可用值；下次启动仍可从临时键恢复
      }
    } else {
      value = def.defaultValue();
    }
  }

  return {
    value,
    migratedFrom,
    quarantined,
    recoveredFromTemp,
    storageUnavailable: false,
  };
}

// ---------- 写入 ----------

/**
 * 原子写入：临时键（nonce 信封）→ 读回校验 → 提交主键 → 清理临时键。
 * 数据先过当前版本校验，校验不过不触碰任何键。
 */
export function saveStore<T>(
  def: StoreDef<T>,
  data: T,
  deps: PersistenceDeps = defaultDeps,
): SaveResult {
  const { storage } = deps;
  const tempKey = def.key + TEMP_SUFFIX;

  let valid: T;
  try {
    valid = def.validate(data);
  } catch (err) {
    return {
      ok: false,
      invalidData: err instanceof Error ? err.message : String(err),
    };
  }

  const envelope: Envelope<T> = {
    v: def.currentVersion,
    savedAt: deps.now().toISOString(),
    data: valid,
  };
  const nonce = deps.id();
  let tempText: string;
  try {
    tempText = JSON.stringify({ nonce, payload: envelope } satisfies TempEnvelope<T>);
  } catch (err) {
    return { ok: false, storageError: String(err) };
  }

  // 1) 写临时键
  try {
    storage.setItem(tempKey, tempText);
  } catch (err) {
    return { ok: false, storageError: err instanceof Error ? err.message : String(err) };
  }

  // 2) 立即读回：确认内容完整、属于本次写入（nonce）、且仍能通过当前版本校验
  let readback: string | null;
  try {
    readback = storage.getItem(tempKey);
  } catch (err) {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 清理失败也忽略
    }
    return { ok: false, storageError: err instanceof Error ? err.message : String(err) };
  }

  if (readback === null) {
    return { ok: false, storageError: '临时键写入后读回为空' };
  }
  let parsedReadback: unknown;
  try {
    parsedReadback = JSON.parse(readback);
  } catch {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 同上
    }
    return { ok: false, storageError: '临时键读回内容无法解析（疑似半写入）' };
  }
  if (!isTempEnvelope(parsedReadback)) {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 同上
    }
    return { ok: false, storageError: '临时键读回内容不是合法的临时信封' };
  }
  if (parsedReadback.nonce !== nonce) {
    // 并发写入方已占用临时键：绝不删除它（对方可能尚未提交主键），本次写入安全中止。
    // 调用方保有的状态不丢，下一次编辑会重新发起写入；最终顺序由「最后提交主键者」决定。
    return { ok: false, abortedConflict: true };
  }
  if (parsedReadback.payload.v !== def.currentVersion) {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 同上
    }
    return { ok: false, storageError: '临时键读回的 schema 版本与本次写入不一致' };
  }
  try {
    def.validate(parsedReadback.payload.data);
  } catch (err) {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 同上
    }
    return {
      ok: false,
      storageError: `临时键读回数据校验失败：${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 3) 提交主键（此时临时键已确认完整，任何时刻刷新都至少能读到一侧完整数据）
  let mainText: string;
  try {
    mainText = JSON.stringify(envelope);
    storage.setItem(def.key, mainText);
  } catch (err) {
    try {
      storage.removeItem(tempKey);
    } catch {
      // 同上
    }
    return { ok: false, storageError: err instanceof Error ? err.message : String(err) };
  }

  // 4) 清理临时键前再确认一次归属：若已被并发写入方替换则保留它
  try {
    const owner = storage.getItem(tempKey);
    if (owner === null) {
      // 已被他人清理，无需处理
    } else {
      const ownerParsed = JSON.parse(owner);
      if (!isTempEnvelope(ownerParsed) || ownerParsed.nonce === nonce) {
        storage.removeItem(tempKey);
      }
    }
  } catch {
    // 残留的自有临时键在下次加载时因主键有效而被清理，无半写入风险
  }

  return { ok: true };
}

// ---------- 受管访问（应用层使用：默认值兜底 + 迁移后立即写回） ----------

export interface ManagedStore<T> extends LoadResult<T> {
  save(data: T): SaveResult;
}

/** 读取存储键并拿到绑定好的 save；即使持久化层内部出现意外错误也不阻塞应用启动 */
export function loadManaged<T>(
  def: StoreDef<T>,
  deps: PersistenceDeps = defaultDeps,
): ManagedStore<T> {
  let result: LoadResult<T>;
  try {
    result = loadStore(def, deps);
  } catch (err) {
    // 最后的安全网：任何未预期的异常都不允许阻塞启动，隔离后使用默认值
    try {
      recordQuarantine(
        {
          id: deps.id(),
          store: def.name,
          storeKey: def.key,
          at: deps.now().toISOString(),
          reason: 'invalid-data',
          detail: `持久化层发生未预期错误：${
            err instanceof Error ? err.message : String(err)
          }`,
          raw: null,
        },
        deps,
      );
    } catch {
      // 隔离本身失败也不再向上抛
    }
    result = {
      value: def.defaultValue(),
      migratedFrom: [],
      quarantined: [],
      recoveredFromTemp: false,
      storageUnavailable: false,
    };
  }

  // 迁移成功后立即把新版本信封写回（best effort），避免每次启动重复迁移
  if (result.migratedFrom.length > 1 && !result.storageUnavailable) {
    try {
      saveStore(def, result.value, deps);
    } catch {
      // 写回失败不影响本次会话使用已迁移的数据
    }
  }

  return {
    ...result,
    save: (data: T) => {
      try {
        return saveStore(def, data, deps);
      } catch (err) {
        return { ok: false, storageError: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------- 各存储键定义 ----------

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}

/**
 * 规则表。
 * - v0（历史裸数组）：规则可能没有 query 字段；
 * - v1：当前版本，Rule[]（query 必填，旧规则缺省时按空条件迁移）。
 * 主键沿用 url-route-debugger.rules.v1。
 */
export const rulesStore: StoreDef<Rule[]> = {
  name: 'rules',
  key: 'url-route-debugger.rules.v1',
  currentVersion: 1,
  legacyVersion: 0,
  isEnvelope: isEnvelopeShape,
  isLegacy: Array.isArray,
  migrate: {
    // v0 → v1：为缺少 query 字段的旧规则补齐空条件（任意查询串均可命中）
    0: (data) => {
      if (!Array.isArray(data)) return data;
      return data.map((raw) =>
        isRecordValue(raw) && raw.query === undefined ? { ...raw, query: [] } : raw,
      );
    },
  },
  validate: validateRules,
  defaultValue: () => structuredClone(SAMPLE_RULES),
};

/**
 * 回归基线与用例。
 * - v0（历史无版本对象 {baseline, cases}）与 v1 的业务结构相同，
 *   迁移仅表示「纳入信封」；严格结构闸在此后由 validate 把关，
 *   基线内部损坏仍保持「仅丢弃基线、保留用例」的宽容策略。
 * 主键沿用 url-route-debugger.regression.v1。
 */
export const regressionStore: StoreDef<RegressionStore> = {
  name: 'regression',
  key: 'url-route-debugger.regression.v1',
  currentVersion: 1,
  legacyVersion: 0,
  isEnvelope: isEnvelopeShape,
  isLegacy: (v) =>
    isRecord(v) && (Array.isArray(v.cases) || 'baseline' in v),
  migrate: {
    0: (data) => data,
  },
  validate: validateRegressionData,
  defaultValue: () => structuredClone(EMPTY_STORE),
};

/**
 * 回归存储的严格结构闸：结构不对（顶层非对象、cases 非数组、baseline 类型错）
 * 抛错交由持久化层隔离；结构通过后再走既有的宽容规范化（逐条过滤非法用例、
 * 损坏基线单独丢弃）。
 */
export function validateRegressionData(data: unknown): RegressionStore {
  if (!isRecord(data)) throw new Error('回归数据顶层必须是对象');
  if (!('cases' in data) || !Array.isArray(data.cases)) {
    throw new Error('回归数据的 cases 必须是数组');
  }
  if (
    data.baseline !== undefined &&
    data.baseline !== null &&
    !isRecord(data.baseline)
  ) {
    throw new Error('回归数据的 baseline 必须是对象或 null');
  }
  return validateRegressionStore(data);
}

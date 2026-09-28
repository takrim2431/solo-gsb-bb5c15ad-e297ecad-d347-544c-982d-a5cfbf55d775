import { describe, expect, it, vi } from 'vitest';
import {
  type Envelope,
  type PersistenceDeps,
  type StoreDef,
  type StorageLike,
  clearQuarantine,
  createFallbackStorage,
  createMemoryStorage,
  downloadDiagnostics,
  getQuarantineEntries,
  isEnvelopeShape,
  loadManaged,
  loadStore,
  recordQuarantine,
  regressionStore,
  rulesStore,
  saveStore,
  subscribeQuarantine,
  subscribeStorageHealth,
  getStorageHealth,
} from './persistence';
import { SAMPLE_RULES } from './samples';
import type { Rule } from './types';
import { EMPTY_STORE } from './regression';

// 模块内诊断键（测试断言用），未导出是有意的界面实现细节
const DIAGNOSTICS_KEY = 'url-route-debugger.diagnostics.v1';

const RULE: Rule = {
  id: 'r1',
  name: '规则一',
  enabled: true,
  method: 'ANY',
  host: 'a.com',
  pathTemplate: '/a',
  query: [],
  action: { type: 'rewrite', target: '/b', status: 302 },
};

function envelope<T>(v: number, data: T): Envelope<T> {
  return { v, savedAt: null, data };
}

function testDeps(initial: Record<string, string> = {}): PersistenceDeps & {
  storage: StorageLike;
} {
  const storage = createMemoryStorage(initial);
  let seq = 0;
  return {
    storage,
    now: () => new Date('2026-09-26T08:00:00.000Z'),
    id: () => `id-${++seq}`,
  };
}

/** 多跳迁移链专用测试存储：v0 {entries:[...]} → v1 {items:[...]} → v2 string[] */
const chainStore: StoreDef<string[]> = {
  name: 'chain',
  key: 'chain.test.v1',
  currentVersion: 2,
  legacyVersion: 0,
  isEnvelope: isEnvelopeShape,
  isLegacy: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Array.isArray((v as { entries?: unknown }).entries),
  migrate: {
    0: (data) => ({ items: (data as { entries: unknown[] }).entries }),
    1: (data) => (data as { items: unknown[] }).items,
  },
  validate: (data) => {
    if (!Array.isArray(data) || !data.every((x) => typeof x === 'string')) {
      throw new Error('必须是字符串数组');
    }
    return data as string[];
  },
  defaultValue: () => [],
};

// ---------- 基本读写与原子写入 ----------

describe('saveStore / loadStore（信封往返与原子写入）', () => {
  it('写入后主键为 v1 信封且临时键被清理', () => {
    const deps = testDeps();
    const res = saveStore(rulesStore, [RULE], deps);
    expect(res.ok).toBe(true);

    const raw = deps.storage.getItem(rulesStore.key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.v).toBe(1);
    expect(parsed.savedAt).toBe('2026-09-26T08:00:00.000Z');
    expect(parsed.data).toEqual([RULE]);
    expect(deps.storage.getItem(rulesStore.key + '.__tmp__')).toBeNull();

    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual([RULE]);
    expect(loaded.migratedFrom).toEqual([]);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.recoveredFromTemp).toBe(false);
  });

  it('数据不通过当前版本校验：拒绝写入且不触碰任何键', () => {
    const deps = testDeps();
    saveStore(rulesStore, [RULE], deps);
    const mainBefore = deps.storage.getItem(rulesStore.key);
    const tempKey = rulesStore.key + '.__tmp__';

    const res = saveStore(rulesStore, [{ bogus: true }] as unknown as Rule[], deps);
    expect(res.ok).toBe(false);
    expect(res.invalidData).toMatch(/规则/);
    expect(deps.storage.getItem(rulesStore.key)).toBe(mainBefore);
    expect(deps.storage.getItem(tempKey)).toBeNull();
  });

  it('全新存储（两个键都不存在）返回默认值，不隔离任何数据', () => {
    const deps = testDeps();
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.storageUnavailable).toBe(false);

    const regression = loadStore(regressionStore, deps);
    expect(regression.value).toEqual(EMPTY_STORE);
  });

  it('本地规则恢复时重复 id 按原顺序去重，保存并再次加载后身份稳定', () => {
    const stored = [
      { ...RULE, id: 'dup', name: '第一条' },
      { ...RULE, id: 'dup', name: '第二条' },
      { ...RULE, id: 'other', name: '第三条' },
    ];
    const deps = testDeps({
      [rulesStore.key]: JSON.stringify(envelope(1, stored)),
    });

    const loaded = loadStore(rulesStore, deps);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.value.map((r) => r.name)).toEqual(['第一条', '第二条', '第三条']);
    expect(loaded.value[0].id).toBe('dup');
    expect(loaded.value[2].id).toBe('other');
    const ids = loaded.value.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);

    // 保存去重后的规则表并模拟刷新重载：id 不再变化
    const saved = saveStore(rulesStore, loaded.value, deps);
    expect(saved.ok).toBe(true);
    const reloaded = loadStore(rulesStore, deps);
    expect(reloaded.value.map((r) => r.id)).toEqual(ids);
  });
});

// ---------- 迁移链 ----------

describe('迁移链（历史无版本数据与多跳升级）', () => {
  it('规则表 v0 裸数组：缺 query 的旧规则补齐空条件，受管加载后立即写回 v1 信封', () => {
    const legacy = [{ ...RULE }] as Array<Record<string, unknown>>;
    delete (legacy[0] as { query?: unknown }).query;
    const deps = testDeps({ [rulesStore.key]: JSON.stringify(legacy) });

    const managed = loadManaged(rulesStore, deps);
    expect(managed.migratedFrom).toEqual([0, 1]);
    expect(managed.value[0].query).toEqual([]);
    expect(managed.quarantined).toEqual([]);

    // 写回：主键已是当前版本信封
    const rewritten = JSON.parse(deps.storage.getItem(rulesStore.key) as string);
    expect(isEnvelopeShape(rewritten)).toBe(true);
    expect(rewritten.v).toBe(1);
    expect(rewritten.data[0].query).toEqual([]);

    // 再次加载不再走迁移
    expect(loadStore(rulesStore, deps).migratedFrom).toEqual([]);
  });

  it('回归存储 v0 无版本对象 {baseline, cases} 纳入信封，业务数据原样保留', () => {
    const legacy = {
      baseline: null,
      cases: [{ id: 'c1', method: 'GET', url: 'http://x.com/a' }],
    };
    const deps = testDeps({ [regressionStore.key]: JSON.stringify(legacy) });

    const managed = loadManaged(regressionStore, deps);
    expect(managed.migratedFrom).toEqual([0, 1]);
    expect(managed.value.cases).toEqual(legacy.cases);

    const rewritten = JSON.parse(deps.storage.getItem(regressionStore.key) as string);
    expect(rewritten.v).toBe(1);
  });

  it('多跳迁移链：v0 → v1 → v2 顺序执行', () => {
    const deps = testDeps({
      [chainStore.key]: JSON.stringify({ entries: ['a', 'b'] }),
    });
    const loaded = loadStore(chainStore, deps);
    expect(loaded.migratedFrom).toEqual([0, 1, 2]);
    expect(loaded.value).toEqual(['a', 'b']);
  });

  it('多跳迁移链：从信封 v1 出发只执行剩余跳数', () => {
    const deps = testDeps({
      [chainStore.key]: JSON.stringify(envelope(1, { items: ['x'] })),
    });
    const loaded = loadStore(chainStore, deps);
    expect(loaded.migratedFrom).toEqual([1, 2]);
    expect(loaded.value).toEqual(['x']);
  });

  it('迁移链断号：隔离并回退默认值', () => {
    const brokenChain: StoreDef<string[]> = {
      ...chainStore,
      key: 'chain.gap',
      migrate: { 0: (d) => d }, // 缺少 1 → 2
    };
    const deps = testDeps({
      [brokenChain.key]: JSON.stringify({ entries: ['a'] }),
    });
    const loaded = loadStore(brokenChain, deps);
    expect(loaded.value).toEqual([]);
    expect(loaded.quarantined).toHaveLength(1);
    expect(loaded.quarantined[0].reason).toBe('migration-error');
    expect(loaded.quarantined[0].detail).toMatch(/迁移链中断/);
  });

  it('迁移函数抛错：隔离原始数据并回退默认值', () => {
    const throwingChain: StoreDef<string[]> = {
      ...chainStore,
      key: 'chain.throw',
      migrate: {
        0: () => {
          throw new Error('boom');
        },
        1: (d) => d,
      },
    };
    const deps = testDeps({
      [throwingChain.key]: JSON.stringify({ entries: ['a'] }),
    });
    const loaded = loadStore(throwingChain, deps);
    expect(loaded.value).toEqual([]);
    expect(loaded.quarantined[0].reason).toBe('migration-error');
    expect(loaded.quarantined[0].detail).toMatch(/boom/);
  });
});

// ---------- 未知版本与损坏恢复 ----------

describe('损坏 / 未知版本隔离（不阻塞启动，可下载诊断）', () => {
  it('JSON 截断无法解析：原始字符串隔离，规则表回退示例', () => {
    const deps = testDeps({ [rulesStore.key]: '{"v":1,"data":[' });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined).toHaveLength(1);
    const entry = loaded.quarantined[0];
    expect(entry.reason).toBe('unreadable');
    expect(entry.store).toBe('rules');
    expect(entry.storeKey).toBe(rulesStore.key);
    expect(entry.raw).toBe('{"v":1,"data":[');
    expect(entry.at).toBe('2026-09-26T08:00:00.000Z');

    // 同时进入诊断区持久化
    const all = getQuarantineEntries(deps);
    expect(all.map((e) => e.id)).toContain(entry.id);
  });

  it('高于当前的未知版本：隔离并记录来源版本号', () => {
    const deps = testDeps({
      [rulesStore.key]: JSON.stringify(envelope(99, [{ future: true }])),
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined[0].reason).toBe('unknown-version');
    expect(loaded.quarantined[0].fromVersion).toBe(99);
    expect(loaded.quarantined[0].detail).toMatch(/v99/);
  });

  it('结构无法识别：隔离解析后的值', () => {
    const deps = testDeps({
      [rulesStore.key]: JSON.stringify({ hello: 'world' }),
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.quarantined[0].reason).toBe('invalid-data');
    expect(loaded.quarantined[0].raw).toEqual({ hello: 'world' });
  });

  it('信封版本合法但末端校验失败：隔离（回归 cases 不是数组）', () => {
    const deps = testDeps({
      [regressionStore.key]: JSON.stringify(envelope(1, { cases: 'nope' })),
    });
    const loaded = loadStore(regressionStore, deps);
    expect(loaded.value).toEqual(EMPTY_STORE);
    expect(loaded.quarantined[0].reason).toBe('invalid-data');
    expect(loaded.quarantined[0].detail).toMatch(/cases/);
  });

  it('回归存储宽容策略不变：用例逐条过滤、损坏基线仅丢弃基线，不触发隔离', () => {
    const deps = testDeps({
      [regressionStore.key]: JSON.stringify(
        envelope(1, {
          baseline: { rules: [{ method: 'FOO' }], frozenAt: 'x' },
          cases: [
            { id: 'ok', method: 'GET', url: 'http://x.com/' },
            { id: 'bad', method: 'FOO', url: 'http://x.com/' },
          ],
        }),
      ),
    });
    const loaded = loadStore(regressionStore, deps);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.value.baseline).toBeNull();
    expect(loaded.value.cases).toEqual([
      { id: 'ok', method: 'GET', url: 'http://x.com/' },
    ]);
  });

  it('隔离记录持久化到诊断键，上限 20 条，超出淘汰最旧记录', () => {
    const deps = testDeps();
    for (let i = 0; i < 23; i++) {
      recordQuarantine(
        {
          id: `q${i}`,
          store: 'rules',
          storeKey: rulesStore.key,
          at: `2026-09-26T08:00:${String(i).padStart(2, '0')}.000Z`,
          reason: 'unreadable',
          detail: 'x',
          raw: 'x',
        },
        deps,
      );
    }
    expect(getQuarantineEntries(deps)).toHaveLength(20);
    expect(getQuarantineEntries(deps)[0].id).toBe('q3');
    const persisted = JSON.parse(deps.storage.getItem(DIAGNOSTICS_KEY) as string);
    expect(persisted.v).toBe(1);
    expect(persisted.entries).toHaveLength(20);
  });

  it('诊断区自身损坏：静默从空开始，不抛错也不再向上隔离', () => {
    const deps = testDeps({ [DIAGNOSTICS_KEY]: 'garbage{' });
    expect(getQuarantineEntries(deps)).toEqual([]);
    recordQuarantine(
      {
        id: 'q1',
        store: 'rules',
        storeKey: rulesStore.key,
        at: '2026-09-26T08:00:00.000Z',
        reason: 'unreadable',
        detail: 'x',
        raw: 'x',
      },
      deps,
    );
    expect(getQuarantineEntries(deps)).toHaveLength(1);
  });

  it('subscribeQuarantine：隔离与清空都通知订阅者', () => {
    const deps = testDeps();
    const listener = vi.fn();
    const unsubscribe = subscribeQuarantine(listener);
    recordQuarantine(
      {
        id: 'q1',
        store: 'rules',
        storeKey: rulesStore.key,
        at: '2026-09-26T08:00:00.000Z',
        reason: 'unreadable',
        detail: 'x',
        raw: 'x',
      },
      deps,
    );
    clearQuarantine(deps);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getQuarantineEntries(deps)).toEqual([]);
    expect(deps.storage.getItem(DIAGNOSTICS_KEY)).toBeNull();
    unsubscribe();
  });

  it('downloadDiagnostics 在无 DOM 环境安全跳过（不抛错）', () => {
    const deps = testDeps();
    expect(() => downloadDiagnostics(deps)).not.toThrow();
  });
});

// ---------- 临时键崩溃恢复（原子性） ----------

describe('崩溃恢复：任意中断点都不出现半写入状态', () => {
  function tempEnvelope(data: unknown, nonce = 'pending', v = 1): string {
    return JSON.stringify({ nonce, payload: envelope(v, data) });
  }

  it('主键有效 + 残留临时键：以主键为准并清理临时键（即使临时内容更新）', () => {
    const deps = testDeps({
      [rulesStore.key]: JSON.stringify(envelope(1, [RULE])),
      [rulesStore.key + '.__tmp__']: tempEnvelope([RULE, RULE]),
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual([RULE]);
    expect(loaded.recoveredFromTemp).toBe(false);
    expect(deps.storage.getItem(rulesStore.key + '.__tmp__')).toBeNull();
  });

  it('主键缺失 + 临时键完整：提升临时键为新主键（标准信封）并清理', () => {
    const temp = tempEnvelope([RULE]);
    const tempKey = rulesStore.key + '.__tmp__';
    const deps = testDeps({ [tempKey]: temp });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual([RULE]);
    expect(loaded.recoveredFromTemp).toBe(true);
    // 提升后的主键是标准信封（不再是 {nonce, payload} 包装）
    const promoted = JSON.parse(deps.storage.getItem(rulesStore.key) as string);
    expect(isEnvelopeShape(promoted)).toBe(true);
    expect(promoted.v).toBe(1);
    expect(promoted.data).toEqual([RULE]);
    expect(deps.storage.getItem(tempKey)).toBeNull();

    // 再读一次：从提升后的主键正常读取，不再触发恢复
    const reloaded = loadStore(rulesStore, deps);
    expect(reloaded.recoveredFromTemp).toBe(false);
    expect(reloaded.value).toEqual([RULE]);
  });

  it('主键损坏 + 临时键完整：主键内容隔离，临时键提升，应用照常启动', () => {
    const temp = tempEnvelope([RULE]);
    const tempKey = rulesStore.key + '.__tmp__';
    const deps = testDeps({
      [rulesStore.key]: 'truncated{',
      [tempKey]: temp,
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual([RULE]);
    expect(loaded.recoveredFromTemp).toBe(true);
    expect(loaded.quarantined).toHaveLength(1);
    expect(loaded.quarantined[0].reason).toBe('unreadable');
    expect(isEnvelopeShape(JSON.parse(deps.storage.getItem(rulesStore.key) as string))).toBe(
      true,
    );
    expect(deps.storage.getItem(tempKey)).toBeNull();
  });

  it('主键有效 + 临时键损坏：临时键隔离后清理，主键不受影响', () => {
    const deps = testDeps({
      [rulesStore.key]: JSON.stringify(envelope(1, [RULE])),
      [rulesStore.key + '.__tmp__']: '{half-written',
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual([RULE]);
    expect(loaded.quarantined).toHaveLength(1);
    expect(loaded.quarantined[0].detail).toMatch(/临时键/);
    expect(deps.storage.getItem(rulesStore.key + '.__tmp__')).toBeNull();
  });

  it('主键与临时键都损坏：两条记录都隔离，回退默认值', () => {
    const deps = testDeps({
      [rulesStore.key]: '{a',
      [rulesStore.key + '.__tmp__']: '{b',
    });
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined).toHaveLength(2);
  });

  it('已提交旧主键 + 中断在提交前的新临时键：保留旧主键，丢弃未提交写入', () => {
    const oldMain = JSON.stringify(envelope(2, ['old']));
    const deps = testDeps({
      [chainStore.key]: oldMain,
      [chainStore.key + '.__tmp__']: tempEnvelope(['new'], 'pending', 2),
    });
    const loaded = loadStore(chainStore, deps);
    expect(loaded.value).toEqual(['old']);
    expect(deps.storage.getItem(chainStore.key)).toBe(oldMain);
    expect(deps.storage.getItem(chainStore.key + '.__tmp__')).toBeNull();
  });
});

// ---------- 并发写入顺序 ----------

describe('并发写入顺序（临时键 nonce 归属校验）', () => {
  const KEY = chainStore.key;
  const TEMP = KEY + '.__tmp__';

  it('写入方 A 的临时键在提交前被写入方 B 替换：A 安全中止，B 的临时键原样保留', () => {
    const base = createMemoryStorage();
    saveStore(chainStore, ['old'], {
      storage: base,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'base',
    });
    const mainBefore = base.getItem(KEY);

    let armed = true;
    const spy: StorageLike = {
      getItem: (k) => base.getItem(k),
      setItem: (k, v) => {
        base.setItem(k, v);
        if (armed && k === TEMP) {
          // B 在 A 写临时键之后、读回之前占用临时键
          armed = false;
          base.setItem(
            TEMP,
            JSON.stringify({ nonce: 'nonce-B', payload: envelope(2, ['B']) }),
          );
        }
      },
      removeItem: (k) => base.removeItem(k),
    };
    const deps: PersistenceDeps = {
      storage: spy,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'nonce-A',
    };

    const res = saveStore(chainStore, ['A'], deps);
    expect(res.ok).toBe(false);
    expect(res.abortedConflict).toBe(true);

    // A 没有覆盖 B 的临时键，也没有改动主键
    expect(JSON.parse(base.getItem(TEMP) as string).nonce).toBe('nonce-B');
    expect(base.getItem(KEY)).toBe(mainBefore);

    // B 随后完成写入：主键更新为 B，临时键清理——顺序完整，无半写入
    const resB = saveStore(chainStore, ['B'], {
      storage: base,
      now: deps.now,
      id: () => 'nonce-B2',
    });
    expect(resB.ok).toBe(true);
    expect(JSON.parse(base.getItem(KEY) as string).data).toEqual(['B']);
    expect(base.getItem(TEMP)).toBeNull();
  });

  it('B 在 A 读回前完整提交（含清理临时键）：A 读回为空而失败，主键为 B，无残留', () => {
    const base = createMemoryStorage();
    saveStore(chainStore, ['old'], {
      storage: base,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'base',
    });

    let armed = true;
    const bDeps: PersistenceDeps = {
      storage: base,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'nonce-B',
    };
    const spy: StorageLike = {
      getItem: (k) => base.getItem(k),
      setItem: (k, v) => {
        base.setItem(k, v);
        if (armed && k === TEMP) {
          armed = false;
          // B 完成整套 临时键 → 主键 → 清理
          saveStore(chainStore, ['B'], bDeps);
        }
      },
      removeItem: (k) => base.removeItem(k),
    };

    const res = saveStore(chainStore, ['A'], {
      storage: spy,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'nonce-A',
    });
    expect(res.ok).toBe(false);
    expect(res.storageError).toBeTruthy();
    // 最后提交者 B 的状态完整可见，且不存在残留临时键
    expect(JSON.parse(base.getItem(KEY) as string).data).toEqual(['B']);
    expect(base.getItem(TEMP)).toBeNull();
  });

  it('连续顺序写入：每次都完整替换，读到的永远是最后一次提交的数据', () => {
    const deps = testDeps();
    for (let i = 0; i < 10; i++) {
      const res = saveStore(chainStore, [`v${i}`], {
        ...deps,
        id: () => `nonce-${i}`,
      });
      expect(res.ok).toBe(true);
      expect(loadStore(chainStore, deps).value).toEqual([`v${i}`]);
    }
    expect(deps.storage.getItem(TEMP)).toBeNull();
  });
});

// ---------- 存储完全抛错（未使用镜像适配器的原始 StorageLike） ----------

describe('底层存储始终抛错（安全网：永不阻塞应用）', () => {
  const broken: StorageLike = {
    getItem: () => {
      throw new Error('Access denied');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('Access denied');
    },
  };
  const deps: PersistenceDeps = {
    storage: broken,
    now: () => new Date('2026-09-26T08:00:00.000Z'),
    id: () => 'x',
  };

  it('读取不抛错：storageUnavailable=true 并返回默认值', () => {
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.storageUnavailable).toBe(true);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined).toEqual([]);

    const managed = loadManaged(regressionStore, deps);
    expect(managed.value).toEqual(EMPTY_STORE);
  });

  it('写入不抛错：返回 storageError，应用继续可用', () => {
    const res = saveStore(rulesStore, [RULE], deps);
    expect(res.ok).toBe(false);
    expect(res.storageError).toMatch(/Quota|denied/i);
    expect(res.memoryOnly).toBeUndefined();
    expect(() => loadManaged(rulesStore, deps).save([RULE])).not.toThrow();
  });
});

// ---------- 镜像适配器：可读但写失败（配额耗尽） ----------

describe('localStorage 可读但写入配额失败：粘滞降级到同一内存副本', () => {
  /**
   * 构造「磁盘上有旧规则、可正常读取，但任何写入（含临时键）都配额失败」的后端。
   * 读一直可用，但降级后适配器不会再读磁盘——用于断言「不混读磁盘旧值」。
   */
  function quotaBackend(oldRules: unknown): {
    backend: StorageLike;
    disk: Map<string, string>;
    setFails: { current: boolean };
  } {
    const disk = new Map<string, string>([
      [rulesStore.key, JSON.stringify(envelope(1, oldRules))],
    ]);
    const setFails = { current: true };
    const backend: StorageLike = {
      getItem: (k) => (disk.has(k) ? (disk.get(k) as string) : null),
      setItem: (k, v) => {
        if (setFails.current) throw new Error('QuotaExceededError');
        disk.set(k, v);
      },
      removeItem: (k) => void disk.delete(k),
    };
    return { backend, disk, setFails };
  }

  function depsWith(storage: StorageLike): PersistenceDeps {
    return {
      storage,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      id: () => 'id-1',
    };
  }

  it('镜像已成功读入的磁盘数据；写配额失败后保存仍成功并标记 memoryOnly', () => {
    const { backend, disk } = quotaBackend([RULE]);
    const storage = createFallbackStorage(backend);
    const deps = depsWith(storage);

    // 首次加载读到旧规则，镜像同步建立
    const first = loadStore(rulesStore, deps);
    expect(first.value).toEqual([RULE]);
    expect(first.storageUnavailable).toBe(false);
    expect(storage.degraded).toBe(false);

    const next: Rule[] = [{ ...RULE, id: 'r2', name: '规则二' }];
    const res = saveStore(rulesStore, next, deps);
    // 不再报「临时键写入后读回为空」：整套装保在内存副本中完成
    expect(res.ok).toBe(true);
    expect(res.memoryOnly).toBe(true);
    expect(res.storageError).toBeUndefined();
    expect(storage.degraded).toBe(true);

    // 磁盘主键保持旧值（写不进去），临时键也不在磁盘上
    expect(JSON.parse(disk.get(rulesStore.key) as string).data).toEqual([RULE]);
    expect(disk.has(rulesStore.key + '.__tmp__')).toBe(false);
  });

  it('成功保存后同页重读得到最新值，绝不再混读磁盘旧规则', () => {
    const { backend } = quotaBackend([RULE]);
    const storage = createFallbackStorage(backend);
    const deps = depsWith(storage);

    loadStore(rulesStore, deps);
    const next: Rule[] = [{ ...RULE, id: 'r2', name: '规则二' }];
    expect(saveStore(rulesStore, next, deps).ok).toBe(true);

    // 适配器直读：主键是新信封，临时键已清理
    const main = JSON.parse(storage.getItem(rulesStore.key) as string);
    expect(main.data).toEqual(next);
    expect(storage.getItem(rulesStore.key + '.__tmp__')).toBeNull();

    // 完整加载路径同样得到最新值，且没有触发临时键恢复 / 隔离
    const reloaded = loadStore(rulesStore, deps);
    expect(reloaded.value).toEqual(next);
    expect(reloaded.recoveredFromTemp).toBe(false);
    expect(reloaded.quarantined).toEqual([]);
    expect(reloaded.storageUnavailable).toBe(false);

    // 再保存第三份：持续使用同一内存副本
    const third: Rule[] = [{ ...RULE, id: 'r3', name: '规则三' }];
    const res3 = saveStore(rulesStore, third, deps);
    expect(res3.ok).toBe(true);
    expect(res3.memoryOnly).toBe(true);
    expect(loadStore(rulesStore, deps).value).toEqual(third);
  });

  it('删除操作在内存副本生效，磁盘旧值不会让已删除键复活', () => {
    const { backend } = quotaBackend([RULE]);
    const storage = createFallbackStorage(backend);
    const deps = depsWith(storage);
    loadStore(rulesStore, deps);

    // 删主键（后端删除本会成功，但此前写失败已让适配器降级）
    expect(saveStore(rulesStore, [{ ...RULE, id: 'x' }], deps).ok).toBe(true);
    storage.removeItem(rulesStore.key);
    expect(storage.getItem(rulesStore.key)).toBeNull();
    // 即便此后直接改读磁盘也拿得到旧值，适配器也绝不返回它
    expect(backend.getItem(rulesStore.key)).not.toBeNull();
    expect(storage.getItem(rulesStore.key)).toBeNull();

    // 加载时以「键不存在」处理：回退默认值，而非磁盘上的旧规则
    const loaded = loadStore(rulesStore, deps);
    expect(loaded.value).toEqual(SAMPLE_RULES);
    expect(loaded.quarantined).toEqual([]);
  });

  it('规则表与回归数据共用同一适配器：一处降级，两处都在同一内存副本读写', () => {
    const disk = new Map<string, string>([
      [rulesStore.key, JSON.stringify(envelope(1, [RULE]))],
      [
        regressionStore.key,
        JSON.stringify(
          envelope(1, {
            baseline: null,
            cases: [{ id: 'c1', method: 'GET', url: 'http://x.com/a' }],
          }),
        ),
      ],
    ]);
    const quota: StorageLike = {
      getItem: (k) => (disk.has(k) ? (disk.get(k) as string) : null),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => void disk.delete(k),
    };
    const storage = createFallbackStorage(quota);
    const deps = depsWith(storage);

    // 两库各自读到磁盘数据（镜像建立）
    expect(loadStore(rulesStore, deps).value).toEqual([RULE]);
    expect(loadStore(regressionStore, deps).value.cases).toHaveLength(1);

    // 保存规则触发降级
    expect(saveStore(rulesStore, [{ ...RULE, id: 'r2' }], deps).memoryOnly).toBe(
      true,
    );

    // 回归数据的保存也在同一内存副本完成，读回为最新值，磁盘仍是旧值
    const regNext = {
      baseline: null,
      cases: [
        { id: 'c1', method: 'GET', url: 'http://x.com/a' },
        { id: 'c2', method: 'POST', url: 'http://x.com/b' },
      ],
    };
    const regRes = saveStore(regressionStore, regNext, deps);
    expect(regRes.ok).toBe(true);
    expect(regRes.memoryOnly).toBe(true);
    expect(loadStore(regressionStore, deps).value.cases.map((c) => c.id)).toEqual([
      'c1',
      'c2',
    ]);
    const diskReg = JSON.parse(disk.get(regressionStore.key) as string);
    expect(diskReg.data.cases).toHaveLength(1);

    // 规则同页重读仍是降级保存的值
    expect(loadStore(rulesStore, deps).value[0].id).toBe('r2');
  });

  it('降级是粘滞的：即使后端写能力恢复，本页面也不再触碰磁盘', () => {
    const { backend, disk, setFails } = quotaBackend([RULE]);
    const storage = createFallbackStorage(backend);
    const deps = depsWith(storage);
    loadStore(rulesStore, deps);

    expect(saveStore(rulesStore, [{ ...RULE, id: 'r2' }], deps).ok).toBe(true);
    expect(storage.degraded).toBe(true);

    // 后端恢复可写（如其他标签页清出了配额），本页仍只用内存副本
    setFails.current = false;
    storage.setItem(rulesStore.key, JSON.stringify(envelope(1, [{ ...RULE, id: 'r3' }])));
    expect(JSON.parse(disk.get(rulesStore.key) as string).data[0].id).toBe('r1');
    expect(loadStore(rulesStore, deps).value[0].id).toBe('r3');
  });

  it('降级状态通过订阅实时通知，健康快照引用稳定', () => {
    const { backend } = quotaBackend([RULE]);
    const storage = createFallbackStorage(backend);
    const deps = depsWith(storage);

    const listener = vi.fn();
    const off = storage.onDegrade(listener);
    loadStore(rulesStore, deps);
    expect(listener).not.toHaveBeenCalled();

    saveStore(rulesStore, [{ ...RULE, id: 'r2' }], deps);
    expect(listener).toHaveBeenCalledTimes(1);
    // 已降级后继续出错不重复通知
    saveStore(rulesStore, [{ ...RULE, id: 'r3' }], deps);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('全新存储（磁盘无该键）首次写入即配额失败：内存中仍可完整保存与重读', () => {
    const disk = new Map<string, string>();
    const quota: StorageLike = {
      getItem: (k) => (disk.has(k) ? (disk.get(k) as string) : null),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => void disk.delete(k),
    };
    const storage = createFallbackStorage(quota);
    const deps = depsWith(storage);

    const first = loadStore(rulesStore, deps);
    expect(first.value).toEqual(SAMPLE_RULES);
    // 尚未发生任何错误：不是降级导致的不可用
    expect(first.storageUnavailable).toBe(false);

    const res = saveStore(rulesStore, [RULE], deps);
    expect(res.ok).toBe(true);
    expect(res.memoryOnly).toBe(true);
    expect(loadStore(rulesStore, deps).value).toEqual([RULE]);
  });

  it('读抛错（隐私模式拒绝访问）：镜像为空时 storageUnavailable=true，降级后保存进内存', () => {
    const disk = new Map<string, string>();
    let readsFail = true;
    const privacy: StorageLike = {
      getItem: (k) => {
        if (readsFail) throw new Error('Access denied');
        return disk.has(k) ? (disk.get(k) as string) : null;
      },
      setItem: (k, v) => disk.set(k, v),
      removeItem: (k) => void disk.delete(k),
    };
    const storage = createFallbackStorage(privacy);
    const deps = depsWith(storage);

    const first = loadStore(rulesStore, deps);
    expect(first.storageUnavailable).toBe(true);
    expect(first.value).toEqual(SAMPLE_RULES);
    expect(storage.degraded).toBe(true);

    // 降级后即使后端读恢复，本页也只用内存副本；保存 / 重读在内存中闭环
    readsFail = false;
    const res = saveStore(rulesStore, [RULE], deps);
    expect(res.ok).toBe(true);
    expect(res.memoryOnly).toBe(true);
    expect(loadStore(rulesStore, deps).value).toEqual([RULE]);
  });

  it('正常存储下不标记 memoryOnly，健康状态保持未降级', () => {
    const storage = createFallbackStorage(createMemoryStorage());
    const deps = depsWith(storage);
    const res = saveStore(rulesStore, [RULE], deps);
    expect(res.ok).toBe(true);
    expect(res.memoryOnly).toBe(false);
    expect(storage.degraded).toBe(false);
    expect(getStorageHealth().degraded).toBe(false);
  });
});

// ---------- 默认健康 API（默认适配器为单例，只验证导出形态与订阅注销） ----------

describe('默认存储健康订阅', () => {
  it('subscribeStorageHealth 返回注销函数，getStorageHealth 形态稳定', () => {
    const snapshot1 = getStorageHealth();
    const snapshot2 = getStorageHealth();
    expect(snapshot2).toBe(snapshot1);
    expect(typeof snapshot2.degraded).toBe('boolean');
    const off = subscribeStorageHealth(() => undefined);
    expect(typeof off).toBe('function');
    off();
  });
});

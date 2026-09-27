import { simulate } from './engine';
import type { Rule, Simulation } from './types';
import { outcomeEqual } from './regression';

/** 参与缩减的一条已启用规则：附带生成时刻它在原规则表中的下标，便于按原顺序展示 */
export interface MinimizeEntry {
  /** 生成时刻规则在原表中的下标（0 起） */
  index: number;
  rule: Rule;
}

export type MinimizeStatus =
  | 'reduced' // 缩减成功（允许「没有一条可剔除」的结果，此时保留集等于全部已启用规则）
  | 'no-hit' // 原始请求没有任何规则命中，无法缩减
  | 'invalid-url'; // 输入 URL 非法，无法缩减

export interface MinimizeReport {
  status: MinimizeStatus;
  /** 生成时冻结的请求方法（已规范化大写） */
  method: string;
  /** 生成时冻结的 URL 原文 */
  inputUrl: string;
  /** 生成时冻结的规则表总条数（含未启用） */
  ruleCount: number;
  /** 复用 simulate 取得的原始结果（全部规则、原始请求） */
  original: Simulation;
  /** 缩减后保留的规则，按原规则表顺序排列 */
  retained: MinimizeEntry[];
  /** 被剔除的已启用规则，按原规则表顺序排列 */
  removed: MinimizeEntry[];
  /** 未启用、自始不参与匹配的规则，按原规则表顺序排列（仅供展示） */
  disabled: MinimizeEntry[];
  /** 缩减后仅用保留规则重新完整模拟的结果；无法缩减时为 null */
  reduced: Simulation | null;
  /** 试探次数：缩减过程中重新完整模拟的次数（不含取得原始结果与最终复核） */
  attempts: number;
}

/**
 * 把数组按顺序切成至多 n 个连续、非空且尽量等长的块（n >= 1）。
 * 多余的余数逐个分给前面的块。
 */
function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  const len = items.length;
  const base = Math.floor(len / n);
  const extra = len % n;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
}

/**
 * 请求最小复现（规则缩减，ddmin 风格的分块删除试探）：
 *
 * 对**当前已启用**规则按原顺序做试探，目标是找到一个最小子集——仅用它重新完整模拟
 * （{@link simulate}）给定请求，可观察结果与原始结果一致，且任意单条删除都会改变
 * 可观察结果。可观察结果的判定与回归对比完全一致（{@link outcomeEqual}）：
 * 终止类型须相同；`final` 比较最终 URL，`redirect` 比较状态码与 Location，
 * 其余类型（`stopped` 及各类失败）只比较终止类型。
 *
 * 每轮把当前候选切成 n 个连续块：
 * 1. **分块删除试探**：逐块剔除后重新完整模拟，结果不变就永久剔除该块并从 n=2 重来；
 * 2. **逐条复核**（n 小于候选条数时）：逐块「只保留该块」模拟，结果不变则把候选收缩
 *    到该块（等价于一次性剔除其余各条），同样从 n=2 重来；
 * 3. 本轮两阶段都无可剔除时收紧粒度（n 翻倍，直到等于候选条数）。
 *
 * 每次试探都是**从头完整模拟**（不做任何轨迹复用 / 重写），因此允许命中轨迹改变——
 * 剔除规则后首个命中转移、重写链改道等都不会造成误判，唯一标准是可观察结果一致。
 * 粒度收紧到单条后，每一条的单独删除都使结果改变，即达到「任意单条删除都会改变
 * 可观察结果」的终止条件。
 *
 * 原始结果为 URL 非法（`invalid-url`）或没有任何规则命中（0 步 `final`）时无法缩减，
 * 返回对应状态。未启用规则不参与匹配，原样列入 `disabled` 供展示。
 */
export function minimizeRules(
  rules: Rule[],
  method: string,
  inputUrl: string,
): MinimizeReport {
  // 冻结规则快照：生成期间 / 之后对规则表的编辑都不影响本次结果
  const snapshot = structuredClone(rules);
  const m = method.toUpperCase();
  const original = simulate(snapshot, m, inputUrl);

  const all: MinimizeEntry[] = snapshot.map((rule, index) => ({ index, rule }));
  const disabled = all.filter((e) => !e.rule.enabled);
  const base = {
    method: m,
    inputUrl,
    ruleCount: snapshot.length,
    original,
    disabled,
  };

  if (original.status === 'invalid-url') {
    return {
      ...base,
      status: 'invalid-url',
      retained: [],
      removed: [],
      reduced: null,
      attempts: 0,
    };
  }
  if (original.status === 'final' && original.steps.length === 0) {
    return {
      ...base,
      status: 'no-hit',
      retained: [],
      removed: [],
      reduced: null,
      attempts: 0,
    };
  }

  // 只对已启用规则做删除试探；未启用规则本来就不参与匹配
  let cur = all.filter((e) => e.rule.enabled);
  let n = 2;
  let attempts = 0;

  // 每次试探都重新完整模拟；允许命中轨迹改变，只比对可观察结果
  const probe = (keep: MinimizeEntry[]): Simulation => {
    attempts += 1;
    return simulate(
      keep.map((e) => e.rule),
      m,
      inputUrl,
    );
  };

  outer: while (cur.length > 0) {
    const chunks = chunk(cur, Math.min(n, cur.length));

    // 阶段 1：分块删除试探——逐块剔除，结果不变即永久剔除
    for (const c of chunks) {
      const keep = cur.filter((e) => !c.includes(e));
      if (keep.length > 0 && outcomeEqual(original, probe(keep))) {
        cur = keep;
        n = 2;
        continue outer;
      }
    }

    // 阶段 2：逐条复核——逐块只保留，结果不变则把候选收缩到该块。
    // n 已等于候选条数时，单块保留与阶段 1 的单块删除互为补集，无需重复试探。
    if (n < cur.length) {
      for (const c of chunks) {
        if (outcomeEqual(original, probe(c))) {
          cur = c;
          n = 2;
          continue outer;
        }
      }
    }

    // 本轮两阶段都无可剔除：收紧粒度；已是单条粒度则每条都必要，终止
    if (n >= cur.length) break;
    n = Math.min(cur.length, n * 2);
  }

  const keptIndexes = new Set(cur.map((e) => e.index));
  const active = all.filter((e) => e.rule.enabled);
  const retained = active.filter((e) => keptIndexes.has(e.index));
  const removed = active.filter((e) => !keptIndexes.has(e.index));
  // 最终复核：仅用保留规则完整模拟一次，用于展示缩减后轨迹
  const reduced = simulate(
    cur.map((e) => e.rule),
    m,
    inputUrl,
  );

  return {
    ...base,
    status: 'reduced',
    retained,
    removed,
    reduced,
    attempts,
  };
}

import type { Rule, Simulation, Step } from './types';
import { REQUEST_METHODS } from './types';
import { simulate } from './engine';
import { uid, validateRules } from './validate';

/** 回归用例：一次「方法 + URL」请求 */
export interface RegressionCase {
  id: string;
  method: string;
  url: string;
}

/** 基线：冻结时刻的规则表深拷贝，之后的编辑不影响它 */
export interface Baseline {
  rules: Rule[];
  /** ISO 时间戳，仅用于展示 */
  frozenAt: string;
}

/** 回归面板的持久化结构 */
export interface RegressionStore {
  baseline: Baseline | null;
  cases: RegressionCase[];
}

export const EMPTY_STORE: RegressionStore = { baseline: null, cases: [] };

/** 冻结当前规则为基线（深拷贝，之后对规则表的任何编辑都不影响基线） */
export function freezeBaseline(rules: Rule[]): Baseline {
  return { rules: structuredClone(rules), frozenAt: new Date().toISOString() };
}

/**
 * 可观察结果是否一致（判定「是否变化」的唯一标准）：
 * - final：比较 finalUrl
 * - redirect：比较状态码与 Location
 * - stopped：仅比较终止类型
 * - 失败（loop / max-steps / invalid-url / invalid-target）：仅比较失败类型
 * 不比较 reason 等原因文案。
 */
export function outcomeEqual(a: Simulation, b: Simulation): boolean {
  if (a.status !== b.status) return false;
  switch (a.status) {
    case 'final':
      return a.finalUrl === b.finalUrl;
    case 'redirect':
      return (
        a.redirectStatus === b.redirectStatus &&
        a.redirectLocation === b.redirectLocation
      );
    default:
      // stopped 与各类失败：终止类型相同即视为一致
      return true;
  }
}

/** 单步的动作结果标识：rewrite 看重写后 URL，redirect 看状态码与 Location，stop 无额外结果 */
export function stepActionOutcome(step: Step): string {
  switch (step.rule.action.type) {
    case 'rewrite':
      return `rewrite→${step.urlAfter ?? ''}`;
    case 'redirect':
      return `redirect:${step.status ?? ''}→${step.location ?? ''}`;
    case 'stop':
      return 'stop';
  }
}

/** 逐步对齐的比较单位：命中规则的 id、命中前 URL、动作结果 */
export function sameStep(a: Step, b: Step): boolean {
  return (
    a.rule.id === b.rule.id &&
    a.urlBefore === b.urlBefore &&
    stepActionOutcome(a) === stepActionOutcome(b)
  );
}

export interface TraceDivergence {
  /** 首个差异步的下标（0 起）；长度不同则等于较短轨迹的步数 */
  index: number;
  /** step：同位置步内容不同；baseline-longer / current-longer：一方轨迹更长 */
  kind: 'step' | 'baseline-longer' | 'current-longer';
}

/** 定位两条轨迹的首个差异；完全一致返回 null */
export function firstDivergence(
  baseline: Step[],
  current: Step[],
): TraceDivergence | null {
  const n = Math.min(baseline.length, current.length);
  for (let i = 0; i < n; i++) {
    if (!sameStep(baseline[i], current[i])) return { index: i, kind: 'step' };
  }
  if (baseline.length !== current.length) {
    return {
      index: n,
      kind: baseline.length > current.length ? 'baseline-longer' : 'current-longer',
    };
  }
  return null;
}

export interface CaseRun {
  testCase: RegressionCase;
  baseline: Simulation;
  current: Simulation;
  changed: boolean;
  /** 仅 changed 时有意义：两侧轨迹的首个差异 */
  divergence: TraceDivergence | null;
}

/** 用同一 simulate 引擎分别运行基线与当前规则，逐用例对比 */
export function runRegression(
  cases: RegressionCase[],
  baselineRules: Rule[],
  currentRules: Rule[],
): CaseRun[] {
  return cases.map((testCase) => {
    const baseline = simulate(baselineRules, testCase.method, testCase.url);
    const current = simulate(currentRules, testCase.method, testCase.url);
    const changed = !outcomeEqual(baseline, current);
    return {
      testCase,
      baseline,
      current,
      changed,
      divergence: changed ? firstDivergence(baseline.steps, current.steps) : null,
    };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验并规范化持久化的回归数据。
 * 任何损坏都回退为空（基线 null、用例为空），绝不抛出，也不影响规则表数据。
 */
export function validateRegressionStore(data: unknown): RegressionStore {
  if (!isRecord(data)) return { baseline: null, cases: [] };

  const cases: RegressionCase[] = [];
  if (Array.isArray(data.cases)) {
    for (const raw of data.cases) {
      if (!isRecord(raw)) continue;
      const { method, url } = raw;
      if (
        typeof method !== 'string' ||
        !(REQUEST_METHODS as readonly string[]).includes(method)
      ) {
        continue;
      }
      if (typeof url !== 'string' || url.trim() === '') continue;
      cases.push({
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : uid(),
        method,
        url,
      });
    }
  }

  let baseline: Baseline | null = null;
  if (isRecord(data.baseline)) {
    try {
      baseline = {
        rules: validateRules(data.baseline.rules),
        frozenAt: typeof data.baseline.frozenAt === 'string' ? data.baseline.frozenAt : '',
      };
    } catch {
      baseline = null; // 基线损坏：仅丢弃基线，保留用例
    }
  }

  return { baseline, cases };
}

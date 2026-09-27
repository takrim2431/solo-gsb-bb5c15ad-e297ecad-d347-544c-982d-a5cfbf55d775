import type { MethodMatcher, QueryCondition, Rule } from './types';
import { matchHost } from './engine';

/**
 * 遮蔽诊断（纯分析，不参与模拟执行）：
 * 按规则表顺序，若某条已启用规则的全部可匹配请求都被它之前的
 * 某一条已启用规则完全覆盖，则该规则「不可达」。
 * 覆盖判定与引擎的匹配语义一一对应；只报告完整覆盖，部分交集不告警。
 */

/** 方法覆盖：ANY 覆盖任意方法（含 ANY），具体方法仅覆盖相同方法 */
export function methodCovers(upper: MethodMatcher, lower: MethodMatcher): boolean {
  return upper === 'ANY' || upper === lower;
}

/**
 * 主机覆盖（upper 的模式是否涵盖 lower 模式能匹配的所有主机）：
 * - `*` 覆盖任意主机模式；
 * - `*.example.com` 覆盖其至少一级子域（含更深层通配 `*.sub.example.com`），
 *   但不覆盖裸域 `example.com`——与 matchHost 的语义一致；
 * - 具体主机仅覆盖相同主机（忽略大小写）；
 * - 空主机模式匹配不到任何请求，不参与遮蔽判定。
 */
export function hostCovers(upper: string, lower: string): boolean {
  const u = upper.trim().toLowerCase();
  const l = lower.trim().toLowerCase();
  if (u === '' || l === '') return false;
  if (u === '*') return true;
  if (l === '*') return false;
  if (l.startsWith('*.')) {
    // 下层仍是通配子域：上层必须也是通配子域，且后缀涵盖下层后缀
    return u.startsWith('*.') && l.slice(1).endsWith(u.slice(1));
  }
  // 下层是具体主机：直接复用引擎的主机匹配语义
  return matchHost(u, l);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type PathSeg = { kind: 'param' } | { kind: 'literal'; value: string };

/**
 * 解析具体路径模板为段序列（与 matchPath 一样按 `/` 分段、忽略空段）。
 * 返回 null 表示模板含空名参数段（`:`），按引擎语义永不命中。
 */
function parsePathSegs(template: string): PathSeg[] | null {
  const segs: PathSeg[] = [];
  for (const raw of template.split('/')) {
    if (raw === '') continue;
    if (raw.startsWith(':')) {
      if (raw.length === 1) return null;
      segs.push({ kind: 'param' });
    } else {
      segs.push({ kind: 'literal', value: safeDecode(raw) });
    }
  }
  return segs;
}

/**
 * 路径覆盖（upper 模板是否涵盖 lower 模板能匹配的所有路径）：
 * - 空值或 `*` 覆盖任意路径；
 * - 具体模板按分段比较：段数必须一致，参数段覆盖同位任意单段，
 *   字面段仅覆盖相同字面值（与 matchPath 一样对百分号编码宽容）；
 * - 具体模板覆盖不了「任意路径」（空值 / `*`）。
 */
export function pathCovers(upper: string, lower: string): boolean {
  const u = upper.trim();
  const l = lower.trim();
  if (u === '' || u === '*') return true;
  if (l === '' || l === '*') return false;
  const uSegs = parsePathSegs(u);
  const lSegs = parsePathSegs(l);
  if (uSegs === null || lSegs === null) return false;
  if (uSegs.length !== lSegs.length) return false;
  return uSegs.every((us, i) => {
    if (us.kind === 'param') return true;
    const ls = lSegs[i];
    return ls.kind === 'literal' && ls.value === us.value;
  });
}

/**
 * 单条查询条件的蕴含：下层条件成立时，上层条件是否必然成立（同名参数才相关）。
 * 与 matchQuery 的语义一一对应：
 * - 上层的「存在」被下层的「存在」或「值等于」蕴含（有相等值必然存在）；
 * - 上层的「不存在」仅被下层的「不存在」蕴含；
 * - 上层的「值等于 v」仅被下层同值的「值等于 v」蕴含
 *   （下层命中即保证同名参数含 v，上层随之命中）。
 */
function conditionImplies(lower: QueryCondition, upper: QueryCondition): boolean {
  if (lower.name !== upper.name) return false;
  switch (upper.op) {
    case 'exists':
      return lower.op === 'exists' || lower.op === 'equals';
    case 'not-exists':
      return lower.op === 'not-exists';
    case 'equals':
      return lower.op === 'equals' && lower.value === upper.value;
  }
}

/**
 * 查询条件覆盖（upper 的条件集是否涵盖 lower 条件集能匹配的所有查询串）：
 * upper 的每条条件都要被 lower 的某条同名条件蕴含；
 * upper 无条件（空数组）时覆盖任意查询条件组合。
 */
export function queryCovers(upper: QueryCondition[], lower: QueryCondition[]): boolean {
  return upper.every((u) => lower.some((l) => conditionImplies(l, u)));
}

/** 规则级覆盖：方法、主机、路径、查询条件四项同时覆盖才算完整覆盖 */
export function ruleCovers(upper: Rule, lower: Rule): boolean {
  return (
    methodCovers(upper.method, lower.method) &&
    hostCovers(upper.host, lower.host) &&
    pathCovers(upper.pathTemplate, lower.pathTemplate) &&
    queryCovers(upper.query ?? [], lower.query ?? [])
  );
}

/** 单个维度的覆盖依据：上（遮蔽方）与下（被遮蔽方）各自的模式原文 */
export interface CoverBasis<T> {
  upper: T;
  lower: T;
}

/** 一条「不可达」诊断：被遮蔽规则、首个遮蔽它的规则，以及四项覆盖依据 */
export interface ShadowReport {
  ruleId: string;
  /** 被遮蔽规则在完整规则表中的下标 */
  ruleIndex: number;
  byRuleId: string;
  /** 首个遮蔽它的规则在完整规则表中的下标 */
  byRuleIndex: number;
  byRuleName: string;
  basis: {
    method: CoverBasis<MethodMatcher>;
    host: CoverBasis<string>;
    path: CoverBasis<string>;
    query: CoverBasis<QueryCondition[]>;
  };
}

/**
 * 分析整张规则表：仅已启用规则参与（既不遮蔽别人也不被诊断）；
 * 对每条已启用规则，找它之前第一条完整覆盖它的已启用规则。
 * 返回的每条报告对应一条不可达规则。
 */
export function analyzeShadowing(rules: Rule[]): ShadowReport[] {
  const enabled: { rule: Rule; index: number }[] = [];
  rules.forEach((rule, index) => {
    if (rule.enabled) enabled.push({ rule, index });
  });

  const reports: ShadowReport[] = [];
  for (let i = 0; i < enabled.length; i++) {
    const lower = enabled[i];
    for (let j = 0; j < i; j++) {
      const upper = enabled[j];
      if (ruleCovers(upper.rule, lower.rule)) {
        reports.push({
          ruleId: lower.rule.id,
          ruleIndex: lower.index,
          byRuleId: upper.rule.id,
          byRuleIndex: upper.index,
          byRuleName: upper.rule.name,
          basis: {
            method: { upper: upper.rule.method, lower: lower.rule.method },
            host: { upper: upper.rule.host, lower: lower.rule.host },
            path: { upper: upper.rule.pathTemplate, lower: lower.rule.pathTemplate },
            query: {
              upper: upper.rule.query ?? [],
              lower: lower.rule.query ?? [],
            },
          },
        });
        break; // 只报告首个遮蔽它的规则
      }
    }
  }
  return reports;
}

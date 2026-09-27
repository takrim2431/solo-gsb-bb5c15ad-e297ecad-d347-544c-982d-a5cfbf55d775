import type { Rule, Simulation, SimulationStatus, Step } from './types';
import { REQUEST_METHODS } from './types';
import { simulate } from './engine';
import { uid } from './validate';

/** 一条粘贴的「METHOD URL」样本（逐行解析后的结果） */
export interface CoverageSample {
  id: string;
  /** 原文行号（1 起，空行也占号），便于在粘贴内容中定位 */
  line: number;
  /** 去除首尾空白后的原始行文本 */
  raw: string;
  /** 解析出的方法（已转大写）；解析失败为 null */
  method: string | null;
  /** 解析出的 URL 原文；解析失败为 null */
  url: string | null;
  /** 非 null 表示该行无法作为样本运行（方法缺失 / 非法、URL 缺失或含空白等） */
  parseError: string | null;
}

/** 行解析失败在审计中的状态（engine 的 SimulationStatus 之外的补充状态） */
export type CoverageStatus = SimulationStatus | 'invalid-input';

export interface CoverageSampleResult {
  sample: CoverageSample;
  status: CoverageStatus;
  /** invalid-input（行解析失败）时为 null；其余为 simulate 跑出来的完整结果 */
  sim: Simulation | null;
  /** 中文原因：解析错误直接取 parseError，运行结果取 Simulation.reason */
  reason: string;
}

/** 某条规则在单条样本中的命中明细 */
export interface CoverageRuleHit {
  sampleId: string;
  /** 该样本轨迹中命中本规则的步骤（重写绕回时可能有多条） */
  steps: Step[];
}

export interface CoverageRuleStat {
  ruleId: string;
  /** 运行时刻的规则序号（0 起），来自运行时的规则快照 */
  index: number;
  name: string;
  enabled: boolean;
  /** 命中本规则的不同样本数——同一请求因重写重复命中只计一次 */
  requestCount: number;
  /** 累计执行次数——每命中一个步骤计一次，重复命中累加 */
  executionCount: number;
  /** 命中明细，按样本顺序排列 */
  hits: CoverageRuleHit[];
}

export interface CoverageReport {
  /** 全部样本的运行结果，按粘贴行顺序 */
  results: CoverageSampleResult[];
  /** 按运行时规则表顺序的逐条统计（含 0 命中与停用规则） */
  ruleStats: CoverageRuleStat[];
  /** 未命中任何规则：final 且没有任何步骤（原始请求直接放行） */
  unmatched: CoverageSampleResult[];
  /** 检测到循环的样本 */
  loops: CoverageSampleResult[];
  /** 超过 20 步上限的样本 */
  maxSteps: CoverageSampleResult[];
  /** 非法输入：行解析失败或 URL 无法解析 */
  invalid: CoverageSampleResult[];
  /** 规则目标无法解析（规则配置问题，与样本本身的非法输入区分） */
  invalidTarget: CoverageSampleResult[];
}

/**
 * 解析多行「METHOD URL」样本：
 * - 空行（含纯空白行）跳过，不占样本序号，但行号仍按原文计算；
 * - 每行以首个空白分隔方法与 URL，方法大小写不敏感（get → GET）；
 * - 方法必须是具体 HTTP 方法（不能是 ANY），URL 不得含空白；
 * - URL 是否可解析交由 simulate 判定（invalid-url），这里只做词法切分。
 */
export function parseSamples(text: string): CoverageSample[] {
  const out: CoverageSample[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const raw = line.trim();
    if (raw === '') return;
    const base = { id: uid(), line: i + 1, raw };
    const parts = raw.split(/\s+/);
    if (parts.length < 2) {
      out.push({
        ...base,
        method: null,
        url: null,
        parseError: '格式应为「METHOD URL」，方法与 URL 之间以空白分隔',
      });
      return;
    }
    const method = parts[0].toUpperCase();
    if (!(REQUEST_METHODS as readonly string[]).includes(method)) {
      out.push({
        ...base,
        method: null,
        url: null,
        parseError: `不支持的请求方法「${parts[0]}」（应为 ${REQUEST_METHODS.join(' / ')} 之一）`,
      });
      return;
    }
    if (parts.length > 2) {
      out.push({
        ...base,
        method,
        url: null,
        parseError: 'URL 中不能包含空白字符',
      });
      return;
    }
    out.push({ ...base, method, url: parts[1], parseError: null });
  });
  return out;
}

/**
 * 批量运行访问样本覆盖审计：复用 {@link simulate} 逐条跑当前规则，
 * 再按规则聚合命中请求数（去重）与执行次数（累加），
 * 并挑出未命中任何规则、循环、超限、非法输入 / 目标的样本。
 */
export function runCoverageAudit(
  samples: CoverageSample[],
  rules: Rule[],
): CoverageReport {
  const results: CoverageSampleResult[] = samples.map((sample) => {
    if (sample.parseError || sample.method === null || sample.url === null) {
      return {
        sample,
        status: 'invalid-input',
        sim: null,
        reason: sample.parseError ?? '非法输入',
      };
    }
    const sim = simulate(rules, sample.method, sample.url);
    return { sample, status: sim.status, sim, reason: sim.reason };
  });

  // 以运行时刻的规则表初始化统计：0 命中 / 停用规则也要出现在覆盖清单里
  const stats = new Map<string, CoverageRuleStat>();
  rules.forEach((rule, index) => {
    stats.set(rule.id, {
      ruleId: rule.id,
      index,
      name: rule.name,
      enabled: rule.enabled,
      requestCount: 0,
      executionCount: 0,
      hits: [],
    });
  });

  for (const result of results) {
    if (!result.sim) continue;
    // 同一样本内已计入请求数的规则（重写绕回重复命中时只计一次请求）
    const countedRules = new Set<string>();
    for (const step of result.sim.steps) {
      let stat = stats.get(step.rule.id);
      if (!stat) {
        // 理论上不会发生（步骤就跑自这份规则表）；兜底保证统计不丢
        stat = {
          ruleId: step.rule.id,
          index: step.ruleIndex,
          name: step.rule.name,
          enabled: true,
          requestCount: 0,
          executionCount: 0,
          hits: [],
        };
        stats.set(step.rule.id, stat);
      }
      stat.executionCount += 1;
      let hit = stat.hits.find((h) => h.sampleId === result.sample.id);
      if (!hit) {
        hit = { sampleId: result.sample.id, steps: [] };
        stat.hits.push(hit);
      }
      hit.steps.push(step);
      if (!countedRules.has(stat.ruleId)) {
        countedRules.add(stat.ruleId);
        stat.requestCount += 1;
      }
    }
  }

  const ruleStats = [...stats.values()];

  return {
    results,
    ruleStats,
    unmatched: results.filter(
      (r) => r.status === 'final' && r.sim !== null && r.sim.steps.length === 0,
    ),
    loops: results.filter((r) => r.status === 'loop'),
    maxSteps: results.filter((r) => r.status === 'max-steps'),
    invalid: results.filter(
      (r) => r.status === 'invalid-input' || r.status === 'invalid-url',
    ),
    invalidTarget: results.filter((r) => r.status === 'invalid-target'),
  };
}

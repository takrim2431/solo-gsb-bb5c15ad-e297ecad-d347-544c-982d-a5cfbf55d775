import type { MethodMatcher, QueryCondition, Rule } from './types';
import { REQUEST_METHODS } from './types';
import { findMatch, matchHost, matchPath, matchQuery } from './engine';
import { ruleCovers } from './shadow';

/**
 * 部分交集见证（纯分析，不参与模拟执行、不修改规则表）：
 * 在已启用规则中找出「存在共同请求、但双方都不能完整覆盖对方」的规则对，
 * 对方法、主机、路径段与查询条件分别求交，构造一条两条规则都能命中的
 * 「METHOD URL」作为见证，并按当前规则表顺序指出实际先命中的规则
 * （可能是对中更早的一条，也可能是更早的第三条规则）。
 *
 * 各维度求交语义与 engine / shadow 的匹配语义一一对应。
 */

type MethodIntersection = MethodMatcher | null;

/**
 * 方法求交：两个具体方法相同则取该方法；任一为 ANY 时取另一个
 * （两个 ANY 取一个确定的具体方法 GET，因为见证必须是可发出的请求）；
 * 不同具体方法无交集。
 */
export function intersectMethod(a: MethodMatcher, b: MethodMatcher): MethodIntersection {
  if (a === b) return a === 'ANY' ? 'GET' : a;
  if (a === 'ANY') return b;
  if (b === 'ANY') return a;
  return null;
}

type HostPattern =
  | { kind: 'all' }
  | { kind: 'wild'; suffix: string } // suffix 含前导点，如 ".example.com"
  | { kind: 'exact'; value: string };

/** 规范化主机模式：空模式匹配不到任何请求（与 matchHost 一致），返回 null */
function normalizeHost(pattern: string): HostPattern | null {
  const p = pattern.trim().toLowerCase();
  if (p === '') return null;
  if (p === '*') return { kind: 'all' };
  if (p.startsWith('*.')) return { kind: 'wild', suffix: p.slice(1) };
  return { kind: 'exact', value: p };
}

/** 为通配后缀取至少一级子域的见证主机（与 matchHost 的长度判定一致） */
function wildcardWitness(suffix: string): string {
  return `w${suffix}`;
}

/**
 * 主机求交：返回一个同时满足两个模式的具体主机名（小写原文）；无交集返回 null。
 * - `*` 与任意模式有交：见证取对方（对方也是 `*` 时取 example.com）；
 * - 两个通配子域：后缀相同取一个子域；后缀为祖孙关系（如 `.sub.example.com`
 *   与 `.example.com`）取更深后缀下的至少一级子域；否则无交集；
 * - 通配子域 + 具体主机：具体主机必须是其至少一级子域（不含裸域）；
 * - 两个具体主机：必须相同。
 */
export function intersectHost(a: string, b: string): string | null {
  const pa = normalizeHost(a);
  const pb = normalizeHost(b);
  if (pa === null || pb === null) return null;

  if (pa.kind === 'all') {
    if (pb.kind === 'all') return 'example.com';
    if (pb.kind === 'exact') return pb.value;
    return wildcardWitness(pb.suffix);
  }
  if (pb.kind === 'all') {
    if (pa.kind === 'exact') return pa.value;
    return wildcardWitness(pa.suffix);
  }

  if (pa.kind === 'wild' && pb.kind === 'wild') {
    if (pa.suffix === pb.suffix) return wildcardWitness(pa.suffix);
    // 点前缀的 endsWith 已排除裸域，更深的后缀本身即保证至少一级子域
    if (pa.suffix.endsWith(pb.suffix)) return wildcardWitness(pa.suffix);
    if (pb.suffix.endsWith(pa.suffix)) return wildcardWitness(pb.suffix);
    return null;
  }

  if (pa.kind === 'wild' && pb.kind === 'exact') {
    return pb.value.length > pa.suffix.length && pb.value.endsWith(pa.suffix)
      ? pb.value
      : null;
  }
  if (pb.kind === 'wild' && pa.kind === 'exact') {
    return pa.value.length > pb.suffix.length && pa.value.endsWith(pb.suffix)
      ? pa.value
      : null;
  }

  return pa.kind === 'exact' && pb.kind === 'exact' && pa.value === pb.value
    ? pa.value
    : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type PathSeg =
  | { kind: 'param'; name: string }
  | { kind: 'literal'; value: string };

/**
 * 解析具体路径模板（与 matchPath 一样按 `/` 分段、忽略空段）。
 * 含空名参数段（`:`）时按引擎语义永不命中，返回 null。
 */
function parsePathSegs(template: string): PathSeg[] | null {
  const segs: PathSeg[] = [];
  for (const raw of template.trim().split('/')) {
    if (raw === '') continue;
    if (raw.startsWith(':')) {
      const name = raw.slice(1);
      if (name === '') return null;
      segs.push({ kind: 'param', name });
    } else {
      segs.push({ kind: 'literal', value: safeDecode(raw) });
    }
  }
  return segs;
}

/** 具体模板的见证段取值：字面段取字面原文，参数段取参数名（空名兜底 x） */
function concreteWitnessSegs(segs: PathSeg[]): string[] {
  return segs.map((s) => (s.kind === 'literal' ? s.value : s.name || 'x'));
}

/**
 * 路径求交：返回一条同时满足两个模板的具体路径（以 `/` 开头的见证路径）；
 * 无交集返回 null。
 * - 留空或 `*` 匹配任意路径：与任意模板有交，见证取对方的具体化；
 *   两个都是任意路径时取 `/`；
 * - 两个具体模板：段数必须一致；同位两个字面段必须相等；
 *   参数段与字面段兼容（见证取字面值）；两个参数段取任一参数名。
 */
export function intersectPath(a: string, b: string): string | null {
  const ta = a.trim();
  const tb = b.trim();
  const aAny = ta === '' || ta === '*';
  const bAny = tb === '' || tb === '*';

  if (aAny && bAny) return '/';
  if (aAny) {
    const segs = parsePathSegs(tb);
    return segs === null ? null : '/' + concreteWitnessSegs(segs).map(encodeURIComponent).join('/');
  }
  if (bAny) {
    const segs = parsePathSegs(ta);
    return segs === null ? null : '/' + concreteWitnessSegs(segs).map(encodeURIComponent).join('/');
  }

  const aSegs = parsePathSegs(ta);
  const bSegs = parsePathSegs(tb);
  if (aSegs === null || bSegs === null) return null;
  if (aSegs.length !== bSegs.length) return null;

  const witness: string[] = [];
  for (let i = 0; i < aSegs.length; i++) {
    const sa = aSegs[i];
    const sb = bSegs[i];
    if (sa.kind === 'literal' && sb.kind === 'literal') {
      if (sa.value !== sb.value) return null;
      witness.push(sa.value);
    } else if (sa.kind === 'literal') {
      witness.push(sa.value);
    } else if (sb.kind === 'literal') {
      witness.push(sb.value);
    } else {
      witness.push(sa.name || sb.name || 'x');
    }
  }
  return '/' + witness.map(encodeURIComponent).join('/');
}

/** 单条规则的查询条件模型（同名条件在规则内按 AND 组合） */
interface QueryModel {
  /** 自身矛盾（同名既要求不存在又要求存在 / 等于）时该规则谁都命中不了 */
  satisfiable: boolean;
  notExists: Set<string>;
  /** 要求出现的参数名 -> 是否仅要求存在 / 需要同时出现的值列表 */
  required: Map<string, { existsOnly: boolean; values: string[] }>;
}

function buildQueryModel(conds: QueryCondition[]): QueryModel {
  const notExists = new Set<string>();
  const required = new Map<string, { existsOnly: boolean; values: string[] }>();
  for (const cond of conds) {
    if (cond.op === 'not-exists') {
      notExists.add(cond.name);
      continue;
    }
    let entry = required.get(cond.name);
    if (!entry) {
      entry = { existsOnly: false, values: [] };
      required.set(cond.name, entry);
    }
    if (cond.op === 'exists') entry.existsOnly = true;
    else if (!entry.values.includes(cond.value)) entry.values.push(cond.value);
  }
  let satisfiable = true;
  for (const name of notExists) {
    if (required.has(name)) satisfiable = false;
  }
  return { satisfiable, notExists, required };
}

export interface WitnessQueryParam {
  name: string;
  value: string;
}

/**
 * 查询条件求交：返回一组让两套条件同时满足的查询参数（同名可重复）；
 * 无交集返回 null。
 * - 任一规则自身矛盾（同名 not-exists 又要求出现）即无交集；
 * - 一方要求某参数「不存在」、另一方要求它出现（exists / equals）即冲突；
 * - 双方不同的 equals 值用同名重复参数同时满足
 *   （?x=a&x=b 对 equals(a) 与 equals(b) 都命中）；
 * - 只要求存在时给一个非空占位值 1（空值也算存在，但 1 更直观）。
 */
export function intersectQuery(
  aConds: QueryCondition[],
  bConds: QueryCondition[],
): WitnessQueryParam[] | null {
  const a = buildQueryModel(aConds);
  const b = buildQueryModel(bConds);
  if (!a.satisfiable || !b.satisfiable) return null;

  const params: WitnessQueryParam[] = [];
  const names: string[] = [];
  for (const cond of [...aConds, ...bConds]) {
    if (!names.includes(cond.name)) names.push(cond.name);
  }

  for (const name of names) {
    const aMissing = a.notExists.has(name);
    const bMissing = b.notExists.has(name);
    const aReq = a.required.get(name);
    const bReq = b.required.get(name);
    if (aMissing || bMissing) {
      // 要求不出现的一方与要求出现的另一方冲突
      if ((aMissing && bReq) || (bMissing && aReq)) return null;
      continue;
    }
    if (!aReq && !bReq) continue;
    const values: string[] = [];
    for (const v of [...(aReq?.values ?? []), ...(bReq?.values ?? [])]) {
      if (!values.includes(v)) values.push(v);
    }
    if (values.length > 0) {
      for (const value of values) params.push({ name, value });
    } else {
      params.push({ name, value: '1' });
    }
  }
  return params;
}

/** 一条部分交集见证 */
export interface PartialIntersection {
  aRuleId: string;
  aIndex: number;
  aName: string;
  bRuleId: string;
  bIndex: number;
  bName: string;
  /** 见证请求的具体方法 */
  method: string;
  /** 见证请求的完整 URL（两条规则都能命中） */
  url: string;
  /** 当前顺序下实际先命中的规则 id / 序号 / 名称（可能是对中一条，也可能更早的第三条） */
  winnerRuleId: string;
  winnerIndex: number;
  winnerName: string;
  /** 先命中的是否为对中更早的一条；false 表示被更早的第三条规则抢先 */
  winnerInPair: boolean;
}

/** 单条规则是否命中「方法 + URL」（与 findMatch 的逐条判定一致，不检查 enabled） */
function ruleMatches(rule: Rule, method: string, url: URL): boolean {
  if (rule.method !== 'ANY' && rule.method !== method) return false;
  if (!matchHost(rule.host, url.hostname)) return false;
  if (matchPath(rule.pathTemplate, url.pathname) === null) return false;
  return matchQuery(rule.query ?? [], url.searchParams);
}

/**
 * 分析整张规则表：仅已启用规则参与。
 * 对每对规则，四个维度都有共同请求、且双方都不能完整覆盖对方时，
 * 生成见证 URL 并校验确实同时命中二者，再按 findMatch 找出当前顺序下
 * 实际先命中的规则。按规则表顺序（前者序号优先）返回。
 */
export function analyzePartialIntersections(rules: Rule[]): PartialIntersection[] {
  const enabled = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled);

  const out: PartialIntersection[] = [];

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const { rule: a, index: aIndex } = enabled[i];
      const { rule: b, index: bIndex } = enabled[j];

      // 任一方完整覆盖另一方都不属于「部分交集」
      if (ruleCovers(a, b) || ruleCovers(b, a)) continue;

      const method = intersectMethod(a.method, b.method);
      if (method === null) continue;

      const host = intersectHost(a.host, b.host);
      if (host === null) continue;

      const path = intersectPath(a.pathTemplate, b.pathTemplate);
      if (path === null) continue;

      const queryParams = intersectQuery(a.query ?? [], b.query ?? []);
      if (queryParams === null) continue;

      let url: URL;
      try {
        url = new URL(`http://${host}${path}`);
      } catch {
        continue; // 主机 / 路径原文无法构造成合法 URL，无法给出见证
      }
      for (const { name, value } of queryParams) url.searchParams.append(name, value);

      // 兜底校验：见证必须真的同时命中两条规则（求交逻辑与引擎语义的一致性防线）
      if (!ruleMatches(a, method, url) || !ruleMatches(b, method, url)) continue;
      if (!(REQUEST_METHODS as readonly string[]).includes(method)) continue;

      const winner = findMatch(rules, method, url);
      if (!winner) continue; // 理论上不会发生：a、b 都命中

      out.push({
        aRuleId: a.id,
        aIndex,
        aName: a.name,
        bRuleId: b.id,
        bIndex,
        bName: b.name,
        method,
        url: url.toString(),
        winnerRuleId: winner.rule.id,
        winnerIndex: winner.index,
        winnerName: winner.rule.name,
        winnerInPair: winner.rule.id === a.id || winner.rule.id === b.id,
      });
    }
  }

  return out;
}

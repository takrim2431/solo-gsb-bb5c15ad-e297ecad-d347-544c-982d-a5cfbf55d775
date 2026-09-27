import type { MatchResult, QueryCondition, Rule, Simulation, Step } from './types';

/** 单条模拟最多执行的规则命中次数 */
export const MAX_STEPS = 20;

/**
 * 主机匹配：
 * - `*` 匹配任意主机
 * - `*.example.com` 匹配 example.com 的任意子域（至少一级，不含 example.com 本身）
 * - 其余按精确值比较（忽略大小写，忽略端口——调用方传入 hostname）
 */
export function matchHost(pattern: string, hostname: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = hostname.trim().toLowerCase();
  if (p === '') return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return h === p;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 路径模板匹配：按 `/` 分段，段数必须一致；
 * `:name` 段捕获该段（解码后）为参数，其余段按字面量比较（对百分号编码宽容）。
 * 模板留空或 `*` 时匹配任意路径，返回空参数。
 */
export function matchPath(
  template: string,
  pathname: string,
): Record<string, string> | null {
  const t = template.trim();
  if (t === '' || t === '*') return {};
  const tSegs = t.split('/').filter((s) => s !== '');
  const pSegs = pathname.split('/').filter((s) => s !== '');
  if (tSegs.length !== pSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const tSeg = tSegs[i];
    const pSeg = pSegs[i];
    if (tSeg.startsWith(':')) {
      const name = tSeg.slice(1);
      if (name === '') return null;
      params[name] = safeDecode(pSeg);
    } else if (safeDecode(tSeg) !== safeDecode(pSeg)) {
      return null;
    }
  }
  return params;
}

/** 目标模板替换：`:name` 替换为已捕获参数（重新编码）；未捕获的占位符原样保留 */
export function substitute(target: string, params: Record<string, string>): string {
  return target.replace(/:([A-Za-z0-9_]+)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? encodeURIComponent(params[name])
      : whole,
  );
}

/**
 * 查询参数条件匹配：同一规则的多条条件 AND 组合，全部满足才命中。
 * - exists：参数出现即命中（含空值 `?x=`）；
 * - not-exists：参数完全不出现才命中；
 * - equals：同名参数的任一值与比较值相等即命中（`?x=a&x=b` 中 x 含 a 即命中 equals(a)）。
 * 参数名与值按 URLSearchParams 解码后的原文精确比较。
 */
export function matchQuery(
  conditions: QueryCondition[],
  searchParams: URLSearchParams,
): boolean {
  for (const cond of conditions) {
    const values = searchParams.getAll(cond.name);
    switch (cond.op) {
      case 'exists':
        if (values.length === 0) return false;
        break;
      case 'not-exists':
        if (values.length > 0) return false;
        break;
      case 'equals':
        if (!values.some((v) => v === cond.value)) return false;
        break;
    }
  }
  return true;
}

/**
 * 解析动作目标：
 * - 以 http(s):// 开头：整体替换 URL
 * - 以 / 开头：替换路径（保留当前源）
 * - 其余：按相对 URL 解析
 * 目标不含 `?`/`#` 时保留当前查询串与片段。
 */
export function resolveTarget(target: string, current: URL): URL {
  const next = /^https?:\/\//i.test(target)
    ? new URL(target)
    : new URL(target, current);
  if (!target.includes('?') && !target.includes('#')) {
    next.search = current.search;
    next.hash = current.hash;
  }
  return next;
}

/** 在规则表中按顺序找到第一条命中规则（跳过未启用的规则） */
export function findMatch(rules: Rule[], method: string, url: URL): MatchResult | null {
  const m = method.toUpperCase();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule.enabled) continue;
    if (rule.method !== 'ANY' && rule.method !== m) continue;
    if (!matchHost(rule.host, url.hostname)) continue;
    const params = matchPath(rule.pathTemplate, url.pathname);
    if (params === null) continue;
    if (!matchQuery(rule.query ?? [], url.searchParams)) continue;
    return { rule, index: i, params };
  }
  return null;
}

function fail(status: Simulation['status'], steps: Step[], reason: string): Simulation {
  return { status, ok: false, steps, reason };
}

/**
 * 模拟核心（生成器形式）：
 * 1. 每步先计算状态键（方法 + URL API 序列化结果），重复即判循环；
 * 2. 从第一条规则开始找首个命中；
 * 3. 命中后、动作执行前 yield 该步骤——调用方可在此暂停（断点 / 单步）；
 * 4. 恢复后执行动作：rewrite 应用后回到第 1 步重新匹配；redirect / stop 立即终止；
 * 5. 最多执行 MAX_STEPS 步。第 MAX_STEPS 步重写后仍检查新状态：无命中即成功终止、
 *    状态重复判循环；只有仍有规则命中（还需第 MAX_STEPS + 1 步）才判超限，
 *    轨迹始终至多保留 MAX_STEPS 条。
 *
 * 暂停只停在 yield 点：seen 循环检测状态、步数计数与当前 URL 都保存在生成器闭包中，
 * 恢复执行时原样沿用，不会因暂停重置。
 */
export function* runSimulation(
  rules: Rule[],
  method: string,
  inputUrl: string,
): Generator<Step, Simulation> {
  const steps: Step[] = [];
  const m = method.toUpperCase();

  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return fail('invalid-url', steps, `输入的 URL 无法解析：${inputUrl}`);
  }

  const seen = new Set<string>();

  for (let n = 1; ; n++) {
    const stateKey = `${m} ${url.toString()}`;
    if (seen.has(stateKey)) {
      return fail(
        'loop',
        steps,
        `检测到循环：状态「${stateKey}」在第 ${n} 步再次出现`,
      );
    }
    seen.add(stateKey);

    const match = findMatch(rules, m, url);
    if (!match) {
      return {
        status: 'final',
        ok: true,
        steps,
        reason:
          steps.length === 0
            ? '没有任何规则命中，按原始请求放行'
            : '没有更多规则命中，以当前 URL 作为最终结果',
        finalUrl: url.toString(),
      };
    }

    // 已执行 MAX_STEPS 步后仍有规则命中：还需第 MAX_STEPS + 1 步才判超限，
    // 该命中不进入轨迹（轨迹至多 MAX_STEPS 条）
    if (n > MAX_STEPS) {
      return fail(
        'max-steps',
        steps,
        `已执行 ${MAX_STEPS} 步仍未终止，判定为潜在循环，不予返回成功结果`,
      );
    }

    const { rule, index, params } = match;
    const step: Step = {
      n,
      method: m,
      stateKey,
      urlBefore: url.toString(),
      ruleIndex: index,
      rule: structuredClone(rule),
      params,
    };
    // 先计入轨迹，再在动作执行前暂停
    steps.push(step);
    yield step;

    if (rule.action.type === 'stop') {
      return {
        status: 'stopped',
        ok: true,
        steps,
        reason: `被第 ${index + 1} 条规则「${rule.name}」停止，请求到此终止`,
      };
    }

    const target = substitute(rule.action.target, params);
    let next: URL;
    try {
      next = resolveTarget(target, url);
    } catch {
      return fail(
        'invalid-target',
        steps,
        `规则「${rule.name}」的目标「${target}」无法解析为有效 URL`,
      );
    }

    if (rule.action.type === 'redirect') {
      step.location = next.toString();
      step.status = rule.action.status;
      return {
        status: 'redirect',
        ok: true,
        steps,
        reason: `第 ${index + 1} 条规则「${rule.name}」返回 ${rule.action.status} 重定向`,
        redirectLocation: step.location,
        redirectStatus: rule.action.status,
      };
    }

    // rewrite：应用后从第一条规则重新匹配
    step.urlAfter = next.toString();
    url = next;
  }
}

/**
 * 模拟一次请求并跑完全程（普通「运行」）：语义与 {@link runSimulation} 完全一致，
 * 只是不停顿地耗尽生成器。
 */
export function simulate(rules: Rule[], method: string, inputUrl: string): Simulation {
  const gen = runSimulation(rules, method, inputUrl);
  let cur = gen.next();
  while (!cur.done) cur = gen.next();
  return cur.value;
}

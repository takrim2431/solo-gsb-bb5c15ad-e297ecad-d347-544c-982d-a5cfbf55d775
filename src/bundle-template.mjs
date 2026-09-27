// route-bundle.mjs —— 由「URL 路由规则调试台」导出的自包含可执行路由器。
// 不依赖项目源码与任何第三方包（仅使用 Node 内置模块），需要 Node.js 20+。
//
// 命令行用法：
//   node route-bundle.mjs METHOD URL
//   输出统一 JSON：{ status, ok, reason, steps, finalUrl?, redirectLocation?, redirectStatus? }
//   —— status 为终止类型，steps 为完整步骤；结果为失败（循环 / 超限 / 非法输入）时退出码为 1。
//
// 模块用法：
//   import { route } from './route-bundle.mjs';
//   const result = route('GET', 'http://api.example.com/v1/users/42');
//
// 语义与调试台引擎一致：首条命中生效；rewrite 应用后从第一条规则重新匹配；
// 路径模板 :name 捕获并替换进目标；查询参数条件按 AND 组合（存在 / 不存在 / 值等于）；
// 以「方法 + URL」为状态键检测循环；最多执行 20 步——第 20 步重写后仍检查新状态，
// 无命中即正常终止、状态重复判循环，只有仍有规则命中才判超限。

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 导出时内嵌的已启用规则（按原顺序） */
const RULES = __RULES__;

/** 单条模拟最多执行的规则命中次数 */
const MAX_STEPS = 20;

/**
 * 主机匹配：
 * - `*` 匹配任意主机
 * - `*.example.com` 匹配 example.com 的任意子域（至少一级，不含 example.com 本身）
 * - 其余按精确值比较（忽略大小写，忽略端口——调用方传入 hostname）
 */
function matchHost(pattern, hostname) {
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

function safeDecode(s) {
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
function matchPath(template, pathname) {
  const t = template.trim();
  if (t === '' || t === '*') return {};
  const tSegs = t.split('/').filter((s) => s !== '');
  const pSegs = pathname.split('/').filter((s) => s !== '');
  if (tSegs.length !== pSegs.length) return null;
  const params = {};
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
function substitute(target, params) {
  return target.replace(/:([A-Za-z0-9_]+)/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? encodeURIComponent(params[name])
      : whole,
  );
}

/**
 * 查询参数条件匹配：同一规则的多条条件 AND 组合，全部满足才命中。
 * - exists：参数出现即命中（含空值 `?x=`）；
 * - not-exists：参数完全不出现才命中；
 * - equals：同名参数的任一值与比较值相等即命中。
 */
function matchQuery(conditions, searchParams) {
  for (const cond of conditions) {
    const values = searchParams.getAll(cond.name);
    if (cond.op === 'exists') {
      if (values.length === 0) return false;
    } else if (cond.op === 'not-exists') {
      if (values.length > 0) return false;
    } else if (cond.op === 'equals') {
      if (!values.some((v) => v === cond.value)) return false;
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
function resolveTarget(target, current) {
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
function findMatch(rules, method, url) {
  const m = method.toUpperCase();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule.enabled) continue;
    if (rule.method !== 'ANY' && rule.method !== m) continue;
    if (!matchHost(rule.host, url.hostname)) continue;
    const params = matchPath(rule.pathTemplate, url.pathname);
    if (params === null) continue;
    if (!matchQuery(rule.query || [], url.searchParams)) continue;
    return { rule, index: i, params };
  }
  return null;
}

function fail(status, steps, reason) {
  return { status, ok: false, steps, reason };
}

/**
 * 模拟一次请求：
 * 1. 每步先计算状态键（方法 + URL API 序列化结果），重复即判循环；
 * 2. 从第一条规则开始找首个命中；
 * 3. rewrite 应用后回到第 1 步重新匹配；redirect / stop 立即终止；
 * 4. 最多执行 MAX_STEPS 步。第 MAX_STEPS 步重写后仍检查新状态：无命中即成功终止、
 *    状态重复判循环；只有仍有规则命中（还需第 MAX_STEPS + 1 步）才判超限，
 *    轨迹始终至多保留 MAX_STEPS 条。
 */
function simulate(rules, method, inputUrl) {
  const steps = [];
  const m = method.toUpperCase();

  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return fail('invalid-url', steps, `输入的 URL 无法解析：${inputUrl}`);
  }

  const seen = new Set();

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
    const step = {
      n,
      method: m,
      stateKey,
      urlBefore: url.toString(),
      ruleIndex: index,
      rule: structuredClone(rule),
      params,
    };

    if (rule.action.type === 'stop') {
      steps.push(step);
      return {
        status: 'stopped',
        ok: true,
        steps,
        reason: `被第 ${index + 1} 条规则「${rule.name}」停止，请求到此终止`,
      };
    }

    const target = substitute(rule.action.target, params);
    let next;
    try {
      next = resolveTarget(target, url);
    } catch {
      steps.push(step);
      return fail(
        'invalid-target',
        steps,
        `规则「${rule.name}」的目标「${target}」无法解析为有效 URL`,
      );
    }

    if (rule.action.type === 'redirect') {
      step.location = next.toString();
      step.status = rule.action.status;
      steps.push(step);
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
    steps.push(step);
    url = next;
  }
}

/**
 * 用导出时内嵌的规则表模拟一次请求。
 * 返回 { status, ok, reason, steps, finalUrl?, redirectLocation?, redirectStatus? }。
 */
export function route(method, url) {
  return simulate(RULES, method, url);
}

/** 判断是否以 `node route-bundle.mjs ...` 方式直接运行（而非被 import） */
function isInvokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const [method, inputUrl] = process.argv.slice(2);
  if (!method || !inputUrl) {
    console.error('用法：node route-bundle.mjs METHOD URL');
    console.error('示例：node route-bundle.mjs GET http://api.example.com/v1/users/42');
    process.exitCode = 1;
  } else {
    const result = route(method, inputUrl);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}

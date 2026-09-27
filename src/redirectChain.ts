import { simulate } from './engine';
import type { Rule, Simulation } from './types';

/** 重定向链最多跟随的重定向次数；耗尽后再遇重定向即判超限（不返回成功结果） */
export const MAX_REDIRECTS = 10;

/**
 * 重定向后的方法改写（与常见浏览器 / fetch 行为一致）：
 * - 301 / 302：仅 POST 改为 GET，其余方法保持不变；
 * - 303：除 HEAD 外一律改为 GET；
 * - 307 / 308：保持原方法。
 */
export function redirectNextMethod(status: number, method: string): string {
  const m = method.toUpperCase();
  if (status === 301 || status === 302) return m === 'POST' ? 'GET' : m;
  if (status === 303) return m === 'HEAD' ? 'HEAD' : 'GET';
  return m; // 307 / 308 保持方法
}

/** 链中的一跳：一次完整的单条模拟及其入站请求与重定向出口 */
export interface RedirectHop {
  /** 跳序号（1 起） */
  n: number;
  /** 入站方法（首跳为输入方法，之后为上一跳重定向改写后的方法） */
  method: string;
  /** 入站 URL（URL API 序列化结果；首跳为输入 URL 的序列化） */
  url: string;
  /** 该跳的完整模拟结果（含内部重写轨迹，步骤引用运行时规则快照） */
  sim: Simulation;
  /** 重定向终止时的状态码与 Location（非重定向终止时缺省） */
  status?: number;
  location?: string;
}

export type ChainStatus =
  | 'final' // 末跳无更多规则命中，得到最终 URL（成功）
  | 'stopped' // 末跳被停止规则终止（与单条模拟语义一致，成功终止）
  | 'loop' // 跨跳循环：入站「方法 + 序列化 URL」在链中重复（失败）
  | 'max-redirects' // 跟随超过 MAX_REDIRECTS 次重定向（失败）
  | 'engine-failure'; // 某一跳引擎失败（循环 / 超限 / 非法输入 / 非法目标）

export interface RedirectChainResult {
  status: ChainStatus;
  /** 是否为成功终止（final / stopped）；跨跳循环、超限、引擎失败为 false */
  ok: boolean;
  hops: RedirectHop[];
  reason: string;
  /** 状态为 final 时的最终 URL */
  finalUrl?: string;
}

/** 入站状态键：方法 + 序列化 URL，用于跨跳循环识别 */
function hopKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/** 尽量用 URL API 序列化；无法解析时原样返回（该跳会由引擎判 invalid-url） */
function serializeUrl(raw: string): string {
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

/**
 * 重定向链预演：从「方法 + URL」出发，复用 {@link simulate} 引擎逐跳模拟，
 * 命中重定向时在本地跟随 Location（不发任何网络请求），直到：
 * - 非重定向结果（final / stopped）——链终止；
 * - 某一跳引擎失败（loop / max-steps / invalid-url / invalid-target）——链失败；
 * - 入站「方法 + 序列化 URL」与之前某一跳重复——跨跳循环，链失败；
 * - 跟随重定向超过 {@link MAX_REDIRECTS} 次——超限，链失败（不返回成功结果）。
 *
 * 规则表在运行开始时做深拷贝快照：运行期间与之后对规则表的编辑都不会影响
 * 本次结果（每跳内部轨迹引用的也是快照中的规则副本）。
 */
export function followRedirectChain(
  rules: Rule[],
  method: string,
  inputUrl: string,
): RedirectChainResult {
  const snapshot = structuredClone(rules) as Rule[];
  const hops: RedirectHop[] = [];
  const seen = new Map<string, number>(); // 入站状态键 → 首次出现的跳序号

  let m = method.toUpperCase();
  let url = serializeUrl(inputUrl);
  let redirectsFollowed = 0;

  for (;;) {
    const key = hopKey(m, url);
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      return {
        status: 'loop',
        ok: false,
        hops,
        reason: `检测到跨跳循环：第 ${hops.length + 1} 跳的入站状态「${key}」与第 ${firstSeen} 跳完全相同（方法 + 序列化 URL）`,
      };
    }
    seen.set(key, hops.length + 1);

    const sim = simulate(snapshot, m, url);
    const hop: RedirectHop = { n: hops.length + 1, method: m, url, sim };

    if (sim.status === 'redirect') {
      // 引擎保证 redirect 结果必带状态码与 Location
      hop.status = sim.redirectStatus!;
      hop.location = sim.redirectLocation!;
    }
    hops.push(hop);

    if (sim.status === 'redirect') {
      if (redirectsFollowed >= MAX_REDIRECTS) {
        return {
          status: 'max-redirects',
          ok: false,
          hops,
          reason: `已跟随 ${MAX_REDIRECTS} 次重定向，第 ${hop.n} 跳仍返回 ${hop.status} 重定向：达到跟随上限，判定超限，不予返回成功结果`,
        };
      }
      redirectsFollowed++;
      m = redirectNextMethod(hop.status!, m);
      url = hop.location!;
      continue;
    }

    if (!sim.ok) {
      return {
        status: 'engine-failure',
        ok: false,
        hops,
        reason: `第 ${hop.n} 跳模拟失败（${sim.status}）：${sim.reason}`,
      };
    }

    if (sim.status === 'stopped') {
      return {
        status: 'stopped',
        ok: true,
        hops,
        reason: `第 ${hop.n} 跳被停止规则终止，链到此结束`,
      };
    }

    // final：没有更多规则命中，当前 URL 为链的最终结果
    return {
      status: 'final',
      ok: true,
      hops,
      reason:
        redirectsFollowed === 0
          ? '没有遇到重定向，直接得到最终 URL'
          : `跟随 ${redirectsFollowed} 次重定向后到达最终 URL`,
      finalUrl: sim.finalUrl,
    };
  }
}

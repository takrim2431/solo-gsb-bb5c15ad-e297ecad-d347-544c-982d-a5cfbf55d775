import type { QueryCondition, Rule } from './types';
import { METHOD_MATCHERS, QUERY_OPERATORS, REDIRECT_STATUSES } from './types';

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验并规范化一条规则的查询参数条件。
 * 字段缺失（旧数据）时回退为空条件数组；参数名重复时抛出带位置信息的错误。
 */
function validateQuery(rawQuery: unknown, at: string): QueryCondition[] {
  if (rawQuery === undefined) return [];
  if (!Array.isArray(rawQuery)) throw new Error(`${at}的 query 必须是数组`);
  const conds = rawQuery.map((rawCond, j) => {
    const atCond = `${at}的第 ${j + 1} 条查询条件`;
    if (!isRecord(rawCond)) throw new Error(`${atCond}不是对象`);
    const name = rawCond.name ?? '';
    if (typeof name !== 'string') throw new Error(`${atCond}的 name 必须是字符串`);
    if (name.trim() === '') throw new Error(`${atCond}的参数名不能为空`);
    const op = rawCond.op ?? 'exists';
    if (typeof op !== 'string' || !(QUERY_OPERATORS as readonly string[]).includes(op)) {
      throw new Error(`${atCond}的 op 必须是 ${QUERY_OPERATORS.join(' / ')} 之一`);
    }
    const value = rawCond.value ?? '';
    if (typeof value !== 'string') throw new Error(`${atCond}的 value 必须是字符串`);
    return { name: name.trim(), op: op as QueryCondition['op'], value };
  });
  const seen = new Set<string>();
  for (const cond of conds) {
    if (seen.has(cond.name)) {
      throw new Error(`${at}的查询条件存在重复参数名「${cond.name}」`);
    }
    seen.add(cond.name);
  }
  return conds;
}

/**
 * 校验并规范化导入的规则 JSON。
 * 字段缺失时给出合理默认值，类型错误时抛出带位置信息的中文错误。
 * id 按原顺序去重：首次出现的非空 id 原样保留，重复或缺失的 id 重新生成
 * （不与原数据携带的 id 及已分配的 id 相撞），保证规则表内 id 唯一，
 * 规则顺序与匹配字段不受影响。
 */
export function validateRules(data: unknown, genId: () => string = uid): Rule[] {
  if (!Array.isArray(data)) {
    throw new Error('JSON 顶层必须是规则数组');
  }
  // 先收集原数据携带的全部非空 id：补发的新 id 除不能撞已分配的 id 外，
  // 也不能撞原数据中尚未遍历到的 id，否则会抢占后续规则首次出现时应保留的 id
  const incoming = new Set<string>();
  for (const raw of data) {
    if (isRecord(raw) && typeof raw.id === 'string' && raw.id !== '') {
      incoming.add(raw.id);
    }
  }
  const assigned = new Set<string>();
  const resolveId = (rawId: unknown): string => {
    if (typeof rawId === 'string' && rawId !== '' && !assigned.has(rawId)) {
      assigned.add(rawId);
      return rawId;
    }
    let id = genId();
    while (assigned.has(id) || incoming.has(id)) id = genId();
    assigned.add(id);
    return id;
  };
  return data.map((raw, i) => {
    const at = `第 ${i + 1} 条规则`;
    if (!isRecord(raw)) throw new Error(`${at}不是对象`);

    const method = raw.method ?? 'ANY';
    if (
      typeof method !== 'string' ||
      !(METHOD_MATCHERS as readonly string[]).includes(method)
    ) {
      throw new Error(`${at}的 method 必须是 ${METHOD_MATCHERS.join(' / ')} 之一`);
    }

    if (raw.host !== undefined && typeof raw.host !== 'string') {
      throw new Error(`${at}的 host 必须是字符串`);
    }
    if (raw.pathTemplate !== undefined && typeof raw.pathTemplate !== 'string') {
      throw new Error(`${at}的 pathTemplate 必须是字符串`);
    }

    const query = validateQuery(raw.query, at);

    const rawAction = raw.action ?? {};
    if (!isRecord(rawAction)) throw new Error(`${at}的 action 必须是对象`);
    const type = rawAction.type ?? 'rewrite';
    if (type !== 'rewrite' && type !== 'redirect' && type !== 'stop') {
      throw new Error(`${at}的 action.type 必须是 rewrite / redirect / stop 之一`);
    }
    const target = rawAction.target ?? '';
    if (typeof target !== 'string') throw new Error(`${at}的 action.target 必须是字符串`);
    if (type !== 'stop' && target.trim() === '') {
      throw new Error(`${at}的 action.target 不能为空（rewrite / redirect 需要目标）`);
    }
    const status = rawAction.status ?? 302;
    if (
      typeof status !== 'number' ||
      !(REDIRECT_STATUSES as readonly number[]).includes(status)
    ) {
      throw new Error(
        `${at}的 action.status 必须是 ${REDIRECT_STATUSES.join(' / ')} 之一`,
      );
    }

    return {
      id: resolveId(raw.id),
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : `规则 ${i + 1}`,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      method: method as Rule['method'],
      host: typeof raw.host === 'string' ? raw.host : '',
      pathTemplate: typeof raw.pathTemplate === 'string' ? raw.pathTemplate : '',
      query,
      action: { type, target, status },
    };
  });
}

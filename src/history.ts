import type { QueryCondition, Rule } from './types';

/** 历史栈上限：超过后丢弃最旧的一步 */
const MAX_HISTORY = 200;

export function cloneRules(rules: readonly Rule[]): Rule[] {
  return structuredClone(rules) as Rule[];
}

/** 查询条件列表的结构相等比较：逐条对比参数名、操作符与比较值 */
function queryEqual(
  a: readonly QueryCondition[],
  b: readonly QueryCondition[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].op !== b[i].op || a[i].value !== b[i].value) {
      return false;
    }
  }
  return true;
}

/**
 * 规则快照的结构相等比较：字段逐一对比，仅判断内容是否一致。
 * 用于跳过没有产生任何变化的「空操作」，避免污染历史。
 */
export function rulesEqual(a: readonly Rule[], b: readonly Rule[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.enabled !== y.enabled ||
      x.method !== y.method ||
      x.host !== y.host ||
      x.pathTemplate !== y.pathTemplate ||
      !queryEqual(x.query ?? [], y.query ?? []) ||
      x.action.type !== y.action.type ||
      x.action.target !== y.action.target ||
      x.action.status !== y.action.status
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 规则编辑的可撤销 / 重做历史。
 *
 * - `past` 保存当前状态之前的完整规则快照，`future` 保存撤销后可重做的快照；
 * - 离散操作（新增 / 删除 / 排序 / 启停 / 下拉选择 / 导入 / 载入示例等）用 commit 记录一步；
 * - 同一文本输入框从获得焦点到失焦的连续输入用一组 session API 合并为一步：
 *   beginSession 记录焦点时刻的快照，中途的输入只更新当前状态，endSession 时若内容
 *   确实变化才提交一步；
 * - 任何新编辑（含合并输入首次发生分歧时）都会立即丢弃重做分支。
 *
 * 快照均为深拷贝，调用方可以自由替换 / 修改传给本对象或从本对象取回的数组。
 */
export class RuleHistory {
  private current: Rule[];
  private past: Rule[][] = [];
  private future: Rule[][] = [];
  private sessionBaseline: Rule[] | null = null;

  constructor(initial: readonly Rule[]) {
    this.current = cloneRules(initial);
  }

  get value(): Rule[] {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 记录一次离散编辑；与当前状态相同（空操作）时不产生历史步骤 */
  commit(next: readonly Rule[]): Rule[] {
    this.sessionBaseline = null;
    if (rulesEqual(this.current, next)) return this.current;
    this.pushPast(this.current);
    this.future = [];
    this.current = cloneRules(next);
    return this.current;
  }

  /**
   * 换入一份全新规则表（如确认导入加密分享）：当前规则照常更新，
   * 但它属于「另一份文档」，撤销 / 重做分支一并清空。
   */
  reset(next: readonly Rule[]): Rule[] {
    this.past = [];
    this.future = [];
    this.sessionBaseline = null;
    this.current = cloneRules(next);
    return this.current;
  }

  /** 文本输入框获得焦点：记录本次连续输入开始前的规则快照 */
  beginSession(rulesAtFocus: readonly Rule[]): void {
    this.sessionBaseline = cloneRules(rulesAtFocus);
  }

  /**
   * 合并输入进行中的一次改动：只更新当前状态。
   * 与焦点时快照首次出现分歧时立即丢弃重做分支。
   */
  editSession(next: readonly Rule[]): Rule[] {
    if (this.sessionBaseline === null) {
      // 没有进行中的 session（理论上不应发生）时退化为普通提交
      return this.commit(next);
    }
    if (rulesEqual(this.current, next)) return this.current;
    if (!this.diverged() && this.future.length > 0) this.future = [];
    this.current = cloneRules(next);
    return this.current;
  }

  /**
   * 文本输入框失焦：结束本次连续输入。
   * 仅当内容与焦点时不同才把这整段输入合并记为一步；完全改回原值则不产生步骤。
   */
  endSession(next: readonly Rule[]): Rule[] {
    const baseline = this.sessionBaseline;
    this.sessionBaseline = null;
    if (baseline === null || rulesEqual(baseline, next)) {
      // 无基线（防御性）或净内容无变化：不产生历史步骤
      if (!rulesEqual(this.current, next)) this.current = cloneRules(next);
      return this.current;
    }
    this.pushPast(baseline);
    this.current = cloneRules(next);
    return this.current;
  }

  /** 撤销一步，返回恢复后的规则快照；没有可撤销步骤时返回 null */
  undo(): Rule[] | null {
    if (this.past.length === 0) return null;
    // 输入会话中的撤销（正常 UI 路径下按钮已禁用，这里仅作防御）：先丢弃该会话
    this.sessionBaseline = null;
    const prev = this.past.pop() as Rule[];
    this.future.push(this.current);
    this.current = prev;
    return this.current;
  }

  /** 重做一步，返回恢复后的规则快照；没有可重做步骤时返回 null */
  redo(): Rule[] | null {
    if (this.future.length === 0) return null;
    this.sessionBaseline = null;
    const next = this.future.pop() as Rule[];
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }

  /** 当前输入是否已与焦点时的快照产生分歧（同时处理基线被改空的边界） */
  private diverged(): boolean {
    return this.sessionBaseline !== null && !rulesEqual(this.sessionBaseline, this.current);
  }

  private pushPast(snapshot: readonly Rule[]): void {
    this.past.push(cloneRules(snapshot));
    if (this.past.length > MAX_HISTORY) this.past.shift();
  }
}

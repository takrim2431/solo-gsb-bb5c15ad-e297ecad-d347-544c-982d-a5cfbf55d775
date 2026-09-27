import { useCallback, useMemo, useRef, useState } from 'react';
import type { Rule } from './types';
import { RuleHistory } from './history';

export interface RuleHistoryApi {
  rules: Rule[];
  canUndo: boolean;
  canRedo: boolean;
  /** 记录一次离散编辑（新增 / 删除 / 排序 / 启停 / 下拉选择 / 导入 / 载入示例 / 清空） */
  commit: (next: readonly Rule[]) => void;
  /** 整体换一份规则表，撤销 / 重做分支一并清空（如确认导入加密分享） */
  reset: (next: readonly Rule[]) => void;
  /** 文本输入框获得焦点：开始合并输入会话 */
  beginSession: () => void;
  /** 合并输入会话进行中的改动（每次按键） */
  editSession: (next: readonly Rule[]) => void;
  /** 文本输入框失焦：结束会话并合并为一步 */
  endSession: (next: readonly Rule[]) => void;
  undo: () => boolean;
  redo: () => boolean;
}

/**
 * 规则编辑历史的 React 绑定。历史只存在于当前页面会话（内存），
 * 不做持久化；刷新页面后由调用方从 localStorage 恢复当前规则。
 */
export function useRuleHistory(loadInitial: () => Rule[]): RuleHistoryApi {
  const ref = useRef<RuleHistory | null>(null);
  if (ref.current === null) ref.current = new RuleHistory(loadInitial());
  const history = ref.current;

  const [rules, setRules] = useState<Rule[]>(() => history.value);
  const [canUndo, setCanUndo] = useState(history.canUndo);
  const [canRedo, setCanRedo] = useState(history.canRedo);

  const sync = useCallback((next: Rule[]) => {
    setRules(next);
    setCanUndo(history.canUndo);
    setCanRedo(history.canRedo);
  }, [history]);

  const api = useMemo<RuleHistoryApi>(
    () => ({
      rules,
      canUndo,
      canRedo,
      commit: (next) => sync(history.commit(next)),
      reset: (next) => sync(history.reset(next)),
      beginSession: () => history.beginSession(history.value),
      editSession: (next) => sync(history.editSession(next)),
      endSession: (next) => sync(history.endSession(next)),
      undo: () => {
        const prev = history.undo();
        if (prev === null) return false;
        sync(prev);
        return true;
      },
      redo: () => {
        const next = history.redo();
        if (next === null) return false;
        sync(next);
        return true;
      },
    }),
    [rules, canUndo, canRedo, history, sync],
  );

  return api;
}

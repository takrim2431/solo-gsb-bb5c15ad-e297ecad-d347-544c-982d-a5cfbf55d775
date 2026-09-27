import { describe, expect, it } from 'vitest';
import { RuleHistory, cloneRules, rulesEqual } from './history';
import type { Rule } from './types';

function rule(id: string, name = id): Rule {
  return {
    id,
    name,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
  };
}

describe('rulesEqual / cloneRules', () => {
  it('按内容比较规则快照', () => {
    const a = [rule('a')];
    expect(rulesEqual(a, cloneRules(a))).toBe(true);
    const b = cloneRules(a);
    b[0].enabled = false;
    expect(rulesEqual(a, b)).toBe(false);
  });

  it('查询条件的内容差异会被识别（增删、改名、改操作符、改值）', () => {
    const base = rule('a');
    base.query = [{ name: 'env', op: 'equals', value: 'canary' }];
    const same = cloneRules([base]);
    expect(rulesEqual([base], same)).toBe(true);

    const noConds = cloneRules([base]);
    noConds[0].query = [];
    expect(rulesEqual([base], noConds)).toBe(false);

    const renamed = cloneRules([base]);
    renamed[0].query[0].name = 'mode';
    expect(rulesEqual([base], renamed)).toBe(false);

    const reOp = cloneRules([base]);
    reOp[0].query[0].op = 'exists';
    expect(rulesEqual([base], reOp)).toBe(false);

    const reValue = cloneRules([base]);
    reValue[0].query[0].value = 'prod';
    expect(rulesEqual([base], reValue)).toBe(false);
  });

  it('克隆出的快照与原数组相互独立', () => {
    const a = [rule('a')];
    const b = cloneRules(a);
    b[0].name = '改了';
    b[0].action.target = '/x';
    expect(a[0].name).toBe('a');
    expect(a[0].action.target).toBe('/');
  });
});

describe('RuleHistory 离散提交', () => {
  it('新增 / 删除等离散操作进入历史并可逐级撤销、重做', () => {
    const h = new RuleHistory([]);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);

    h.commit([rule('a')]); // 新增
    h.commit([rule('a'), rule('b')]); // 再新增
    expect(h.value.map((r) => r.id)).toEqual(['a', 'b']);

    expect(h.undo()?.map((r) => r.id)).toEqual(['a']);
    expect(h.undo()?.map((r) => r.id)).toEqual([]);
    expect(h.canUndo).toBe(false);

    expect(h.redo()?.map((r) => r.id)).toEqual(['a']);
    expect(h.redo()?.map((r) => r.id)).toEqual(['a', 'b']);
    expect(h.canRedo).toBe(false);
  });

  it('内容相同的提交是空操作，不产生历史步骤', () => {
    const h = new RuleHistory([rule('a')]);
    h.commit([rule('a')]);
    expect(h.canUndo).toBe(false);
  });

  it('撤销后再产生新编辑，立即丢弃重做分支', () => {
    const h = new RuleHistory([]);
    h.commit([rule('a')]);
    h.commit([rule('a'), rule('b')]);
    h.undo(); // 回到 [a]，future 中有 [a,b]
    expect(h.canRedo).toBe(true);

    h.commit([rule('a'), rule('c')]); // 新编辑
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.undo()?.map((r) => r.id)).toEqual(['a']);
    expect(h.undo()?.map((r) => r.id)).toEqual([]);
  });

  it('撤销 / 重做在边界处返回 null', () => {
    const h = new RuleHistory([]);
    expect(h.undo()).toBeNull();
    h.commit([rule('a')]);
    h.undo();
    expect(h.redo()).not.toBeNull();
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
  });

  it('重置会清空撤销 / 重做分支，但保留当前规则', () => {
    const h = new RuleHistory([]);
    h.commit([rule('a')]);
    h.reset([rule('x'), rule('y')]);
    expect(h.value.map((r) => r.id)).toEqual(['x', 'y']);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it('提交的数组与历史快照互不影响（深拷贝隔离）', () => {
    const h = new RuleHistory([]);
    const incoming = [rule('a')];
    h.commit(incoming);
    incoming[0].name = '外部修改';
    h.undo();
    h.redo();
    expect(h.value[0].name).toBe('a');
  });
});

describe('RuleHistory 文本输入会话合并', () => {
  it('同一输入框从聚焦到失焦的连续输入合并为一步', () => {
    const h = new RuleHistory([rule('a', '原名')]);
    h.beginSession(h.value);
    for (const name of ['原', '原新', '原新名']) {
      const next = cloneRules(h.value);
      next[0].name = name;
      h.editSession(next);
    }
    expect(h.canUndo).toBe(false); // 会话未结束，还没有已完成步骤
    h.endSession(cloneRules(h.value));
    expect(h.canUndo).toBe(true);

    const restored = h.undo();
    expect(restored?.[0].name).toBe('原名'); // 一步回到焦点前
    expect(h.redo()?.[0].name).toBe('原新名');
  });

  it('会话进行中首次产生分歧时立即丢弃重做分支', () => {
    const h = new RuleHistory([]);
    h.commit([rule('a')]);
    h.undo(); // current 回到空，future 有 [a]
    expect(h.canRedo).toBe(true);

    h.beginSession(h.value);
    const typing = cloneRules(h.value);
    typing.push(rule('b'));
    h.editSession(typing);
    expect(h.canRedo).toBe(false);
    h.endSession(cloneRules(h.value));
    expect(h.canUndo).toBe(true);
  });

  it('失焦时内容与焦点时相同（净无变化）不产生历史步骤', () => {
    const h = new RuleHistory([rule('a', '原名')]);
    h.beginSession(h.value);
    let next = cloneRules(h.value);
    next[0].name = '改过';
    h.editSession(next);
    next = cloneRules(h.value);
    next[0].name = '原名'; // 又改回去
    h.editSession(next);
    h.endSession(cloneRules(h.value));
    expect(h.canUndo).toBe(false);
    expect(h.value[0].name).toBe('原名');
  });

  it('会话中若没有任何改动，失焦不产生步骤', () => {
    const h = new RuleHistory([rule('a')]);
    h.beginSession(h.value);
    h.endSession(cloneRules(h.value));
    expect(h.canUndo).toBe(false);
  });

  it('会话提交的是完整规则快照（撤销恢复整表，不只恢复单字段）', () => {
    const h = new RuleHistory([rule('a'), rule('b')]);
    h.beginSession(h.value);
    const next = cloneRules(h.value);
    next[0].host = 'other.example.com';
    next[0].pathTemplate = '/v2/:id';
    next[1].enabled = false;
    h.editSession(next);
    h.endSession(cloneRules(h.value));

    const restored = h.undo();
    expect(restored).toEqual([rule('a'), rule('b')]);
  });
});

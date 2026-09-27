import { describe, expect, it } from 'vitest';
import {
  EMPTY_STORE,
  firstDivergence,
  freezeBaseline,
  outcomeEqual,
  runRegression,
  sameStep,
  stepActionOutcome,
  validateRegressionStore,
} from './regression';
import type { Rule, Simulation, Step } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

function sim(partial: Partial<Simulation> & { status: Simulation['status'] }): Simulation {
  return { ok: true, steps: [], reason: '', ...partial };
}

function step(partial: Partial<Step> & { rule: Rule }): Step {
  return {
    n: 1,
    method: 'GET',
    stateKey: 'GET http://example.com/a',
    urlBefore: 'http://example.com/a',
    ruleIndex: 0,
    params: {},
    ...partial,
  };
}

describe('outcomeEqual（变化判定只看终止类型与可观察结果）', () => {
  it('final 比较 finalUrl，不比较原因文案', () => {
    const a = sim({
      status: 'final',
      finalUrl: 'http://x.com/a',
      reason: '没有任何规则命中，按原始请求放行',
    });
    const b = sim({
      status: 'final',
      finalUrl: 'http://x.com/a',
      reason: '没有更多规则命中，以当前 URL 作为最终结果',
    });
    expect(outcomeEqual(a, b)).toBe(true);
    expect(outcomeEqual(a, sim({ status: 'final', finalUrl: 'http://x.com/b' }))).toBe(false);
  });

  it('redirect 比较状态码与 Location', () => {
    const base = sim({
      status: 'redirect',
      redirectStatus: 301,
      redirectLocation: 'https://n.com/x',
    });
    expect(
      outcomeEqual(
        base,
        sim({ status: 'redirect', redirectStatus: 301, redirectLocation: 'https://n.com/x' }),
      ),
    ).toBe(true);
    // 状态码不同
    expect(
      outcomeEqual(
        base,
        sim({ status: 'redirect', redirectStatus: 302, redirectLocation: 'https://n.com/x' }),
      ),
    ).toBe(false);
    // Location 不同
    expect(
      outcomeEqual(
        base,
        sim({ status: 'redirect', redirectStatus: 301, redirectLocation: 'https://n.com/y' }),
      ),
    ).toBe(false);
  });

  it('stopped 只比较终止类型', () => {
    const a = sim({ status: 'stopped', reason: '被第 1 条规则「甲」停止，请求到此终止' });
    const b = sim({ status: 'stopped', reason: '被第 3 条规则「乙」停止，请求到此终止' });
    expect(outcomeEqual(a, b)).toBe(true);
  });

  it('失败只比较失败类型', () => {
    expect(outcomeEqual(sim({ status: 'loop', ok: false }), sim({ status: 'loop', ok: false }))).toBe(true);
    expect(
      outcomeEqual(sim({ status: 'loop', ok: false }), sim({ status: 'max-steps', ok: false })),
    ).toBe(false);
    expect(
      outcomeEqual(
        sim({ status: 'invalid-url', ok: false }),
        sim({ status: 'invalid-target', ok: false }),
      ),
    ).toBe(false);
  });

  it('终止类型不同必为变化', () => {
    expect(
      outcomeEqual(sim({ status: 'final', finalUrl: 'http://x.com/' }), sim({ status: 'stopped' })),
    ).toBe(false);
    expect(
      outcomeEqual(
        sim({ status: 'redirect', redirectStatus: 301, redirectLocation: 'http://x.com/' }),
        sim({ status: 'final', finalUrl: 'http://x.com/' }),
      ),
    ).toBe(false);
  });
});

describe('stepActionOutcome / sameStep（按 rule.id、urlBefore、动作结果比较）', () => {
  const r1 = rule({ id: 'r1', name: '规则一' });

  it('rewrite 的动作结果是重写后 URL', () => {
    const a = step({ rule: r1, urlAfter: 'http://example.com/b' });
    const b = step({ rule: r1, urlAfter: 'http://example.com/b' });
    const c = step({ rule: r1, urlAfter: 'http://example.com/c' });
    expect(stepActionOutcome(a)).toBe(stepActionOutcome(b));
    expect(sameStep(a, b)).toBe(true);
    expect(sameStep(a, c)).toBe(false);
  });

  it('redirect 的动作结果是状态码与 Location', () => {
    const mk = (status: number, location: string) =>
      step({
        rule: rule({ id: 'r1', action: { type: 'redirect', target: 'https://n.com', status } }),
        status,
        location,
      });
    expect(sameStep(mk(301, 'https://n.com/x'), mk(301, 'https://n.com/x'))).toBe(true);
    expect(sameStep(mk(301, 'https://n.com/x'), mk(302, 'https://n.com/x'))).toBe(false);
    expect(sameStep(mk(301, 'https://n.com/x'), mk(301, 'https://n.com/y'))).toBe(false);
  });

  it('stop 没有额外动作结果', () => {
    const mk = () =>
      step({ rule: rule({ id: 'r1', action: { type: 'stop', target: '', status: 302 } }) });
    expect(sameStep(mk(), mk())).toBe(true);
  });

  it('命中规则按 rule.id 比较：同名不同 id 也算差异', () => {
    const a = step({ rule: rule({ id: 'r1', name: '同名' }) });
    const b = step({ rule: rule({ id: 'r2', name: '同名' }) });
    expect(sameStep(a, b)).toBe(false);
  });

  it('urlBefore 不同即差异', () => {
    const a = step({ rule: r1, urlBefore: 'http://example.com/a' });
    const b = step({ rule: r1, urlBefore: 'http://example.com/b' });
    expect(sameStep(a, b)).toBe(false);
  });
});

describe('firstDivergence（首个差异定位）', () => {
  const s1 = step({ n: 1, rule: rule({ id: 'r1' }) });
  const s2 = step({ n: 2, rule: rule({ id: 'r2' }), urlBefore: 'http://example.com/b' });
  const s3 = step({ n: 3, rule: rule({ id: 'r3' }), urlBefore: 'http://example.com/c' });

  it('完全一致的轨迹返回 null', () => {
    expect(firstDivergence([s1, s2], [s1, s2])).toBeNull();
    expect(firstDivergence([], [])).toBeNull();
  });

  it('逐步对齐找到首个差异步', () => {
    const other = step({ n: 2, rule: rule({ id: 'rX' }), urlBefore: 'http://example.com/b' });
    expect(firstDivergence([s1, s2, s3], [s1, other, s3])).toEqual({ index: 1, kind: 'step' });
  });

  it('轨迹长度不同：基线更长', () => {
    expect(firstDivergence([s1, s2, s3], [s1, s2])).toEqual({
      index: 2,
      kind: 'baseline-longer',
    });
  });

  it('轨迹长度不同：当前更长（含一侧为空）', () => {
    expect(firstDivergence([s1], [s1, s2])).toEqual({ index: 1, kind: 'current-longer' });
    expect(firstDivergence([], [s1])).toEqual({ index: 0, kind: 'current-longer' });
  });
});

describe('freezeBaseline（深拷贝快照）', () => {
  it('冻结后修改规则表（含嵌套 action）不影响基线', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
    ];
    const baseline = freezeBaseline(rules);
    rules[0].pathTemplate = '/changed';
    rules[0].action.target = '/hacked';
    rules[0].enabled = false;
    rules.push(rule({ id: 'r2' }));
    expect(baseline.rules).toHaveLength(1);
    expect(baseline.rules[0].pathTemplate).toBe('/a');
    expect(baseline.rules[0].action.target).toBe('/b');
    expect(baseline.rules[0].enabled).toBe(true);
    expect(baseline.frozenAt).toBeTruthy();
  });
});

describe('runRegression（同一引擎分别运行基线与当前规则）', () => {
  const CASE = { id: 'c1', method: 'GET', url: 'http://example.com/a' };

  it('规则改名只改原因文案，不算变化', () => {
    const baselineRules = [
      rule({ id: 'r1', name: '旧名字', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const currentRules = [
      rule({ id: 'r1', name: '新名字', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.baseline.status).toBe('stopped');
    expect(run.baseline.reason).not.toBe(run.current.reason); // 原因文案确实不同
    expect(run.changed).toBe(false);
    expect(run.divergence).toBeNull();
  });

  it('编辑动作目标：检出变化并定位到首个差异步', () => {
    const baselineRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const currentRules = [
      baselineRules[0],
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/d', status: 302 } }),
    ];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.changed).toBe(true);
    expect(run.baseline.finalUrl).toBe('http://example.com/c');
    expect(run.current.finalUrl).toBe('http://example.com/d');
    expect(run.divergence).toEqual({ index: 1, kind: 'step' });
  });

  it('禁用后续规则：轨迹长度不同，正确标记基线更长', () => {
    const baselineRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const currentRules = [baselineRules[0], { ...baselineRules[1], enabled: false }];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.changed).toBe(true);
    expect(run.baseline.steps).toHaveLength(2);
    expect(run.current.steps).toHaveLength(1);
    expect(run.divergence).toEqual({ index: 1, kind: 'baseline-longer' });
  });

  it('redirect 状态码变化即检出', () => {
    const baselineRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'redirect', target: 'https://n.com/x', status: 301 } }),
    ];
    const currentRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'redirect', target: 'https://n.com/x', status: 308 } }),
    ];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.changed).toBe(true);
  });

  it('轨迹不同但最终结果一致：不算变化', () => {
    const baselineRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const currentRules = [
      rule({ id: 'r9', pathTemplate: '/a', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.changed).toBe(false);
    expect(run.divergence).toBeNull();
  });

  it('失败类型变化：final 变成 loop', () => {
    const baselineRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    const currentRules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const [run] = runRegression([CASE], baselineRules, currentRules);
    expect(run.baseline.status).toBe('final');
    expect(run.current.status).toBe('loop');
    expect(run.changed).toBe(true);
  });
});

describe('validateRegressionStore（持久化数据校验，损坏回退为空）', () => {
  it('非对象输入回退为空', () => {
    expect(validateRegressionStore(null)).toEqual(EMPTY_STORE);
    expect(validateRegressionStore('garbage')).toEqual(EMPTY_STORE);
    expect(validateRegressionStore([1, 2, 3])).toEqual(EMPTY_STORE);
    expect(validateRegressionStore(undefined)).toEqual(EMPTY_STORE);
  });

  it('合法数据完整往返', () => {
    const store = {
      baseline: {
        rules: [
          {
            id: 'r1',
            name: '规则一',
            enabled: true,
            method: 'GET',
            host: 'example.com',
            pathTemplate: '/a',
            query: [],
            action: { type: 'redirect', target: 'https://n.com/', status: 301 },
          },
        ],
        frozenAt: '2026-09-18T00:00:00.000Z',
      },
      cases: [{ id: 'c1', method: 'POST', url: 'http://example.com/a' }],
    };
    const parsed = validateRegressionStore(JSON.parse(JSON.stringify(store)));
    expect(parsed.baseline?.frozenAt).toBe('2026-09-18T00:00:00.000Z');
    expect(parsed.baseline?.rules).toHaveLength(1);
    expect(parsed.baseline?.rules[0].action.status).toBe(301);
    expect(parsed.cases).toEqual([{ id: 'c1', method: 'POST', url: 'http://example.com/a' }]);
  });

  it('非法用例被过滤：方法必须是具体请求方法，URL 不能为空', () => {
    const parsed = validateRegressionStore({
      cases: [
        { id: 'ok', method: 'GET', url: 'http://example.com/' },
        { id: 'any', method: 'ANY', url: 'http://example.com/' },
        { id: 'bad', method: 'FOO', url: 'http://example.com/' },
        { id: 'empty', method: 'GET', url: '   ' },
        { id: 'nourl', method: 'GET' },
        'not-an-object',
        42,
      ],
    });
    expect(parsed.cases).toEqual([{ id: 'ok', method: 'GET', url: 'http://example.com/' }]);
  });

  it('用例缺 id 时自动生成', () => {
    const parsed = validateRegressionStore({ cases: [{ method: 'GET', url: 'http://x.com/' }] });
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0].id).toBeTruthy();
  });

  it('基线损坏仅丢弃基线，用例保留', () => {
    const parsed = validateRegressionStore({
      baseline: { rules: [{ method: 'FOO' }], frozenAt: 'x' },
      cases: [{ id: 'c1', method: 'GET', url: 'http://x.com/' }],
    });
    expect(parsed.baseline).toBeNull();
    expect(parsed.cases).toHaveLength(1);
  });

  it('基线字段整体非法时同样回退为 null', () => {
    expect(validateRegressionStore({ baseline: 'garbage', cases: [] }).baseline).toBeNull();
    expect(validateRegressionStore({ baseline: { rules: 'no' }, cases: [] }).baseline).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { minimizeRules } from './minimize';
import { simulate } from './engine';
import { outcomeEqual } from './regression';
import type { Rule } from './types';

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

describe('minimizeRules（请求最小复现）', () => {
  it('剔除与请求无关的规则，保留集按原顺序给出相同 final', () => {
    const rules: Rule[] = [
      rule({
        id: 'irrelevant-1',
        host: 'other.example',
        action: { type: 'redirect', target: 'https://x.com/', status: 301 },
      }),
      rule({
        id: 'r1',
        host: 'api.example.com',
        pathTemplate: '/v1/u/:id',
        action: { type: 'rewrite', target: '/v2/u/:id', status: 302 },
      }),
      rule({
        id: 'r2',
        host: 'api.example.com',
        pathTemplate: '/v2/u/:id',
        action: { type: 'rewrite', target: '/final/u/:id', status: 302 },
      }),
      rule({
        id: 'irrelevant-2',
        host: 'blog.example.com',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const report = minimizeRules(
      rules,
      'GET',
      'http://api.example.com/v1/u/7',
    );

    expect(report.status).toBe('reduced');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['r1', 'r2']);
    expect(report.removed.map((e) => e.rule.id)).toEqual([
      'irrelevant-1',
      'irrelevant-2',
    ]);
    // 下标与原表一致
    expect(report.retained.map((e) => e.index)).toEqual([1, 2]);
    expect(report.original.status).toBe('final');
    expect(report.reduced?.status).toBe('final');
    expect(report.reduced?.finalUrl).toBe(report.original.finalUrl);
    expect(report.attempts).toBeGreaterThan(0);
  });

  it('每条规则都必要时（全部剔除均改变结果），全部保留', () => {
    const rules: Rule[] = [
      rule({
        id: 'r1',
        host: 'a.example.com',
        action: { type: 'rewrite', target: 'http://b.example.com/', status: 302 },
      }),
      rule({
        id: 'r2',
        host: 'b.example.com',
        action: { type: 'redirect', target: 'https://target.example.com/', status: 307 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://a.example.com/');
    expect(report.status).toBe('reduced');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['r1', 'r2']);
    expect(report.removed).toEqual([]);

    // 任意单条删除都会改变可观察结果
    const onlyR1 = simulate([rules[0]], 'GET', 'http://a.example.com/');
    const onlyR2 = simulate([rules[1]], 'GET', 'http://a.example.com/');
    expect(outcomeEqual(onlyR1, report.original)).toBe(false);
    expect(outcomeEqual(onlyR2, report.original)).toBe(false);
  });

  it('首命中转移场景：每次试探重新完整模拟，删除后轨迹改道仍按可观察结果判定', () => {
    // r1 与 r2 都匹配同一请求：r1 在前时把 /a 重写到 /c；删除 r1 后首命中转移到 r2，
    // r2 把 /a 重写到 /d。两条链终点若可观察结果相同，则 r1 应被剔除（不做轨迹复用）。
    const rules: Rule[] = [
      rule({
        id: 'r1',
        host: 'api.example.com',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
      rule({
        id: 'r2',
        host: 'api.example.com',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/d', status: 302 },
      }),
      rule({
        id: 'r3',
        host: 'api.example.com',
        pathTemplate: '/c',
        action: { type: 'rewrite', target: '/same', status: 302 },
      }),
      rule({
        id: 'r4',
        host: 'api.example.com',
        pathTemplate: '/d',
        action: { type: 'rewrite', target: '/same', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://api.example.com/a');
    expect(report.status).toBe('reduced');
    // 只走一条链：要么 {r1,r3}，要么 {r2,r4}，二者可观察结果都是 /same
    const ids = report.retained.map((e) => e.rule.id);
    expect(
      JSON.stringify(ids) === JSON.stringify(['r1', 'r3']) ||
        JSON.stringify(ids) === JSON.stringify(['r2', 'r4']),
    ).toBe(true);
    expect(report.reduced?.finalUrl).toBe('http://api.example.com/same');
  });

  it('redirect 结果：状态码或 Location 改变即视为必要，否则可剔除', () => {
    const rules: Rule[] = [
      rule({
        id: 'a',
        host: 'api.example.com',
        pathTemplate: '/x',
        action: { type: 'redirect', target: 'https://t.example.com/', status: 301 },
      }),
      // 同条件同出口的重复规则：首条永远抢先，第二条可剔除
      rule({
        id: 'b',
        host: 'api.example.com',
        pathTemplate: '/x',
        action: { type: 'redirect', target: 'https://t.example.com/', status: 301 },
      }),
      rule({
        id: 'c',
        host: 'blog.example.com',
        action: { type: 'redirect', target: 'https://y.example.com/', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://api.example.com/x');
    expect(report.status).toBe('reduced');
    // a、b 同条件同出口互为冗余，保留任一条即可（删除试探先遇先剔）
    const retainedIds = report.retained.map((e) => e.rule.id);
    expect(retainedIds.length).toBe(1);
    expect(retainedIds[0] === 'a' || retainedIds[0] === 'b').toBe(true);
    expect(report.removed.map((e) => e.rule.id)).toContain('c');
    expect(report.original.redirectStatus).toBe(301);
    expect(report.reduced?.redirectLocation).toBe('https://t.example.com/');
    expect(report.reduced?.redirectStatus).toBe(301);
  });

  it('stopped 结果只比较终止类型：出口前多余的重写可保留最小停止链路', () => {
    const rules: Rule[] = [
      rule({
        id: 'to-stop',
        host: 'api.example.com',
        pathTemplate: '/go',
        action: { type: 'rewrite', target: '/halt', status: 302 },
      }),
      rule({
        id: 'stop',
        host: 'api.example.com',
        pathTemplate: '/halt',
        action: { type: 'stop', target: '', status: 302 },
      }),
      rule({
        id: 'noise',
        host: 'other.example.com',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://api.example.com/go');
    expect(report.status).toBe('reduced');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['to-stop', 'stop']);
    expect(report.removed.map((e) => e.rule.id)).toEqual(['noise']);
    expect(report.reduced?.status).toBe('stopped');
  });

  it('循环 / 超限等失败类型也只比较终止类型，可剔除无关规则', () => {
    const rules: Rule[] = [
      rule({
        id: 'loop-a',
        host: 'l.example.com',
        pathTemplate: '/1',
        action: { type: 'rewrite', target: '/2', status: 302 },
      }),
      rule({
        id: 'loop-b',
        host: 'l.example.com',
        pathTemplate: '/2',
        action: { type: 'rewrite', target: '/1', status: 302 },
      }),
      rule({
        id: 'noise',
        host: 'n.example.com',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://l.example.com/1');
    expect(report.status).toBe('reduced');
    expect(report.original.status).toBe('loop');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['loop-a', 'loop-b']);
    expect(report.reduced?.status).toBe('loop');
  });

  it('没有任何规则命中（0 步放行）时返回 no-hit，无法缩减', () => {
    const rules: Rule[] = [
      rule({ id: 'a', host: 'a.example.com', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://b.example.com/');
    expect(report.status).toBe('no-hit');
    expect(report.original.status).toBe('final');
    expect(report.original.steps).toHaveLength(0);
    expect(report.retained).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.reduced).toBeNull();
  });

  it('全部规则停用时同样无命中，返回 no-hit 且 disabled 列出全部', () => {
    const rules: Rule[] = [
      rule({
        id: 'a',
        enabled: false,
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://example.com/');
    expect(report.status).toBe('no-hit');
    expect(report.disabled.map((e) => e.rule.id)).toEqual(['a']);
  });

  it('URL 非法时返回 invalid-url，无法缩减', () => {
    const rules: Rule[] = [
      rule({ id: 'a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const report = minimizeRules(rules, 'GET', 'not a url');
    expect(report.status).toBe('invalid-url');
    expect(report.original.status).toBe('invalid-url');
    expect(report.retained).toEqual([]);
    expect(report.reduced).toBeNull();
    expect(report.attempts).toBe(0);
  });

  it('未启用规则不参与试探，仍按原顺序出现在 disabled 中', () => {
    const rules: Rule[] = [
      rule({
        id: 'off-1',
        enabled: false,
        host: 'api.example.com',
        action: { type: 'redirect', target: 'https://off.example.com/', status: 301 },
      }),
      rule({
        id: 'on',
        host: 'api.example.com',
        action: { type: 'stop', target: '', status: 302 },
      }),
      rule({
        id: 'off-2',
        enabled: false,
        action: { type: 'redirect', target: 'https://off2.example.com/', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://api.example.com/');
    expect(report.status).toBe('reduced');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['on']);
    expect(report.disabled.map((e) => e.rule.id)).toEqual(['off-1', 'off-2']);
    expect(report.disabled.map((e) => e.index)).toEqual([0, 2]);
  });

  it('结果对后续规则编辑免疫（冻结快照）', () => {
    const rules: Rule[] = [
      rule({
        id: 'a',
        host: 'api.example.com',
        action: { type: 'redirect', target: 'https://t.example.com/', status: 301 },
      }),
      rule({
        id: 'b',
        host: 'other.example.com',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://api.example.com/');
    rules[0].action.target = 'https://tampered.example.com/';
    expect(report.status).toBe('reduced');
    expect(report.retained[0].rule.action.target).toBe('https://t.example.com/');
    expect(report.original.redirectLocation).toBe('https://t.example.com/');
  });

  it('较大规则集上结果满足 1-最小：任意单条保留规则再删除都会改变可观察结果', () => {
    const rules: Rule[] = [
      rule({ id: 'c0', host: 'h0.example', action: { type: 'stop', target: '', status: 302 } }),
      rule({
        id: 's0',
        host: 'a.example.com',
        pathTemplate: '/p/0',
        action: { type: 'rewrite', target: '/p/1', status: 302 },
      }),
      rule({ id: 'c1', host: 'h1.example', action: { type: 'stop', target: '', status: 302 } }),
      rule({
        id: 's1',
        host: 'a.example.com',
        pathTemplate: '/p/1',
        action: { type: 'rewrite', target: '/p/2', status: 302 },
      }),
      rule({ id: 'c2', host: 'h2.example', action: { type: 'stop', target: '', status: 302 } }),
      rule({
        id: 's2',
        host: 'a.example.com',
        pathTemplate: '/p/2',
        action: { type: 'redirect', target: 'https://done.example.com/', status: 308 },
      }),
      rule({ id: 'c3', host: 'h3.example', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const report = minimizeRules(rules, 'GET', 'http://a.example.com/p/0');
    expect(report.status).toBe('reduced');
    expect(report.retained.map((e) => e.rule.id)).toEqual(['s0', 's1', 's2']);
    expect(report.removed.map((e) => e.rule.id)).toEqual(['c0', 'c1', 'c2', 'c3']);

    // 1-最小性：再删任意一条保留规则，可观察结果必然改变
    for (const entry of report.retained) {
      const keep = report.retained
        .filter((e) => e !== entry)
        .map((e) => e.rule);
      const sim = simulate(keep, 'GET', 'http://a.example.com/p/0');
      const sameStatus = sim.status === report.original.status;
      let sameOutcome = sameStatus;
      if (sameStatus && sim.status === 'redirect') {
        sameOutcome =
          sim.redirectStatus === report.original.redirectStatus &&
          sim.redirectLocation === report.original.redirectLocation;
      }
      expect(sameOutcome).toBe(false);
    }
  });
});

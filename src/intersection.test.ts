import { describe, expect, it } from 'vitest';
import {
  analyzePartialIntersections,
  intersectHost,
  intersectMethod,
  intersectPath,
  intersectQuery,
} from './intersection';
import { findMatch, matchHost, matchPath, matchQuery } from './engine';
import type { QueryCondition, Rule } from './types';

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

function cond(partial: Partial<QueryCondition> & { name: string }): QueryCondition {
  return { op: 'exists', value: '', ...partial };
}

describe('intersectMethod', () => {
  it('相同具体方法取该方法', () => {
    expect(intersectMethod('GET', 'GET')).toBe('GET');
    expect(intersectMethod('POST', 'POST')).toBe('POST');
  });

  it('不同具体方法无交集', () => {
    expect(intersectMethod('GET', 'POST')).toBeNull();
  });

  it('ANY 与具体方法取具体方法', () => {
    expect(intersectMethod('ANY', 'GET')).toBe('GET');
    expect(intersectMethod('DELETE', 'ANY')).toBe('DELETE');
  });

  it('两个 ANY 取一个确定的具体方法', () => {
    expect(intersectMethod('ANY', 'ANY')).not.toBeNull();
    expect(intersectMethod('ANY', 'ANY')).not.toBe('ANY');
  });
});

describe('intersectHost', () => {
  it('两个相同的具体主机', () => {
    expect(intersectHost('api.example.com', 'API.example.com')).toBe('api.example.com');
  });

  it('不同具体主机无交集', () => {
    expect(intersectHost('a.example.com', 'b.example.com')).toBeNull();
  });

  it('* 与具体主机取具体主机', () => {
    expect(intersectHost('*', 'api.example.com')).toBe('api.example.com');
  });

  it('两个 * 给出一个具体主机见证', () => {
    expect(intersectHost('*', '*')).not.toBeNull();
  });

  it('通配子域取至少一级子域（不含裸域）', () => {
    const h = intersectHost('*.example.com', '*');
    expect(h).toBeTruthy();
    expect(h!.endsWith('.example.com')).toBe(true);
    expect(h!.length).toBeGreaterThan('.example.com'.length);
  });

  it('通配子域 + 具体主机：子域有交集、裸域无交集', () => {
    expect(intersectHost('*.example.com', 'api.example.com')).toBe('api.example.com');
    expect(intersectHost('*.example.com', 'example.com')).toBeNull();
    expect(intersectHost('*.example.com', 'notexample.com')).toBeNull();
  });

  it('两个通配子域：相同取子域、祖孙取更深者、无关无交集', () => {
    expect(intersectHost('*.example.com', '*.example.com')).toBe('w.example.com');
    expect(intersectHost('*.example.com', '*.sub.example.com')).toBe('w.sub.example.com');
    expect(intersectHost('*.a.example.com', '*.example.com')).toBe('w.a.example.com');
    expect(intersectHost('*.a.com', '*.b.com')).toBeNull();
  });

  it('空主机模式无交集', () => {
    expect(intersectHost('', 'api.example.com')).toBeNull();
    expect(intersectHost('*', '')).toBeNull();
  });
});

describe('intersectPath', () => {
  it('两个任意路径给出具体见证', () => {
    expect(intersectPath('', '')).toBe('/');
    expect(intersectPath('*', '*')).toBe('/');
  });

  it('任意路径与具体模板：见证具体化为对方', () => {
    expect(intersectPath('*', '/users/:id')).toBe('/users/id');
    expect(intersectPath('', '/a/b')).toBe('/a/b');
  });

  it('相同字面段', () => {
    expect(intersectPath('/users/list', '/users/list')).toBe('/users/list');
  });

  it('字面段冲突无交集', () => {
    expect(intersectPath('/users/list', '/users/detail')).toBeNull();
  });

  it('段数不同无交集', () => {
    expect(intersectPath('/users/:id', '/users/42/extra')).toBeNull();
    expect(intersectPath('/a', '/a/b')).toBeNull();
  });

  it('参数段与字面段兼容，见证取字面值', () => {
    expect(intersectPath('/users/:id', '/users/42')).toBe('/users/42');
    expect(intersectPath('/users/list', '/users/:id')).toBe('/users/list');
  });

  it('两个参数段取任一参数名', () => {
    expect(intersectPath('/:a/x', '/:b/x')).toBe('/a/x');
  });

  it('含空名参数段的模板永不命中', () => {
    expect(intersectPath('/:/x', '/a/x')).toBeNull();
    expect(intersectPath('/a/x', '/:/x')).toBeNull();
  });
});

describe('intersectQuery', () => {
  it('双方都无条件：空参数', () => {
    expect(intersectQuery([], [])).toEqual([]);
  });

  it('一方要求存在、另一方无条件：各补一个占位值', () => {
    expect(intersectQuery([cond({ name: 'debug' })], [])).toEqual([
      { name: 'debug', value: '1' },
    ]);
  });

  it('相同 equals 值只出现一次', () => {
    const c = cond({ name: 'env', op: 'equals', value: 'canary' });
    expect(intersectQuery([c], [c])).toEqual([{ name: 'env', value: 'canary' }]);
  });

  it('不同 equals 值用同名重复参数同时满足', () => {
    const p = intersectQuery(
      [cond({ name: 'x', op: 'equals', value: 'a' })],
      [cond({ name: 'x', op: 'equals', value: 'b' })],
    );
    expect(p).toEqual([
      { name: 'x', value: 'a' },
      { name: 'x', value: 'b' },
    ]);
  });

  it('exists 与 equals：见证带上 equals 值即可', () => {
    expect(
      intersectQuery(
        [cond({ name: 'env' })],
        [cond({ name: 'env', op: 'equals', value: 'canary' })],
      ),
    ).toEqual([{ name: 'env', value: 'canary' }]);
  });

  it('not-exists 与要求出现冲突时无交集', () => {
    expect(
      intersectQuery(
        [cond({ name: 'token', op: 'not-exists' })],
        [cond({ name: 'token' })],
      ),
    ).toBeNull();
    expect(
      intersectQuery(
        [cond({ name: 'token', op: 'not-exists' })],
        [cond({ name: 'token', op: 'equals', value: 'x' })],
      ),
    ).toBeNull();
  });

  it('双方都要求不存在：无交集（即不需要任何参数）', () => {
    expect(
      intersectQuery(
        [cond({ name: 'token', op: 'not-exists' })],
        [cond({ name: 'token', op: 'not-exists' })],
      ),
    ).toEqual([]);
  });

  it('一方要求 x 不存在、另一方只要求 y 存在：保留 y', () => {
    expect(
      intersectQuery(
        [cond({ name: 'x', op: 'not-exists' })],
        [cond({ name: 'y', op: 'equals', value: '2' })],
      ),
    ).toEqual([{ name: 'y', value: '2' }]);
  });

  it('规则自身矛盾（同名 not-exists 又要求出现）：无交集', () => {
    expect(
      intersectQuery(
        [cond({ name: 'x', op: 'not-exists' }), cond({ name: 'x' })],
        [],
      ),
    ).toBeNull();
  });

  it('多条条件 AND 组合：equals 与其他不相关参数并存', () => {
    const p = intersectQuery(
      [cond({ name: 'debug' }), cond({ name: 'env', op: 'equals', value: 'canary' })],
      [cond({ name: 'env', op: 'equals', value: 'prod' })],
    );
    // env 需要两个值，debug 需要出现
    expect(p).toContainEqual({ name: 'env', value: 'canary' });
    expect(p).toContainEqual({ name: 'env', value: 'prod' });
    expect(p).toContainEqual({ name: 'debug', value: '1' });
  });
});

describe('analyzePartialIntersections', () => {
  /** 断言见证 URL 确实同时命中两条规则 */
  function assertWitnessHitsBoth(rules: Rule[], w: ReturnType<typeof analyzePartialIntersections>[number]) {
    const url = new URL(w.url);
    const params = url.searchParams;
    const a = rules[w.aIndex];
    const b = rules[w.bIndex];
    for (const r of [a, b]) {
      if (r.method !== 'ANY') expect(r.method).toBe(w.method);
      expect(matchHost(r.host, url.hostname)).toBe(true);
      expect(matchPath(r.pathTemplate, url.pathname)).not.toBeNull();
      expect(matchQuery(r.query ?? [], params)).toBe(true);
    }
  }

  it('相同方法 / 主机、不同 equals 值：部分交集，见证用同名重复参数', () => {
    const rules = [
      rule({ id: 'canary', query: [cond({ name: 'env', op: 'equals', value: 'canary' })] }),
      rule({ id: 'prod', query: [cond({ name: 'env', op: 'equals', value: 'prod' })] }),
    ];
    const out = analyzePartialIntersections(rules);
    expect(out).toHaveLength(1);
    const w = out[0];
    expect(w.aRuleId).toBe('canary');
    expect(w.bRuleId).toBe('prod');
    expect(w.url).toContain('env=canary');
    expect(w.url).toContain('env=prod');
    assertWitnessHitsBoth(rules, w);
  });

  it('主机相同、路径段数不同：无交集，不报告', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/v1/users' }),
      rule({ id: 'r2', pathTemplate: '/v1/users/:id' }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('方法不同：无交集', () => {
    const rules = [
      rule({ id: 'g', method: 'GET', pathTemplate: '/x' }),
      rule({ id: 'p', method: 'POST', pathTemplate: '/x' }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('路径参数交叉：/users/:id/profile 与 /users/me/:section 互不完整覆盖', () => {
    const rules = [
      rule({ id: 'p1', method: 'GET', host: 'h.com', pathTemplate: '/users/:id/profile' }),
      rule({ id: 'p2', method: 'GET', host: 'h.com', pathTemplate: '/users/me/:section' }),
    ];
    const out = analyzePartialIntersections(rules);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('http://h.com/users/me/profile');
    assertWitnessHitsBoth(rules, out[0]);
  });

  it('单纯参数段对字面段是完整覆盖，不算部分交集', () => {
    const rules = [
      rule({ id: 'param', method: 'GET', host: 'h.com', pathTemplate: '/users/:id' }),
      rule({ id: 'list', method: 'GET', host: 'h.com', pathTemplate: '/users/list' }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('通配子域与具体子域：路径宽严交叉时构成部分交集，见证落在子域', () => {
    const rules = [
      rule({ id: 'wild', host: '*.example.com', pathTemplate: '/a' }),
      rule({ id: 'api', host: 'api.example.com', pathTemplate: '' }),
    ];
    const out = analyzePartialIntersections(rules);
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('://api.example.com/a');
    assertWitnessHitsBoth(rules, out[0]);
  });

  it('单纯通配子域对具体子域是完整覆盖，不算部分交集', () => {
    const rules = [
      rule({ id: 'wild', host: '*.example.com', pathTemplate: '/a' }),
      rule({ id: 'api', host: 'api.example.com', pathTemplate: '/a' }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('两个通配子域（祖孙后缀）配合路径宽严交叉：见证取更深后缀', () => {
    const rules = [
      rule({ id: 'w1', host: '*.example.com', pathTemplate: '/a' }),
      rule({ id: 'w2', host: '*.sub.example.com', pathTemplate: '' }),
    ];
    const out = analyzePartialIntersections(rules);
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('.sub.example.com/a');
    assertWitnessHitsBoth(rules, out[0]);
  });

  it('查询 not-exists 与 exists 冲突：不报告', () => {
    const rules = [
      rule({ id: 'no-token', query: [cond({ name: 'token', op: 'not-exists' })] }),
      rule({ id: 'token', query: [cond({ name: 'token' })] }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('完整覆盖的规则对不报告（遮蔽场景）', () => {
    const rules = [
      rule({ id: 'wide', host: '*', pathTemplate: '' }),
      rule({ id: 'narrow', host: 'api.example.com', pathTemplate: '/x' }),
      rule({ id: 'copy', host: 'api.example.com', pathTemplate: '/x' }),
    ];
    // wide 完整覆盖 narrow / copy；narrow 与 copy 完全相同（互相完整覆盖）
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('实际先命中的是对中更早的一条', () => {
    const rules = [
      rule({ id: 'a', method: 'GET', host: 'h.com', pathTemplate: '/users/:id/profile' }),
      rule({ id: 'b', method: 'GET', host: 'h.com', pathTemplate: '/users/me/:section' }),
    ];
    const out = analyzePartialIntersections(rules);
    expect(out[0].winnerRuleId).toBe('a');
    expect(out[0].winnerInPair).toBe(true);
    // 与引擎的首条命中一致
    expect(findMatch(rules, out[0].method, new URL(out[0].url))?.rule.id).toBe('a');
  });

  it('实际先命中的是更早的第三条规则', () => {
    const rules = [
      rule({ id: 'third', method: 'GET', host: 'h.com', pathTemplate: '/users/me/profile' }),
      rule({ id: 'p1', method: 'GET', host: 'h.com', pathTemplate: '/users/:id/profile' }),
      rule({ id: 'p2', method: 'GET', host: 'h.com', pathTemplate: '/users/me/:section' }),
    ];
    const out = analyzePartialIntersections(rules);
    // p1 与 p2 部分交集（third 与二者的组合都是完整覆盖，不单独成见证）
    const pair = out.find((w) => w.aRuleId === 'p1' && w.bRuleId === 'p2');
    expect(pair).toBeTruthy();
    expect(pair!.winnerRuleId).toBe('third');
    expect(pair!.winnerInPair).toBe(false);
    expect(findMatch(rules, pair!.method, new URL(pair!.url))?.rule.id).toBe('third');
  });

  it('禁用规则不参与分析', () => {
    const rules = [
      rule({ id: 'off', enabled: false, query: [cond({ name: 'env', op: 'equals', value: 'a' })] }),
      rule({ id: 'b', query: [cond({ name: 'env', op: 'equals', value: 'b' })] }),
    ];
    expect(analyzePartialIntersections(rules)).toEqual([]);
  });

  it('按规则表顺序输出，调整顺序后见证的先命中方随之变化', () => {
    const p1 = rule({ id: 'p1', method: 'GET', host: 'h.com', pathTemplate: '/users/:id/profile' });
    const p2 = rule({ id: 'p2', method: 'GET', host: 'h.com', pathTemplate: '/users/me/:section' });
    const out1 = analyzePartialIntersections([p1, p2]);
    expect(out1).toHaveLength(1);
    expect(out1[0].aRuleId).toBe('p1');
    expect(out1[0].winnerRuleId).toBe('p1');

    const out2 = analyzePartialIntersections([p2, p1]);
    expect(out2[0].winnerRuleId).toBe('p2');
  });

  it('内置示例规则表不产生部分交集（避免默认噪音）', async () => {
    const { SAMPLE_RULES } = await import('./samples');
    expect(analyzePartialIntersections(SAMPLE_RULES)).toEqual([]);
  });

  it('分析不修改规则表（纯函数）', () => {
    const rules = [
      rule({ id: 'a', method: 'GET', host: 'h.com', pathTemplate: '/users/:id' }),
      rule({ id: 'b', method: 'GET', host: 'h.com', pathTemplate: '/users/list' }),
    ];
    const snapshot = JSON.stringify(rules);
    analyzePartialIntersections(rules);
    expect(JSON.stringify(rules)).toBe(snapshot);
  });
});

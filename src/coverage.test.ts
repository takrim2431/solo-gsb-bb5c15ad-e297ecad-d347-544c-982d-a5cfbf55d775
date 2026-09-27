import { describe, expect, it } from 'vitest';
import {
  parseSamples,
  runCoverageAudit,
} from './coverage';
import { simulate } from './engine';
import type { Rule } from './types';
import { validateRules } from './validate';

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

describe('parseSamples', () => {
  it('按行解析 METHOD URL，空行跳过但保留原始行号', () => {
    const text = [
      'GET http://a.example.com/x',
      '',
      '   ',
      'post https://b.example.com/y?z=1',
    ].join('\n');
    const samples = parseSamples(text);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      line: 1,
      method: 'GET',
      url: 'http://a.example.com/x',
      parseError: null,
    });
    expect(samples[1]).toMatchObject({
      line: 4,
      method: 'POST',
      url: 'https://b.example.com/y?z=1',
      parseError: null,
    });
  });

  it('方法大小写不敏感，支持制表符分隔并保留原文', () => {
    const [s] = parseSamples('get\thttp://example.com/');
    expect(s.method).toBe('GET');
    expect(s.raw).toBe('get\thttp://example.com/');
  });

  it('缺少 URL、非法方法、URL 含空白都标记为解析错误', () => {
    const samples = parseSamples(
      ['GET', 'FOO http://example.com/', 'GET http://example.com/ extra'].join('\n'),
    );
    expect(samples.map((s) => s.parseError)).toEqual([
      expect.stringContaining('METHOD URL'),
      expect.stringContaining('不支持的请求方法'),
      expect.stringContaining('空白字符'),
    ]);
    for (const s of samples) {
      expect(s.method === null || s.url === null).toBe(true);
    }
  });

  it('ANY 不是合法的请求方法', () => {
    const [s] = parseSamples('ANY http://example.com/');
    expect(s.parseError).toContain('不支持的请求方法');
  });
});

describe('runCoverageAudit', () => {
  it('单条规则的命中请求数与执行次数；重写重复命中请求数只计一次', () => {
    // /start → /done → /done?x=1（r-done 自我重写，状态重复后判循环）
    const rules = [
      rule({
        id: 'r-start',
        host: 'a.example.com',
        pathTemplate: '/start',
        action: { type: 'rewrite', target: '/done', status: 302 },
      }),
      rule({
        id: 'r-done',
        host: 'a.example.com',
        pathTemplate: '/done',
        action: { type: 'rewrite', target: '/done?x=1', status: 302 },
      }),
    ];
    const samples = parseSamples(
      ['GET http://a.example.com/start', 'GET http://a.example.com/done'].join(
        '\n',
      ),
    );
    const report = runCoverageAudit(samples, rules);

    const start = report.ruleStats.find((r) => r.ruleId === 'r-start')!;
    expect(start.requestCount).toBe(1);
    expect(start.executionCount).toBe(1);

    const done = report.ruleStats.find((r) => r.ruleId === 'r-done')!;
    // 两个样本都经过 r-done（请求数 2）；每个样本都因重写绕回命中两次（执行 4 次）
    expect(done.requestCount).toBe(2);
    expect(done.executionCount).toBe(4);
    // 命中明细按样本分组，同一样本的两次执行步骤都保留
    expect(done.hits.map((h) => h.steps.length)).toEqual([2, 2]);
    expect(done.hits.map((h) => h.sampleId)).toEqual(
      samples.map((s) => s.id),
    );
  });

  it('循环样本归入 loops，未命中任何规则归入 unmatched', () => {
    const rules = [
      rule({
        id: 'r1',
        host: 'a.example.com',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'r2',
        host: 'a.example.com',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/a', status: 302 },
      }),
    ];
    const samples = parseSamples(
      [
        'GET http://a.example.com/a',
        'GET http://other.example.com/whatever',
      ].join('\n'),
    );
    const report = runCoverageAudit(samples, rules);

    expect(report.loops).toHaveLength(1);
    expect(report.loops[0].sample.url).toBe('http://a.example.com/a');
    expect(report.unmatched).toHaveLength(1);
    expect(report.unmatched[0].sample.url).toBe(
      'http://other.example.com/whatever',
    );
    // 与 simulate 语义一致
    const direct = simulate(rules, 'GET', 'http://a.example.com/a');
    expect(direct.status).toBe('loop');
  });

  it('非法 URL 与行解析失败都归入 invalid；重定向 / 停止不算未命中', () => {
    const rules = [
      rule({
        id: 'r-stop',
        host: 'a.example.com',
        pathTemplate: '/stop',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const samples = parseSamples(
      [
        'GET not-a-url',
        'GET', // 行解析失败
        'GET http://a.example.com/stop',
      ].join('\n'),
    );
    const report = runCoverageAudit(samples, rules);
    expect(report.invalid).toHaveLength(2);
    expect(report.invalid.map((r) => r.status).sort()).toEqual([
      'invalid-input',
      'invalid-url',
    ]);
    expect(report.unmatched).toHaveLength(0);

    const stop = report.ruleStats.find((r) => r.ruleId === 'r-stop')!;
    expect(stop.requestCount).toBe(1);
    expect(stop.executionCount).toBe(1);
  });

  it('动作目标无法解析归入 invalidTarget', () => {
    const rules = [
      rule({
        id: 'r-bad',
        host: 'a.example.com',
        pathTemplate: '/x',
        action: { type: 'redirect', target: 'http://', status: 301 },
      }),
    ];
    const samples = parseSamples('GET http://a.example.com/x');
    const report = runCoverageAudit(samples, rules);
    expect(report.invalidTarget).toHaveLength(1);
    expect(report.invalid).toHaveLength(0);
    const stat = report.ruleStats.find((r) => r.ruleId === 'r-bad')!;
    expect(stat.executionCount).toBe(1);
  });

  it('超过 20 步上限归入 maxSteps', () => {
    // 每条规则把路径中的计数 +1，链式 21 条 → 跑完 20 步仍未终止
    const raw: Rule[] = [];
    for (let i = 0; i < 21; i++) {
      raw.push(
        rule({
          id: `r${i}`,
          name: `r${i}`,
          host: 'a.example.com',
          pathTemplate: `/p${i}`,
          action: { type: 'rewrite', target: `/p${i + 1}`, status: 302 },
        }),
      );
    }
    const samples = parseSamples('GET http://a.example.com/p0');
    const report = runCoverageAudit(samples, raw);
    expect(report.maxSteps).toHaveLength(1);
    expect(report.maxSteps[0].sim?.steps).toHaveLength(20);
  });

  it('完全相同的样本按多条独立请求计数', () => {
    const rules = [
      rule({
        id: 'r1',
        host: 'a.example.com',
        pathTemplate: '/x',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const samples = parseSamples(
      'GET http://a.example.com/x\nGET http://a.example.com/x',
    );
    const report = runCoverageAudit(samples, rules);
    const stat = report.ruleStats[0];
    expect(stat.requestCount).toBe(2);
    expect(stat.executionCount).toBe(2);
    expect(stat.hits).toHaveLength(2);
  });

  it('0 命中规则与停用规则同样出现在清单中', () => {
    const rules = validateRules([
      {
        id: 'on',
        name: '启用',
        enabled: true,
        method: 'ANY',
        host: 'a.example.com',
        pathTemplate: '/x',
        action: { type: 'stop', target: '', status: 302 },
      },
      {
        id: 'off',
        name: '停用',
        enabled: false,
        method: 'ANY',
        host: 'a.example.com',
        pathTemplate: '/x',
        action: { type: 'stop', target: '', status: 302 },
      },
      {
        id: 'never',
        name: '没人命中',
        enabled: true,
        method: 'ANY',
        host: 'b.example.com',
        pathTemplate: '/y',
        action: { type: 'stop', target: '', status: 302 },
      },
    ]);
    const samples = parseSamples('GET http://a.example.com/x');
    const report = runCoverageAudit(samples, rules);
    expect(report.ruleStats.map((r) => r.ruleId)).toEqual(['on', 'off', 'never']);
    expect(report.ruleStats.map((r) => r.enabled)).toEqual([true, false, true]);
    expect(report.ruleStats.map((r) => r.requestCount)).toEqual([1, 0, 0]);
  });
});

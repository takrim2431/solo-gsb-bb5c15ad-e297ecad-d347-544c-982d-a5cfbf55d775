import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findBundleIssues, generateBundle } from './bundle';
import { MAX_STEPS, simulate } from './engine';
import { SAMPLE_RULES } from './samples';
import type { QueryCondition, Rule, Simulation } from './types';

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

// 临时目录放在项目内（node_modules/.cache），保证 vitest 可以动态 import
const tmpDir = join(process.cwd(), 'node_modules', '.cache', 'route-bundle-test');
mkdirSync(tmpDir, { recursive: true });
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;
/** 把规则生成为 bundle 文件并返回文件路径（文件名唯一，避免模块缓存） */
function writeBundle(rules: Rule[]): string {
  const file = join(tmpDir, `route-bundle-${counter++}.mjs`);
  writeFileSync(file, generateBundle(rules));
  return file;
}

type RouteFn = (method: string, url: string) => Simulation;

/** 动态导入生成的 bundle，取出 route() */
async function loadRoute(rules: Rule[]): Promise<RouteFn> {
  const file = writeBundle(rules);
  const mod = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as { route: RouteFn };
  return mod.route;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 以子进程方式运行 `node route-bundle.mjs ...`，与真实使用场景一致 */
function runCli(file: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync('node', [file, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** 与引擎结果做结构化对比（经过 JSON 往返，忽略函数与键序） */
function expectSameAsEngine(rules: Rule[], actual: Simulation, method: string, url: string) {
  const expected = simulate(rules, method, url);
  expect(JSON.parse(JSON.stringify(actual))).toEqual(
    JSON.parse(JSON.stringify(expected)),
  );
}

describe('generateBundle', () => {
  it('生成物内嵌全部已启用规则，不含未启用规则', () => {
    const rules = [
      rule({ id: 'on-1', name: '启用规则' }),
      rule({ id: 'off-1', name: '停用规则', enabled: false }),
    ];
    const code = generateBundle(rules);
    expect(code).toContain('on-1');
    expect(code).not.toContain('off-1');
    expect(code).not.toContain('停用规则');
  });

  it('生成物不引用项目源码与第三方包', () => {
    const code = generateBundle(SAMPLE_RULES);
    // 只允许 node: 内置模块导入
    const imports = code.match(/^import .* from '(.+)';$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).toMatch(/from 'node:/);
    }
    expect(code).not.toContain('./engine');
    expect(code).not.toContain('react');
  });

  it('规则内容含 $ 序列与引号时仍能安全内嵌', async () => {
    const rules = [
      rule({
        id: 'tricky',
        name: '含 $& $\' $` 与 "引号" 的规则',
        pathTemplate: '/a',
        query: [],
        action: { type: 'rewrite', target: '/b?x=$&', status: 302 },
      }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/a');
    expect(sim.status).toBe('final');
    expect(sim.finalUrl).toBe('http://example.com/b?x=$&');
  });
});

describe('生成物与引擎语义一致', () => {
  it('示例规则表：链式重写 / 重定向 / 通配子域 / 停止 / 无命中', async () => {
    const route = await loadRoute(SAMPLE_RULES);
    const cases: Array<[string, string]> = [
      ['GET', 'http://api.example.com/v1/users/42?debug=1'],
      ['GET', 'http://blog.example.com/posts/hello-world'],
      ['GET', 'http://img.cdn.example.com/assets/logo.png'],
      ['POST', 'http://internal.example.com/admin/secret-token'],
      ['GET', 'http://unknown.example.com/nothing'],
    ];
    for (const [method, url] of cases) {
      expectSameAsEngine(SAMPLE_RULES, route(method, url), method, url);
    }
  });

  it('首条命中生效，重写后从第一条重新匹配', async () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/a', action: { type: 'rewrite', target: '/never', status: 302 } }),
      rule({ id: 'r3', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/a');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/a');
    expect(sim.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(sim.finalUrl).toBe('http://example.com/c');
  });

  it('路径参数捕获并替换进目标（含解码 / 重编码）', async () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/users/:id/files/:name',
        query: [],
        action: { type: 'rewrite', target: '/internal/:id/:name', status: 302 },
      }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/users/7/files/a%20b');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/users/7/files/a%20b');
    expect(sim.steps[0].params).toEqual({ id: '7', name: 'a b' });
    expect(sim.finalUrl).toBe('http://example.com/internal/7/a%20b');
  });

  it('目标不含查询串时保留原查询串', async () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/x', action: { type: 'rewrite', target: '/y', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/x?debug=1#frag');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/x?debug=1#frag');
    expect(sim.finalUrl).toBe('http://example.com/y?debug=1#frag');
  });

  it('重定向立即终止并给出状态码与 Location', async () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/old/:slug',
        query: [],
        action: { type: 'redirect', target: 'https://new.com/:slug', status: 301 },
      }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/old/hello');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/old/hello');
    expect(sim.status).toBe('redirect');
    expect(sim.redirectStatus).toBe(301);
    expect(sim.redirectLocation).toBe('https://new.com/hello');
  });

  it('A↔B 往返判定为循环', async () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/a');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/a');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
  });

  it(`超过 ${MAX_STEPS} 步判定超限`, async () => {
    const rules: Rule[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        query: [],
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/s0');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/s0');
    expect(sim.status).toBe('max-steps');
    expect(sim.steps).toHaveLength(MAX_STEPS);
  });

  it(`恰好 ${MAX_STEPS} 次重写后到达无命中 URL：成功终止并给出最终 URL`, async () => {
    // 20 条链式 rewrite：/s0 -> /s1 -> ... -> /s20，/s20 无任何规则命中
    const rules: Rule[] = Array.from({ length: MAX_STEPS }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        query: [],
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/s0');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/s0');
    expect(sim.status).toBe('final');
    expect(sim.ok).toBe(true);
    expect(sim.finalUrl).toBe(`http://example.com/s${MAX_STEPS}`);
    expect(sim.steps).toHaveLength(MAX_STEPS);
  });

  it(`第 ${MAX_STEPS} 步重写后落到已见状态：判循环而非超限`, async () => {
    // 19 条链式 rewrite 后，最后一条把 /s19 重写回已见的 /s0
    const rules: Rule[] = Array.from({ length: MAX_STEPS - 1 }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        query: [],
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    rules.push(
      rule({
        id: 'back',
        pathTemplate: `/s${MAX_STEPS - 1}`,
        query: [],
        action: { type: 'rewrite', target: '/s0', status: 302 },
      }),
    );
    const route = await loadRoute(rules);
    const sim = route('GET', 'http://example.com/s0');
    expectSameAsEngine(rules, sim, 'GET', 'http://example.com/s0');
    expect(sim.status).toBe('loop');
    expect(sim.ok).toBe(false);
    expect(sim.steps).toHaveLength(MAX_STEPS);
  });

  it('非法输入 URL 与非法动作目标', async () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'redirect', target: 'http://', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    expectSameAsEngine(rules, route('GET', 'not a url'), 'GET', 'not a url');
    expect(route('GET', 'not a url').status).toBe('invalid-url');
    const bad = route('GET', 'http://example.com/a');
    expectSameAsEngine(rules, bad, 'GET', 'http://example.com/a');
    expect(bad.status).toBe('invalid-target');
  });

  it('方法匹配：ANY 与具体方法，状态键含方法', async () => {
    const rules = [
      rule({ id: 'r1', method: 'POST', pathTemplate: '/p', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    expect(route('POST', 'http://example.com/p').status).toBe('stopped');
    expect(route('GET', 'http://example.com/p').status).toBe('final');
    // 方法小写输入统一按大写处理
    expect(route('post', 'http://example.com/p').status).toBe('stopped');
  });

  it('查询条件：存在 / 不存在 / 值等于与调试台引擎一致', async () => {
    const rules = [
      rule({
        id: 'gray',
        pathTemplate: '/a',
        query: [{ name: 'env', op: 'equals', value: 'canary' }],
        action: { type: 'rewrite', target: '/gray', status: 302 },
      }),
      rule({
        id: 'no-token',
        pathTemplate: '/a',
        query: [{ name: 'token', op: 'not-exists', value: '' }],
        action: { type: 'rewrite', target: '/bare', status: 302 },
      }),
      rule({
        id: 'debug',
        pathTemplate: '/a',
        query: [{ name: 'debug', op: 'exists', value: '' }],
        action: { type: 'rewrite', target: '/debug', status: 302 },
      }),
      rule({ id: 'fallback', pathTemplate: '/a', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    const cases: Array<[string, string, string]> = [
      // [url, 期望命中的规则, 期望最终路径]
      ['http://example.com/a?env=canary', 'gray', 'http://example.com/gray?env=canary'],
      ['http://example.com/a?env=prod', 'no-token', 'http://example.com/bare?env=prod'],
      ['http://example.com/a?env=canary&env=prod', 'gray', 'http://example.com/gray?env=canary&env=prod'],
      ['http://example.com/a?token=t', 'fallback', 'http://example.com/done?token=t'],
      ['http://example.com/a?token=t&debug=1', 'debug', 'http://example.com/debug?token=t&debug=1'],
      ['http://example.com/a', 'no-token', 'http://example.com/bare'],
    ];
    for (const [url, hit, finalUrl] of cases) {
      const method = 'GET';
      const sim = route(method, url);
      expectSameAsEngine(rules, sim, method, url);
      expect(sim.steps[0].rule.id).toBe(hit);
      expect(sim.finalUrl).toBe(finalUrl);
    }
  });

  it('查询条件参与链式重写：重写保留查询串后继续按条件匹配', async () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        query: [{ name: 'debug', op: 'exists', value: '' }],
        action: { type: 'rewrite', target: '/debug', status: 302 },
      }),
      rule({ id: 'r3', pathTemplate: '/b', action: { type: 'rewrite', target: '/done', status: 302 } }),
    ];
    const route = await loadRoute(rules);
    const withDebug = route('GET', 'http://example.com/a?debug=1');
    expectSameAsEngine(rules, withDebug, 'GET', 'http://example.com/a?debug=1');
    expect(withDebug.steps.map((s) => s.rule.id)).toEqual(['r1', 'r2']);
    expect(withDebug.finalUrl).toBe('http://example.com/debug?debug=1');
    const plain = route('GET', 'http://example.com/a');
    expectSameAsEngine(rules, plain, 'GET', 'http://example.com/a');
    expect(plain.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(plain.finalUrl).toBe('http://example.com/done');
  });

  it('查询条件中的特殊字符经 JSON 内嵌后语义不变', async () => {
    const rules = [
      rule({
        id: 'tricky',
        pathTemplate: '/a',
        query: [{ name: 'q', op: 'equals', value: 'a b&c="d"' }],
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const route = await loadRoute(rules);
    const hit = route('GET', 'http://example.com/a?q=a%20b%26c%3D%22d%22');
    expectSameAsEngine(rules, hit, 'GET', 'http://example.com/a?q=a%20b%26c%3D%22d%22');
    expect(hit.status).toBe('stopped');
    expect(route('GET', 'http://example.com/a?q=other').status).toBe('final');
  });
});

describe('CLI：node route-bundle.mjs METHOD URL', () => {
  it('输出含终止类型、最终 URL 与完整步骤的 JSON，成功时退出码为 0', () => {
    const file = writeBundle(SAMPLE_RULES);
    const res = runCli(file, ['GET', 'http://api.example.com/v1/users/42?debug=1']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Simulation;
    expect(out.status).toBe('final');
    expect(out.ok).toBe(true);
    expect(out.finalUrl).toBe('http://api.example.com/internal/users/42?debug=1');
    expect(out.steps).toHaveLength(2);
    expect(out.reason).toBeTruthy();
  });

  it('重定向结果包含状态码与 Location', () => {
    const file = writeBundle(SAMPLE_RULES);
    const res = runCli(file, ['GET', 'http://blog.example.com/posts/hello-world']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Simulation;
    expect(out.status).toBe('redirect');
    expect(out.redirectStatus).toBe(301);
    expect(out.redirectLocation).toBe('https://www.example.com/blog/hello-world');
  });

  it('失败结果（循环）退出码为 1，仍输出统一 JSON', () => {
    const rules = SAMPLE_RULES.map((r) =>
      r.id === 'sample-6' || r.id === 'sample-7' ? { ...r, enabled: true } : r,
    );
    const file = writeBundle(rules);
    const res = runCli(file, ['GET', 'http://loop.example.com/a']);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout) as Simulation;
    expect(out.status).toBe('loop');
    expect(out.ok).toBe(false);
  });

  it(`恰好 ${MAX_STEPS} 次重写后到达无命中 URL：退出码为 0 且结果为 final`, () => {
    const rules: Rule[] = Array.from({ length: MAX_STEPS }, (_, i) =>
      rule({
        id: `r${i}`,
        pathTemplate: `/s${i}`,
        query: [],
        action: { type: 'rewrite', target: `/s${i + 1}`, status: 302 },
      }),
    );
    const file = writeBundle(rules);
    const res = runCli(file, ['GET', 'http://example.com/s0']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Simulation;
    expect(out.status).toBe('final');
    expect(out.ok).toBe(true);
    expect(out.finalUrl).toBe(`http://example.com/s${MAX_STEPS}`);
    expect(out.steps).toHaveLength(MAX_STEPS);
  });

  it('缺少参数时打印用法并退出码为 1', () => {
    const file = writeBundle(SAMPLE_RULES);
    const res = runCli(file, ['GET']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('用法');
  });

  it('被 import 时不执行 CLI 逻辑', async () => {
    // loadRoute 动态 import 即验证：若误执行 CLI，进程会打印用法污染输出
    const route = await loadRoute(SAMPLE_RULES);
    expect(typeof route).toBe('function');
  });
});

describe('findBundleIssues', () => {
  it('合法规则表无问题', () => {
    expect(findBundleIssues(SAMPLE_RULES)).toEqual([]);
  });

  it('定位不合法规则：空主机 / 空目标 / 非法状态码 / 无名参数段', () => {
    const rules = [
      rule({ id: 'ok', pathTemplate: '/a' }),
      rule({ id: 'bad-host', name: '空主机', host: '  ' }),
      rule({
        id: 'bad-target',
        name: '空目标',
        action: { type: 'rewrite', target: '', status: 302 },
      }),
      rule({
        id: 'bad-status',
        name: '非法状态码',
        action: { type: 'redirect', target: '/x', status: 200 },
      }),
      rule({ id: 'bad-param', name: '无名参数', pathTemplate: '/users/:' }),
    ];
    const issues = findBundleIssues(rules);
    const byId = new Map(issues.map((i) => [i.ruleId, i]));
    expect(byId.has('ok')).toBe(false);
    expect(byId.get('bad-host')).toMatchObject({ index: 1, ruleName: '空主机' });
    expect(byId.get('bad-host')?.message).toContain('host');
    expect(byId.get('bad-target')?.message).toContain('target');
    expect(byId.get('bad-status')?.message).toContain('status');
    expect(byId.get('bad-param')?.message).toContain('pathTemplate');
  });

  it('未启用的规则不参与校验', () => {
    const rules = [
      rule({ id: 'off', enabled: false, host: '', action: { type: 'rewrite', target: '', status: 302 } }),
    ];
    expect(findBundleIssues(rules)).toEqual([]);
  });

  it('stop 规则不要求目标，rewrite 不校验状态码', () => {
    const rules = [
      rule({ id: 's', action: { type: 'stop', target: '', status: 302 } }),
      rule({ id: 'w', action: { type: 'rewrite', target: '/ok', status: 200 } }),
    ];
    expect(findBundleIssues(rules)).toEqual([]);
  });

  it('定位查询条件问题：重复参数名 / 空参数名 / 非法操作符', () => {
    const rules = [
      rule({ id: 'ok', query: [{ name: 'env', op: 'equals', value: 'canary' }] }),
      rule({
        id: 'dup',
        name: '重复参数',
        query: [
          { name: 'env', op: 'exists', value: '' },
          { name: 'env', op: 'equals', value: 'x' },
        ],
      }),
      rule({ id: 'empty-name', name: '空参数名', query: [{ name: '  ', op: 'exists', value: '' }] }),
      rule({ id: 'bad-op', name: '非法操作符', query: [{ name: 'a', op: 'like' as QueryCondition['op'], value: '' }] }),
    ];
    const issues = findBundleIssues(rules);
    const byId = new Map(issues.map((i) => [i.ruleId, i]));
    expect(byId.has('ok')).toBe(false);
    expect(byId.get('dup')).toMatchObject({ index: 1, ruleName: '重复参数' });
    expect(byId.get('dup')?.message).toContain('重复参数名「env」');
    expect(byId.get('empty-name')).toMatchObject({ index: 2 });
    expect(byId.get('empty-name')?.message).toContain('参数名不能为空');
    expect(byId.get('bad-op')?.message).toContain('op');
  });

  it('未启用规则的重复参数名不阻止导出', () => {
    const rules = [
      rule({
        id: 'off',
        enabled: false,
        query: [
          { name: 'env', op: 'exists', value: '' },
          { name: 'env', op: 'equals', value: 'x' },
        ],
      }),
    ];
    expect(findBundleIssues(rules)).toEqual([]);
  });
});

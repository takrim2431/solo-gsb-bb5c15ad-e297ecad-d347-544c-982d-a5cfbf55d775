import { describe, expect, it } from 'vitest';
import {
  followRedirectChain,
  MAX_REDIRECTS,
  redirectNextMethod,
} from './redirectChain';
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

function redirect(
  id: string,
  host: string,
  pathTemplate: string,
  target: string,
  status: number,
  method: Rule['method'] = 'ANY',
): Rule {
  return rule({
    id,
    host,
    pathTemplate,
    method,
    action: { type: 'redirect', target, status },
  });
}

function rewrite(
  id: string,
  host: string,
  pathTemplate: string,
  target: string,
  method: Rule['method'] = 'ANY',
): Rule {
  return rule({
    id,
    host,
    pathTemplate,
    method,
    action: { type: 'rewrite', target, status: 302 },
  });
}

describe('redirectNextMethod', () => {
  it('301 / 302：仅 POST 改为 GET，其余方法不变', () => {
    for (const status of [301, 302]) {
      expect(redirectNextMethod(status, 'POST')).toBe('GET');
      expect(redirectNextMethod(status, 'GET')).toBe('GET');
      expect(redirectNextMethod(status, 'PUT')).toBe('PUT');
      expect(redirectNextMethod(status, 'DELETE')).toBe('DELETE');
      expect(redirectNextMethod(status, 'HEAD')).toBe('HEAD');
    }
  });

  it('303：除 HEAD 外一律改为 GET', () => {
    expect(redirectNextMethod(303, 'POST')).toBe('GET');
    expect(redirectNextMethod(303, 'PUT')).toBe('GET');
    expect(redirectNextMethod(303, 'DELETE')).toBe('GET');
    expect(redirectNextMethod(303, 'GET')).toBe('GET');
    expect(redirectNextMethod(303, 'HEAD')).toBe('HEAD');
  });

  it('307 / 308：保持原方法', () => {
    for (const status of [307, 308]) {
      expect(redirectNextMethod(status, 'POST')).toBe('POST');
      expect(redirectNextMethod(status, 'PUT')).toBe('PUT');
      expect(redirectNextMethod(status, 'GET')).toBe('GET');
    }
  });

  it('方法大小写不敏感', () => {
    expect(redirectNextMethod(301, 'post')).toBe('GET');
    expect(redirectNextMethod(307, 'post')).toBe('POST');
  });
});

describe('followRedirectChain', () => {
  it('无重定向：单跳直接得到最终 URL（内部重写照常进行）', () => {
    const rules = [rewrite('rw', 'a.com', '/old', '/new')];
    const r = followRedirectChain(rules, 'GET', 'http://a.com/old');
    expect(r.status).toBe('final');
    expect(r.ok).toBe(true);
    expect(r.hops).toHaveLength(1);
    expect(r.hops[0].method).toBe('GET');
    expect(r.hops[0].url).toBe('http://a.com/old');
    expect(r.finalUrl).toBe('http://a.com/new');
  });

  it('跟随多跳重定向；每跳重新从首条规则模拟', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://b.com/b', 301),
      rewrite('r2', 'b.com', '/b', '/b2'),
    ];
    const r = followRedirectChain(rules, 'GET', 'http://a.com/a');
    expect(r.status).toBe('final');
    expect(r.hops).toHaveLength(2);
    // 第一跳：重定向出口
    expect(r.hops[0].status).toBe(301);
    expect(r.hops[0].location).toBe('http://b.com/b');
    // 第二跳：以 Location 为入站重新模拟，内部重写生效
    expect(r.hops[1].url).toBe('http://b.com/b');
    expect(r.hops[1].sim.steps[0].urlAfter).toBe('http://b.com/b2');
    expect(r.finalUrl).toBe('http://b.com/b2');
  });

  it('301 将 POST 改为 GET 后再匹配下一跳', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 301),
      rewrite('r2', 'a.com', '/b', '/get-b', 'GET'),
    ];
    const r = followRedirectChain(rules, 'POST', 'http://a.com/a');
    expect(r.hops[1].method).toBe('GET');
    // 若方法仍是 POST，GET 专属规则不会命中，最终 URL 会是 /b
    expect(r.finalUrl).toBe('http://a.com/get-b');
  });

  it('302 不改写 POST 以外的方法（PUT 保持 PUT）', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 302),
      rewrite('r2', 'a.com', '/b', '/put-b', 'PUT'),
    ];
    const r = followRedirectChain(rules, 'PUT', 'http://a.com/a');
    expect(r.hops[1].method).toBe('PUT');
    expect(r.finalUrl).toBe('http://a.com/put-b');
  });

  it('303：POST 改为 GET', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 303),
      rewrite('r2', 'a.com', '/b', '/get-b', 'GET'),
    ];
    const r = followRedirectChain(rules, 'POST', 'http://a.com/a');
    expect(r.hops[1].method).toBe('GET');
    expect(r.finalUrl).toBe('http://a.com/get-b');
  });

  it('303：HEAD 保持 HEAD', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 303),
      rewrite('r2', 'a.com', '/b', '/head-b', 'HEAD'),
    ];
    const r = followRedirectChain(rules, 'HEAD', 'http://a.com/a');
    expect(r.hops[1].method).toBe('HEAD');
    expect(r.finalUrl).toBe('http://a.com/head-b');
  });

  it('307 / 308 保持原方法（POST 不变）', () => {
    for (const status of [307, 308]) {
      const rules = [
        redirect('r1', 'a.com', '/a', 'http://a.com/b', status),
        rewrite('r2', 'a.com', '/b', '/post-b', 'POST'),
      ];
      const r = followRedirectChain(rules, 'POST', 'http://a.com/a');
      expect(r.hops[1].method).toBe('POST');
      expect(r.finalUrl).toBe('http://a.com/post-b');
    }
  });

  it('跨跳循环：入站「方法 + 序列化 URL」重复即终止', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 302),
      redirect('r2', 'a.com', '/b', 'http://a.com/a', 302),
    ];
    const r = followRedirectChain(rules, 'GET', 'http://a.com/a');
    expect(r.status).toBe('loop');
    expect(r.ok).toBe(false);
    expect(r.hops).toHaveLength(2);
    expect(r.reason).toContain('第 1 跳');
    expect(r.reason).toContain('GET http://a.com/a');
  });

  it('循环识别包含方法：303 把 POST 改为 GET 后同 URL 不立即判循环', () => {
    const rules = [redirect('r1', 'a.com', '/a', 'http://a.com/a', 303)];
    const r = followRedirectChain(rules, 'POST', 'http://a.com/a');
    // 第 1 跳 POST /a → 303 → 第 2 跳 GET /a（方法不同，不是循环）
    // 第 2 跳 GET /a → 303 → 第 3 跳 GET /a（与第 2 跳完全相同，判循环）
    expect(r.status).toBe('loop');
    expect(r.hops).toHaveLength(2);
    expect(r.hops[0].method).toBe('POST');
    expect(r.hops[1].method).toBe('GET');
  });

  it('超限：跟随 10 次重定向后仍遇重定向，不返回成功结果', () => {
    // r0 → r1 → … → r10 共 11 条重定向规则，永不终止
    const rules = Array.from({ length: MAX_REDIRECTS + 1 }, (_, i) =>
      redirect(`r${i}`, 'a.com', `/r${i}`, `http://a.com/r${i + 1}`, 302),
    );
    const r = followRedirectChain(rules, 'GET', 'http://a.com/r0');
    expect(r.status).toBe('max-redirects');
    expect(r.ok).toBe(false);
    expect(r.hops).toHaveLength(MAX_REDIRECTS + 1);
    expect(r.finalUrl).toBeUndefined();
  });

  it('边界：恰好 10 次重定向后到达最终 URL 仍为成功', () => {
    const rules = Array.from({ length: MAX_REDIRECTS }, (_, i) =>
      redirect(`r${i}`, 'a.com', `/r${i}`, `http://a.com/r${i + 1}`, 302),
    );
    const r = followRedirectChain(rules, 'GET', 'http://a.com/r0');
    expect(r.status).toBe('final');
    expect(r.ok).toBe(true);
    expect(r.hops).toHaveLength(MAX_REDIRECTS + 1);
    expect(r.finalUrl).toBe(`http://a.com/r${MAX_REDIRECTS}`);
  });

  it('某一跳引擎失败（跳内循环）即终止整条链', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 302),
      rewrite('r2', 'a.com', '/b', '/c'),
      rewrite('r3', 'a.com', '/c', '/b'),
    ];
    const r = followRedirectChain(rules, 'GET', 'http://a.com/a');
    expect(r.status).toBe('engine-failure');
    expect(r.ok).toBe(false);
    expect(r.hops).toHaveLength(2);
    expect(r.hops[1].sim.status).toBe('loop');
  });

  it('输入 URL 无法解析：首跳即引擎失败', () => {
    const r = followRedirectChain([], 'GET', 'not a url');
    expect(r.status).toBe('engine-failure');
    expect(r.ok).toBe(false);
    expect(r.hops).toHaveLength(1);
    expect(r.hops[0].sim.status).toBe('invalid-url');
  });

  it('末跳被停止规则终止：链成功终止（与单条模拟语义一致）', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 301),
      rule({
        id: 'r2',
        host: 'a.com',
        pathTemplate: '/b',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const r = followRedirectChain(rules, 'GET', 'http://a.com/a');
    expect(r.status).toBe('stopped');
    expect(r.ok).toBe(true);
    expect(r.hops).toHaveLength(2);
  });

  it('入站 URL 经 URL API 序列化（补全路径、规范化主机）', () => {
    const r = followRedirectChain([], 'GET', 'http://A.com');
    expect(r.hops[0].url).toBe('http://a.com/');
    expect(r.status).toBe('final');
    expect(r.finalUrl).toBe('http://a.com/');
  });

  it('运行使用规则快照：之后修改规则表不影响结果，输入规则表也不被修改', () => {
    const rules = [redirect('r1', 'a.com', '/a', 'http://a.com/b', 301)];
    const before = JSON.stringify(rules);
    const r = followRedirectChain(rules, 'GET', 'http://a.com/a');
    // 输入规则表未被运行修改
    expect(JSON.stringify(rules)).toBe(before);
    // 轨迹中的规则是快照副本，不是原对象
    expect(r.hops[0].sim.steps[0].rule).not.toBe(rules[0]);
    expect(r.hops[0].sim.steps[0].rule).toEqual(rules[0]);
    // 运行后编辑规则表，本次结果不受影响
    rules[0].action.target = 'http://a.com/changed';
    expect(r.hops[0].location).toBe('http://a.com/b');
  });
});

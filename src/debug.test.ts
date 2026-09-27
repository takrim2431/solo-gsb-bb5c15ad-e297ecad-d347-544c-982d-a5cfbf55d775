import { describe, expect, it } from 'vitest';
import { DebugSession, debugContextKey } from './debug';
import { MAX_STEPS } from './engine';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  const base: Rule = {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: `/${partial.id}`, status: 302 },
    ...partial,
  };
  return base;
}

/** 构造一条把路径 /a 重写到 /b 的规则，便于链式 rewrite */
function rewrite(id: string, from: string, to: string): Rule {
  return rule({
    id,
    name: id,
    pathTemplate: from,
    action: { type: 'rewrite', target: to, status: 302 },
  });
}

const START_URL = 'http://example.com/a';

function session(rules: Rule[], bp: string[], url = START_URL) {
  const key = debugContextKey(rules, 'GET', url);
  const s = new DebugSession(rules, 'GET', url, new Set(bp), key);
  s.start();
  return s;
}

describe('DebugSession 启动', () => {
  it('启动后暂停在首条带断点的命中规则前，不执行其动作', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r2']);
    expect(s.finished).toBe(false);
    expect(s.pending?.rule.id).toBe('r2');
    expect(s.pauseReason).toBe('breakpoint');
    expect(s.pending?.urlBefore).toBe('http://example.com/b');
    // r1 的动作已执行
    expect(s.steps.map((x) => x.rule.id)).toEqual(['r1']);
  });

  it('没有任何断点命中时一直运行到终止', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r9']);
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.result?.finalUrl).toBe('http://example.com/c');
    expect(s.breakpointHits).toBe(0);
  });

  it('没有任何规则命中时直接成功终止', () => {
    const s = session([rewrite('r1', '/other', '/b')], ['r1']);
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.pending).toBeNull();
  });

  it('非法 URL 直接终止为 invalid-url', () => {
    const rules = [rewrite('r1', '/a', '/b')];
    const s = new DebugSession(rules, 'GET', 'not a url', new Set(['r1']), 'k');
    s.start();
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('invalid-url');
  });
});

describe('单步执行', () => {
  it('逐次停在下一条实际命中规则前（无论是否有断点）', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r1']);
    expect(s.pending?.rule.id).toBe('r1');

    s.step();
    expect(s.finished).toBe(false);
    expect(s.pending?.rule.id).toBe('r2');
    expect(s.pauseReason).toBe('step');
    expect(s.steps.map((x) => x.rule.id)).toEqual(['r1']);

    s.step();
    // r2 执行后无更多规则命中：成功终止，r2 进入最终轨迹
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.result?.steps.map((x) => x.rule.id)).toEqual(['r1', 'r2']);
  });

  it('断点规则在单步时同样标记为断点暂停', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r1', 'r2']);
    s.step();
    expect(s.pending?.rule.id).toBe('r2');
    expect(s.pauseReason).toBe('breakpoint');
    expect(s.breakpointHits).toBe(2);
  });

  it('终止后再单步 / 继续均无操作', () => {
    const rules = [rewrite('r1', '/a', '/b')];
    const s = session(rules, ['r1']);
    s.step();
    expect(s.finished).toBe(true);
    const steps = s.result!.steps.length;
    s.step();
    s.resume();
    expect(s.result!.steps.length).toBe(steps);
  });
});

describe('继续执行', () => {
  it('运行到下一断点前暂停，跳过中间无断点的命中规则', () => {
    const rules = [
      rewrite('r1', '/a', '/b'),
      rewrite('r2', '/b', '/c'),
      rewrite('r3', '/c', '/d'),
    ];
    const s = session(rules, ['r1', 'r3']);
    expect(s.pending?.rule.id).toBe('r1');

    s.resume();
    expect(s.finished).toBe(false);
    expect(s.pending?.rule.id).toBe('r3');
    expect(s.pauseReason).toBe('breakpoint');
    // r1、r2 的动作都已执行
    expect(s.steps.map((x) => x.rule.id)).toEqual(['r1', 'r2']);

    s.resume();
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
  });

  it('后续再无断点时一直运行到终止', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r1']);
    s.resume();
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.result?.steps.map((x) => x.rule.id)).toEqual(['r1', 'r2']);
  });

  it('redirect / stop 动作在暂停恢复后立即终止', () => {
    const redirect = rule({
      id: 'rd',
      pathTemplate: '/b',
      action: { type: 'redirect', target: 'https://to.example.com/', status: 301 },
    });
    let s = session([rewrite('r1', '/a', '/b'), redirect], ['r1']);
    s.resume();
    expect(s.result?.status).toBe('redirect');
    expect(s.result?.redirectStatus).toBe(301);

    const stop = rule({
      id: 'st',
      pathTemplate: '/b',
      action: { type: 'stop', target: '', status: 302 },
    });
    s = session([rewrite('r1', '/a', '/b'), stop], ['r1']);
    s.resume();
    expect(s.result?.status).toBe('stopped');
  });
});

describe('暂停不重置循环检测与 20 步上限', () => {
  it('循环检测状态跨暂停保留：继续后照样判定 loop', () => {
    // /a -> /b -> /a，两步后回到已见状态 => loop
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/a')];
    const s = session(rules, ['r1']);
    expect(s.pending?.rule.id).toBe('r1');
    // 在每个断点反复单步 / 继续，制造多次暂停
    s.step(); // r1 执行，停在 r2
    expect(s.pending?.rule.id).toBe('r2');
    s.resume(); // r2 执行，下一断点 r1？状态重复应先判 loop
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('loop');
  });

  it('20 步上限跨暂停累计生效', () => {
    // 21 条链式 rewrite：/p0 -> /p1 -> ...，超过 MAX_STEPS
    const rules: Rule[] = [];
    for (let i = 0; i <= MAX_STEPS; i++) {
      rules.push(rewrite(`r${i}`, `/p${i}`, `/p${i + 1}`));
    }
    const s = session(rules, ['r0'], 'http://example.com/p0');
    // 每步都暂停，逐步推进到上限
    for (let i = 0; i < MAX_STEPS; i++) {
      expect(s.finished).toBe(false);
      s.step();
    }
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('max-steps');
    expect(s.result?.steps.length).toBe(MAX_STEPS);
  });

  it(`恰好 ${MAX_STEPS} 次重写后无命中：单步推进到底判 final 而非超限`, () => {
    // 20 条链式 rewrite：/p0 -> ... -> /p20，/p20 无任何规则命中
    const rules: Rule[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      rules.push(rewrite(`r${i}`, `/p${i}`, `/p${i + 1}`));
    }
    const s = session(rules, ['r0'], 'http://example.com/p0');
    for (let i = 0; i < MAX_STEPS; i++) {
      expect(s.finished).toBe(false);
      s.step();
    }
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.result?.finalUrl).toBe(`http://example.com/p${MAX_STEPS}`);
    expect(s.result?.steps.length).toBe(MAX_STEPS);
  });

  it(`恰好 ${MAX_STEPS} 次重写后无命中：继续运行到底同样判 final`, () => {
    const rules: Rule[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      rules.push(rewrite(`r${i}`, `/p${i}`, `/p${i + 1}`));
    }
    const s = session(rules, ['r0'], 'http://example.com/p0');
    expect(s.pending?.rule.id).toBe('r0');
    s.resume();
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('final');
    expect(s.result?.finalUrl).toBe(`http://example.com/p${MAX_STEPS}`);
    expect(s.result?.steps.length).toBe(MAX_STEPS);
  });

  it(`第 ${MAX_STEPS} 步重写后落到已见状态：跨暂停判循环而非超限`, () => {
    // 19 条链式 rewrite 后，最后一条把 /p19 重写回已见的 /p0
    const rules: Rule[] = [];
    for (let i = 0; i < MAX_STEPS - 1; i++) {
      rules.push(rewrite(`r${i}`, `/p${i}`, `/p${i + 1}`));
    }
    rules.push(rewrite('back', `/p${MAX_STEPS - 1}`, '/p0'));
    const s = session(rules, ['r0'], 'http://example.com/p0');
    for (let i = 0; i < MAX_STEPS; i++) {
      expect(s.finished).toBe(false);
      s.step();
    }
    expect(s.finished).toBe(true);
    expect(s.result?.status).toBe('loop');
    expect(s.result?.steps.length).toBe(MAX_STEPS);
  });

  it('同一会话单步与继续混用，轨迹与一次跑完完全一致', () => {
    const rules = [
      rewrite('r1', '/a', '/b'),
      rewrite('r2', '/b', '/c'),
      rewrite('r3', '/c', '/d'),
      rewrite('r4', '/d', '/e'),
    ];
    const s = session(rules, ['r1', 'r3']);
    s.step(); // 停 r2
    s.resume(); // 停 r3（下一断点）
    s.step(); // 停 r4
    s.resume(); // 跑完
    expect(s.result?.status).toBe('final');
    expect(s.result?.finalUrl).toBe('http://example.com/e');
    expect(s.result?.steps.map((x) => `${x.rule.id}:${x.urlAfter}`)).toEqual([
      'r1:http://example.com/b',
      'r2:http://example.com/c',
      'r3:http://example.com/d',
      'r4:http://example.com/e',
    ]);
  });
});

describe('会话快照与上下文', () => {
  it('会话执行基于规则快照，之后编辑规则不影响会话', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const s = session(rules, ['r1']);
    rules[0].pathTemplate = '/changed';
    rules[0].action.target = '/x';
    expect(s.rules[0].pathTemplate).toBe('/a');
    s.step();
    expect(s.pending?.rule.id).toBe('r2');
  });

  it('断点集合为快照：会话中增删断点不改变本次判定', () => {
    const rules = [rewrite('r1', '/a', '/b'), rewrite('r2', '/b', '/c')];
    const bp = new Set(['r1']);
    const s = new DebugSession(rules, 'GET', START_URL, bp, 'k');
    s.start();
    bp.add('r2');
    s.resume(); // 按快照 r2 不是断点，应直接跑完
    expect(s.finished).toBe(true);
  });

  it('规则 / 方法 / URL 任一变化都会改变 contextKey', () => {
    const rules = [rewrite('r1', '/a', '/b')];
    const base = debugContextKey(rules, 'GET', START_URL);
    expect(debugContextKey(rules, 'POST', START_URL)).not.toBe(base);
    expect(debugContextKey(rules, 'GET', 'http://example.com/other')).not.toBe(base);
    const edited = rules.map((r) => ({ ...r, pathTemplate: '/z' }));
    expect(debugContextKey(edited, 'GET', START_URL)).not.toBe(base);
    expect(debugContextKey(rules, 'GET', START_URL)).toBe(base);
  });

  it('暂停时展示当前方法、URL、规则与已捕获路径参数', () => {
    const rules = [
      rule({
        id: 'rp',
        pathTemplate: '/users/:id',
        action: { type: 'rewrite', target: '/v2/users/:id', status: 302 },
      }),
    ];
    const s = session(rules, ['rp'], 'http://example.com/users/42?x=1');
    expect(s.pending?.method).toBe('GET');
    expect(s.pending?.urlBefore).toBe('http://example.com/users/42?x=1');
    expect(s.pending?.rule.pathTemplate).toBe('/users/:id');
    expect(s.pending?.params).toEqual({ id: '42' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  SHARE_VERSION,
  decryptShare,
  encryptShare,
  fromBase64Url,
  openShare,
  parseShareHash,
  toBase64Url,
  validateSharePayload,
  validateShareRequest,
  type SharePayload,
} from './share';
import type { Rule } from './types';

const rule = (id: string): Rule => ({
  id,
  name: `规则 ${id}`,
  enabled: true,
  method: 'ANY',
  host: 'api.example.com',
  pathTemplate: '/v1/users/:id',
  query: [],
  action: { type: 'rewrite', target: '/v2/users/:id', status: 302 },
});

const payload: SharePayload = {
  rules: [
    rule('r1'),
    {
      ...rule('r2'),
      query: [
        { name: 'env', op: 'equals', value: 'canary' },
        { name: 'token', op: 'not-exists', value: '' },
      ],
    },
  ],
  method: 'get',
  url: 'http://api.example.com/v1/users/42?debug=1',
};

const PASSWORD = '正确口令 horse-battery';

describe('base64url 编解码', () => {
  it('往返一致且不含 +/= 等 URL 保留字符', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(bytes));
  });

  it('非法字符或空串抛出', () => {
    expect(() => fromBase64Url('')).toThrow(/损坏/);
    expect(() => fromBase64Url('abc.def')).toThrow(/损坏/);
  });
});

describe('encryptShare / openShare', () => {
  it('正确口令可往返解密，规则、方法（规范化大写）与 URL 一致', async () => {
    const fragment = await encryptShare(payload, PASSWORD);
    const opened = await openShare(fragment, PASSWORD);
    expect(opened.rules).toEqual(payload.rules);
    expect(opened.method).toBe('GET');
    expect(opened.url).toBe(payload.url);
  });

  it('容器首字节为版本号，盐与 IV 随机导致两次密文不同', async () => {
    const a = await encryptShare(payload, PASSWORD);
    const b = await encryptShare(payload, PASSWORD);
    expect(fromBase64Url(a)[0]).toBe(SHARE_VERSION);
    expect(a).not.toBe(b);
  });

  it('口令错误时解密失败，错误信息不泄露任何明文', async () => {
    const fragment = await encryptShare(payload, PASSWORD);
    await expect(openShare(fragment, 'wrong password')).rejects.toThrow(
      /口令错误|损坏/,
    );
  });

  it('密文被篡改时 GCM 认证失败', async () => {
    const fragment = await encryptShare(payload, PASSWORD);
    const bytes = fromBase64Url(fragment);
    const last = bytes.length - 1;
    bytes[last] ^= 0xff;
    await expect(decryptShare(toBase64Url(bytes), PASSWORD)).rejects.toThrow(
      /口令错误|损坏/,
    );
  });

  it('盐被篡改时同样认证失败', async () => {
    const bytes = fromBase64Url(await encryptShare(payload, PASSWORD));
    bytes[1] ^= 0x01;
    await expect(decryptShare(toBase64Url(bytes), PASSWORD)).rejects.toThrow();
  });

  it('版本字节不受支持时报版本错误', async () => {
    const bytes = fromBase64Url(await encryptShare(payload, PASSWORD));
    bytes[0] = SHARE_VERSION + 1;
    await expect(decryptShare(toBase64Url(bytes), PASSWORD)).rejects.toThrow(
      /版本/,
    );
  });

  it('容器被截断时报损坏错误，且不会走到解密', async () => {
    const bytes = fromBase64Url(await encryptShare(payload, PASSWORD));
    const cut = toBase64Url(bytes.slice(0, 20)); // 只剩版本/盐/部分 IV
    await expect(decryptShare(cut, PASSWORD)).rejects.toThrow(/损坏/);
  });

  it('空口令不允许加密', async () => {
    await expect(encryptShare(payload, '')).rejects.toThrow(/口令/);
  });
});

describe('validateShareRequest', () => {
  it('接受合法的具体方法与 http(s) URL，并把方法规范化为大写', () => {
    expect(validateShareRequest('post', 'https://a.com/x')).toBe('POST');
  });

  it('拒绝 ANY、未知方法、空 URL、非 http(s) 协议', () => {
    expect(() => validateShareRequest('ANY', 'http://a.com')).toThrow(/方法/);
    expect(() => validateShareRequest('FETCH', 'http://a.com')).toThrow(/方法/);
    expect(() => validateShareRequest('GET', '   ')).toThrow(/不能为空/);
    expect(() => validateShareRequest('GET', 'not a url')).toThrow(/无法解析/);
    expect(() => validateShareRequest('GET', 'ftp://a.com/x')).toThrow(/http/);
  });
});

describe('validateSharePayload', () => {
  it('规则表缺字段时复用 validateRules 的默认值，非法数据抛出中文错误', () => {
    const ok = validateSharePayload({
      rules: [{ host: 'a.com', pathTemplate: '/x', action: { target: '/y' } }],
      method: 'GET',
      url: 'http://a.com/x',
    });
    expect(ok.rules[0].method).toBe('ANY');
    expect(ok.rules[0].action.status).toBe(302);
    expect(ok.rules[0].id).not.toBe('');

    expect(() => validateSharePayload({ rules: [], method: 'GET', url: 'http://a.com' }))
      .not.toThrow();
    expect(() => validateSharePayload(null)).toThrow(/格式/);
    expect(() => validateSharePayload('nope')).toThrow(/格式/);
    expect(() =>
      validateSharePayload({
        rules: [{ action: { type: 'rewrite', target: '' } }],
        method: 'GET',
        url: 'http://a.com',
      }),
    ).toThrow(/target/);
    expect(() =>
      validateSharePayload({ rules: [], method: 'GET', url: 'bad' }),
    ).toThrow(/无法解析/);
  });
});

describe('parseShareHash', () => {
  it('从 hash 中提取 s 参数，兼容带/不带 # 及附加参数', () => {
    expect(parseShareHash('#s=abc123_-')).toBe('abc123_-');
    expect(parseShareHash('s=abc')).toBe('abc');
    expect(parseShareHash('#s=abc&x=1')).toBe('abc');
    expect(parseShareHash('')).toBeNull();
    expect(parseShareHash('#other=1')).toBeNull();
    expect(parseShareHash('#s=')).toBeNull();
  });
});

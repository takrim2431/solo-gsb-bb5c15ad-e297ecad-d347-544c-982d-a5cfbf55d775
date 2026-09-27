import type { Rule } from './types';
import { REQUEST_METHODS } from './types';
import { validateRules } from './validate';

/**
 * 加密分享（全部过程仅在浏览器端完成）：
 * - 口令经 PBKDF2-SHA-256（随机 16 字节盐、150000 次）派生 256 位密钥；
 * - 载荷用 AES-GCM（随机 12 字节 IV）加密，GCM 自带完整性校验；
 * - 容器布局：[1 字节版本][16 字节盐][12 字节 IV][密文（含 GCM 认证标签）]，
 *   整体做 base64url 编码后写入 location.hash（键名 s）。
 * 口令只存在于调用期间的内存中，不会进入链接或 localStorage。
 */

export const SHARE_VERSION = 1;
export const SHARE_HASH_KEY = 's';
const PBKDF2_ITERATIONS = 150_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
/** AES-GCM 认证标签固定 16 字节，小于此长度的密文容器必然已损坏 */
const GCM_TAG_BYTES = 16;
const MIN_CONTAINER_BYTES = 1 + SALT_BYTES + IV_BYTES + GCM_TAG_BYTES;

export interface SharePayload {
  rules: Rule[];
  method: string;
  url: string;
}

function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前浏览器不支持 Web Crypto API，无法使用加密分享');
  }
  return crypto.subtle;
}

/** 字节数组 → base64url（无填充，字符集 A-Za-z0-9-_，可安全放进 URL 与 URLSearchParams） */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → 字节数组；字符非法时抛出（可能是链接被截断或篡改） */
export function fromBase64Url(input: string): Uint8Array {
  if (input === '' || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error('分享链接数据格式不正确或已损坏');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + '='.repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 序列化并加密分享载荷，返回写入 hash 的 base64url 片段（不含 `#s=`） */
export async function encryptShare(
  payload: SharePayload,
  password: string,
): Promise<string> {
  if (password === '') throw new Error('口令不能为空');
  validateShareRequest(payload.method, payload.url);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      rules: payload.rules,
      method: payload.method,
      url: payload.url,
    }),
  );
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  const container = new Uint8Array(MIN_CONTAINER_BYTES - GCM_TAG_BYTES + ciphertext.length);
  container[0] = SHARE_VERSION;
  container.set(salt, 1);
  container.set(iv, 1 + SALT_BYTES);
  container.set(ciphertext, 1 + SALT_BYTES + IV_BYTES);
  return toBase64Url(container);
}

/** 解密链接片段：先校验版本与容器长度，再用 GCM 验证口令与密文完整性 */
export async function decryptShare(
  fragment: string,
  password: string,
): Promise<unknown> {
  const container = fromBase64Url(fragment);
  if (container.length < MIN_CONTAINER_BYTES) {
    throw new Error('分享链接数据不完整或已损坏');
  }
  const version = container[0];
  if (version !== SHARE_VERSION) {
    throw new Error(`不支持的分享链接版本（v${version}），请升级后再试`);
  }

  const salt = container.slice(1, 1 + SALT_BYTES);
  const iv = container.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const ciphertext = container.slice(1 + SALT_BYTES + IV_BYTES);

  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    // 口令错误或密文被篡改都会令 GCM 认证失败
    throw new Error('口令错误，或分享内容已损坏');
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('分享内容解析失败（数据已损坏）');
  }
}

/** 校验「请求方法 + URL」：方法必须是具体 HTTP 方法，URL 必须是可解析的 http(s) 地址 */
export function validateShareRequest(method: string, url: string): string {
  const m = typeof method === 'string' ? method.trim().toUpperCase() : '';
  if (!(REQUEST_METHODS as readonly string[]).includes(m)) {
    throw new Error(`请求方法必须是 ${REQUEST_METHODS.join(' / ')} 之一`);
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('请求 URL 不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('请求 URL 无法解析');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('请求 URL 必须是 http(s) 地址');
  }
  return m;
}

/**
 * 解密成功后校验明文载荷：
 * 规则表复用 JSON 导入的 validateRules，再校验请求方法与 URL。
 * 任一项不合法都抛出中文错误，调用方不得据此改动当前状态。
 */
export function validateSharePayload(data: unknown): SharePayload {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('分享内容格式不正确');
  }
  const record = data as Record<string, unknown>;
  const rules = validateRules(record.rules);
  const method = validateShareRequest(
    typeof record.method === 'string' ? record.method : '',
    typeof record.url === 'string' ? record.url : '',
  );
  return { rules, method, url: (record.url as string).trim() };
}

/** 解密并校验完整分享链接片段，失败时抛出错误（调用方保持当前状态不变） */
export async function openShare(
  fragment: string,
  password: string,
): Promise<SharePayload> {
  return validateSharePayload(await decryptShare(fragment, password));
}

/** 从 location.hash 中取出加密分享片段；不存在或为空时返回 null */
export function parseShareHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const fragment = new URLSearchParams(raw).get(SHARE_HASH_KEY);
  return fragment && fragment !== '' ? fragment : null;
}

/** 生成不带 hash 的当前地址（用于成功导入 / 取消后清理地址栏） */
export function cleanLocationUrl(): string {
  return window.location.pathname + window.location.search;
}

/** 由加密片段拼出可复制的完整分享链接 */
export function buildShareUrl(fragment: string): string {
  return `${window.location.origin}${cleanLocationUrl()}#${SHARE_HASH_KEY}=${fragment}`;
}

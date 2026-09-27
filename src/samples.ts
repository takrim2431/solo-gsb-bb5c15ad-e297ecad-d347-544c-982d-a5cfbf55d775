import type { Rule } from './types';

/** 内置示例规则：覆盖链式重写、查询条件、重定向、通配子域、停止与循环演示 */
export const SAMPLE_RULES: Rule[] = [
  {
    id: 'sample-1',
    name: 'API v1 → v2 重写',
    enabled: true,
    method: 'ANY',
    host: 'api.example.com',
    pathTemplate: '/v1/users/:id',
    query: [],
    action: { type: 'rewrite', target: '/v2/users/:id', status: 302 },
  },
  {
    id: 'sample-2',
    name: 'API v2 → 内部路径',
    enabled: true,
    method: 'ANY',
    host: 'api.example.com',
    pathTemplate: '/v2/users/:id',
    query: [],
    action: { type: 'rewrite', target: '/internal/users/:id', status: 302 },
  },
  {
    id: 'sample-8',
    name: '灰度查询 env=canary 走灰度站',
    enabled: true,
    method: 'ANY',
    host: 'api.example.com',
    pathTemplate: '/internal/users/:id',
    query: [{ name: 'env', op: 'equals', value: 'canary' }],
    action: {
      type: 'rewrite',
      target: 'https://canary.example.com/users/:id',
      status: 302,
    },
  },
  {
    id: 'sample-3',
    name: '旧博客 301 到新站',
    enabled: true,
    method: 'GET',
    host: 'blog.example.com',
    pathTemplate: '/posts/:slug',
    query: [],
    action: {
      type: 'redirect',
      target: 'https://www.example.com/blog/:slug',
      status: 301,
    },
  },
  {
    id: 'sample-4',
    name: '通配子域静态资源回源',
    enabled: true,
    method: 'GET',
    host: '*.cdn.example.com',
    pathTemplate: '/assets/:file',
    query: [],
    action: {
      type: 'rewrite',
      target: 'https://origin.example.com/static/:file',
      status: 302,
    },
  },
  {
    id: 'sample-5',
    name: '内部后台禁止访问',
    enabled: true,
    method: 'ANY',
    host: 'internal.example.com',
    pathTemplate: '/admin/:token',
    query: [],
    action: { type: 'stop', target: '', status: 302 },
  },
  {
    id: 'sample-6',
    name: '循环演示 A（与 B 一起启用）',
    enabled: false,
    method: 'ANY',
    host: 'loop.example.com',
    pathTemplate: '/a',
    query: [],
    action: { type: 'rewrite', target: '/b', status: 302 },
  },
  {
    id: 'sample-7',
    name: '循环演示 B（与 A 一起启用）',
    enabled: false,
    method: 'ANY',
    host: 'loop.example.com',
    pathTemplate: '/b',
    query: [],
    action: { type: 'rewrite', target: '/a', status: 302 },
  },
];

export interface Preset {
  label: string;
  method: string;
  url: string;
}

/** 模拟面板的快捷请求 */
export const PRESETS: Preset[] = [
  {
    label: '链式重写',
    method: 'GET',
    url: 'http://api.example.com/v1/users/42?debug=1',
  },
  {
    label: '301 重定向',
    method: 'GET',
    url: 'http://blog.example.com/posts/hello-world',
  },
  {
    label: '通配子域',
    method: 'GET',
    url: 'http://img.cdn.example.com/assets/logo.png',
  },
  {
    label: '停止动作',
    method: 'POST',
    url: 'http://internal.example.com/admin/secret-token',
  },
  {
    label: '查询条件（灰度 env=canary）',
    method: 'GET',
    url: 'http://api.example.com/v1/users/42?env=canary',
  },
  {
    label: '循环（先启用演示规则 A/B）',
    method: 'GET',
    url: 'http://loop.example.com/a',
  },
];

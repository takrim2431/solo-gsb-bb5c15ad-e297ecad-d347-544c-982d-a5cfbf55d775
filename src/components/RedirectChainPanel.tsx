import { useMemo, useState } from 'react';
import { REQUEST_METHODS } from '../types';
import type { Rule } from '../types';
import {
  followRedirectChain,
  MAX_REDIRECTS,
  redirectNextMethod,
  type ChainStatus,
  type RedirectChainResult,
  type RedirectHop,
} from '../redirectChain';
import { PRESETS } from '../samples';
import { StepCard } from './TraceView';

/** 末跳（非重定向）终止状态的中文标签 */
const HOP_STATUS_LABEL: Record<string, string> = {
  final: '放行',
  stopped: '停止',
  loop: '循环',
  'max-steps': '超限',
  'invalid-url': 'URL 非法',
  'invalid-target': '目标非法',
};

const CHAIN_META: Record<ChainStatus, { cls: string; icon: string; title: string }> = {
  final: { cls: 'ok', icon: '✅', title: '成功 · 到达最终 URL' },
  stopped: { cls: 'warn', icon: '⛔', title: '终止 · 规则停止' },
  loop: { cls: 'error', icon: '🔁', title: '失败 · 检测到跨跳循环' },
  'max-redirects': {
    cls: 'error',
    icon: '⚠️',
    title: `失败 · 超过 ${MAX_REDIRECTS} 次重定向上限`,
  },
  'engine-failure': { cls: 'error', icon: '❌', title: '失败 · 单跳模拟未成功' },
};

/**
 * 一跳卡片：头部展示入站方法 / URL 与出口（重定向状态码 + Location，或终止状态），
 * 点击展开该跳的内部重写轨迹
 */
function HopCard({
  hop,
  expanded,
  onToggle,
}: {
  hop: RedirectHop;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { sim } = hop;
  const status = hop.status;
  const location = hop.location;
  const isRedirect = status !== undefined && location !== undefined;
  const nextMethod = isRedirect ? redirectNextMethod(status, hop.method) : hop.method;
  return (
    <div className="hop">
      <button type="button" className="hop-head" onClick={onToggle}>
        <span className="cov-caret">{expanded ? '▼' : '▶'}</span>
        <span className="hop-n">第 {hop.n} 跳</span>
        <span className="tag case-method">{hop.method}</span>
        <code className="hop-url">{hop.url}</code>
        <span className="hop-steps-count">内部 {sim.steps.length} 步</span>
        {isRedirect ? (
          <span className="tag hop-status">{status}</span>
        ) : (
          <span className={`tag cov-status status-${sim.status}`}>
            {HOP_STATUS_LABEL[sim.status] ?? sim.status}
          </span>
        )}
      </button>
      {isRedirect && (
        <div className="hop-location">
          ↪ {status} Location：<code className="url-to">{location}</code>
          {nextMethod !== hop.method && (
            <span className="hop-method-note">
              （{status} 改写方法：{hop.method} → {nextMethod}）
            </span>
          )}
        </div>
      )}
      {expanded && (
        <div className="hop-trace">
          <p className="state-key">
            入站状态键：{hop.method} {hop.url}
          </p>
          {sim.steps.length === 0 && <p className="empty">（该跳没有任何规则命中）</p>}
          {sim.steps.map((s) => (
            <StepCard key={s.n} step={s} />
          ))}
          <p className="cov-reason">{sim.reason}</p>
        </div>
      )}
    </div>
  );
}

interface Props {
  rules: Rule[];
}

/**
 * 重定向链预演面板：独立的「方法 + URL」输入，复用当前规则表与 simulate 引擎
 * 在本地逐跳跟随重定向（不发网络请求）。输入与结果只保留在当前页面会话（内存）。
 */
export function RedirectChainPanel({ rules }: Props) {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('http://blog.example.com/posts/hello-world');
  const [touched, setTouched] = useState(false);
  const [lastRun, setLastRun] = useState<{
    stamp: string;
    result: RedirectChainResult;
  } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  // 输入指纹：规则或输入（方法 / URL）变化后，上次预演结果标记为过期
  const stamp = useMemo(
    () => JSON.stringify({ rules, method, url }),
    [rules, method, url],
  );
  const stale = lastRun !== null && lastRun.stamp !== stamp;
  const result = lastRun?.result ?? null;

  const invalid = touched && url.trim() === '';

  const run = () => {
    setTouched(true);
    if (url.trim() === '') return;
    // followRedirectChain 内部深拷贝规则表：本次结果基于运行时快照
    setLastRun({ stamp, result: followRedirectChain(rules, method, url) });
    setExpanded(new Set());
  };

  const toggle = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const meta = result ? CHAIN_META[result.status] : null;
  const redirectHops = result?.hops.filter((h) => h.status !== undefined).length ?? 0;

  return (
    <section className="panel chain-panel">
      <div className="panel-title">
        <h2>重定向链预演</h2>
      </div>
      <p className="baseline-info">
        复用当前规则表与 simulate 引擎，在本地逐跳跟随重定向 Location（
        <strong>不发任何网络请求</strong>）：每跳重新从首条规则模拟；301 / 302 仅将
        POST 改为 GET，303 除 HEAD 外改为 GET，307 / 308 保持方法；以「方法 +
        序列化 URL」识别跨跳循环，最多跟随 {MAX_REDIRECTS} 次重定向。
        预演使用运行时的规则快照，规则或输入变化后结果会标记过期。
      </p>
      <form
        className="sim-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {REQUEST_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={invalid ? 'invalid' : ''}
          value={url}
          placeholder="http://blog.example.com/posts/hello-world"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="primary">
          预演重定向链
        </button>
      </form>
      {invalid && <div className="banner error">请输入待预演的 URL</div>}
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="chip"
            title={p.url}
            onClick={() => {
              setMethod(p.method);
              setUrl(p.url);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {result && meta && (
        <div className="chain-results">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或输入在上次预演后已变更，以下结果可能已过期，请重新预演。
            </div>
          )}
          <h3 className="reg-subtitle">
            预演轨迹：共 {result.hops.length} 跳
            {redirectHops > 0 && `（其中 ${redirectHops} 跳返回重定向）`}
          </h3>
          {result.hops.map((hop) => (
            <HopCard
              key={hop.n}
              hop={hop}
              expanded={expanded.has(hop.n)}
              onToggle={() => toggle(hop.n)}
            />
          ))}
          <div className={`banner ${meta.cls}`}>
            <strong>
              {meta.icon} {meta.title}
            </strong>
            <p>{result.reason}</p>
            {result.status === 'final' && result.finalUrl && (
              <p>
                最终 URL：<code className="url-to">{result.finalUrl}</code>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

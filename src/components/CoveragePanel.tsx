import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import {
  parseSamples,
  runCoverageAudit,
  type CoverageReport,
  type CoverageRuleStat,
  type CoverageSampleResult,
} from '../coverage';
import { StepCard } from './TraceView';

/** 默认粘贴内容：取自内置示例场景，方便第一次打开即可试跑 */
const DEFAULT_SAMPLES = [
  'GET http://api.example.com/v1/users/42?debug=1',
  'GET http://api.example.com/v1/users/7?env=canary',
  'GET http://blog.example.com/posts/hello-world',
  'GET http://img.cdn.example.com/assets/logo.png',
  'POST http://internal.example.com/admin/secret-token',
  'GET http://api.example.com/health',
].join('\n');

const STATUS_LABEL: Record<string, string> = {
  final: '放行',
  redirect: '重定向',
  stopped: '停止',
  loop: '循环',
  'max-steps': '超限',
  'invalid-url': 'URL 非法',
  'invalid-target': '目标非法',
  'invalid-input': '输入非法',
};

function StatusTag({ status }: { status: string }) {
  return <span className={`tag cov-status status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function SampleRef({ result }: { result: CoverageSampleResult }) {
  const { sample } = result;
  return (
    <code className="cov-sample-ref">
      <span className="cov-line-no">L{sample.line}</span>
      {sample.method !== null ? `${sample.method} ` : ''}
      {sample.url ?? sample.raw}
    </code>
  );
}

/** 一条样本的完整轨迹；invalid-input（行解析失败，未运行）时只显示原因 */
function SampleTrace({ result }: { result: CoverageSampleResult }) {
  return (
    <div className="cov-sample-trace">
      {result.sim === null ? (
        <p className="empty">未运行：{result.reason}</p>
      ) : (
        <>
          {result.sim.steps.length === 0 && (
            <p className="empty">（没有任何规则命中）</p>
          )}
          {result.sim.steps.map((s) => (
            <StepCard key={s.n} step={s} />
          ))}
          <p className="cov-reason">{result.reason}</p>
        </>
      )}
    </div>
  );
}

/** 规则行：点击展开命中的样本及对应步骤 */
function RuleStatRow({
  stat,
  expanded,
  onToggle,
  resultsById,
}: {
  stat: CoverageRuleStat;
  expanded: boolean;
  onToggle: () => void;
  resultsById: Map<string, CoverageSampleResult>;
}) {
  const zero = stat.requestCount === 0;
  return (
    <div
      className={`cov-rule${zero ? ' cov-rule-zero' : ''}${
        !stat.enabled ? ' cov-rule-disabled' : ''
      }`}
    >
      <button type="button" className="cov-rule-head" onClick={onToggle}>
        <span className="cov-caret">{expanded ? '▼' : '▶'}</span>
        <span className="cov-rule-order">#{stat.index + 1}</span>
        <span className="cov-rule-name">{stat.name}</span>
        {!stat.enabled && <span className="tag cov-tag-off">已停用</span>}
        <span className="cov-counts">
          <span className="cov-count" title="命中该规则的不同样本数（重写重复命中只计一次）">
            请求 <strong>{stat.requestCount}</strong>
          </span>
          <span className="cov-count" title="该规则被执行的累计次数（重写绕回重复命中累加）">
            执行 <strong>{stat.executionCount}</strong>
          </span>
        </span>
      </button>
      {expanded && (
        <div className="cov-rule-body">
          {stat.hits.length === 0 ? (
            <p className="empty">本批样本中没有任何请求命中该规则。</p>
          ) : (
            stat.hits.map((hit) => {
              const result = resultsById.get(hit.sampleId);
              if (!result) return null;
              return (
                <div className="cov-hit" key={hit.sampleId}>
                  <div className="cov-hit-head">
                    <SampleRef result={result} />
                    <span className="cov-hit-times">
                      命中 {hit.steps.length} 次（步骤{' '}
                      {hit.steps.map((s) => s.n).join('、')}）
                    </span>
                    <StatusTag status={result.status} />
                  </div>
                  {hit.steps.map((s) => (
                    <StepCard key={s.n} step={s} />
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface ProblemGroupProps {
  title: string;
  items: CoverageSampleResult[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

/** 未命中 / 循环 / 超限 / 非法 样本清单；每条可展开看完整轨迹 */
function ProblemGroup({ title, items, expanded, onToggle }: ProblemGroupProps) {
  if (items.length === 0) return null;
  return (
    <div className="cov-group">
      <h4>
        {title}（{items.length}）
      </h4>
      {items.map((r) => {
        const id = r.sample.id;
        const open = expanded.has(id);
        return (
          <div className="cov-problem" key={id}>
            <button type="button" className="cov-problem-head" onClick={() => onToggle(id)}>
              <span className="cov-caret">{open ? '▼' : '▶'}</span>
              <SampleRef result={r} />
              <StatusTag status={r.status} />
            </button>
            {open && <SampleTrace result={r} />}
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  rules: Rule[];
}

export function CoveragePanel({ rules }: Props) {
  // 样本与最近一次结果只保存在当前页面会话（内存），不写入 localStorage
  const [text, setText] = useState(DEFAULT_SAMPLES);
  const [lastRun, setLastRun] = useState<{ stamp: string; report: CoverageReport } | null>(
    null,
  );
  const [expandedRules, setExpandedRules] = useState<ReadonlySet<string>>(new Set());
  const [expandedSamples, setExpandedSamples] = useState<ReadonlySet<string>>(new Set());

  const parsed = useMemo(() => parseSamples(text), [text]);
  const runnableCount = parsed.filter((s) => !s.parseError).length;

  // 输入指纹：规则或样本变化后，上次结果标记为过期
  const stamp = useMemo(
    () => JSON.stringify({ rules, samples: parsed }),
    [rules, parsed],
  );
  const stale = lastRun !== null && lastRun.stamp !== stamp;
  const report = lastRun?.report ?? null;

  const run = () => {
    setLastRun({ stamp, report: runCoverageAudit(parsed, rules) });
    setExpandedRules(new Set());
    setExpandedSamples(new Set());
  };

  const toggleRule = (id: string) =>
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSample = (id: string) =>
    setExpandedSamples((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const resultsById = useMemo(() => {
    const map = new Map<string, CoverageSampleResult>();
    report?.results.forEach((r) => map.set(r.sample.id, r));
    return map;
  }, [report]);

  const coveredRules = report?.ruleStats.filter((r) => r.requestCount > 0).length ?? 0;

  return (
    <section className="panel coverage-panel">
      <div className="panel-title">
        <h2>访问样本覆盖审计</h2>
        <div className="toolbar">
          <button
            className="primary"
            onClick={run}
            disabled={parsed.length === 0}
            title={parsed.length === 0 ? '先在下方粘贴至少一行「METHOD URL」样本' : ''}
          >
            批量运行{parsed.length > 0 ? `（${runnableCount}/${parsed.length} 条可运行）` : ''}
          </button>
          <button onClick={() => setText('')} disabled={text.trim() === ''}>
            清空样本
          </button>
        </div>
      </div>
      <p className="baseline-info">
        每行一条「METHOD URL」样本，批量复用同一个 simulate 引擎运行。
        按规则统计<strong>命中请求数</strong>（同一请求因重写重复命中只计一次）与
        <strong>执行次数</strong>（重复命中累加）；点击规则可展开命中样本与对应步骤。
        样本与结果只在当前页面会话保留，刷新即清空。
      </p>
      <textarea
        className="cov-input"
        value={text}
        spellCheck={false}
        rows={7}
        placeholder={'GET http://api.example.com/v1/users/42\nPOST http://api.example.com/users'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="cov-parse-info">
        {parsed.length === 0 ? (
          <span className="empty">尚无样本。</span>
        ) : (
          <span>
            共 {parsed.length} 行样本，{runnableCount} 条可运行
            {runnableCount < parsed.length && (
              <span className="cov-parse-errors">
                ，{parsed.length - runnableCount} 行格式有误（将计为非法输入）
              </span>
            )}
          </span>
        )}
      </div>

      {report && (
        <div className="cov-report">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或样本在上次运行后已变更，以下审计结果已过期，请重新批量运行。
            </div>
          )}

          <h3 className="reg-subtitle">
            规则覆盖：{coveredRules}/{report.ruleStats.length} 条规则被样本命中 ·
            样本 {report.results.length} 条
            {(report.loops.length > 0 ||
              report.maxSteps.length > 0 ||
              report.invalid.length > 0 ||
              report.invalidTarget.length > 0) && (
              <span className="cov-summary-bad">
                {' '}
                · 循环 {report.loops.length} · 超限 {report.maxSteps.length} ·
                非法 {report.invalid.length + report.invalidTarget.length}
              </span>
            )}
            {report.unmatched.length > 0 && (
              <span className="cov-summary-warn"> · 未命中 {report.unmatched.length}</span>
            )}
          </h3>

          {report.ruleStats.map((stat) => (
            <RuleStatRow
              key={stat.ruleId}
              stat={stat}
              expanded={expandedRules.has(stat.ruleId)}
              onToggle={() => toggleRule(stat.ruleId)}
              resultsById={resultsById}
            />
          ))}

          <ProblemGroup
            title="未命中任何规则的样本（原始请求直接放行）"
            items={report.unmatched}
            expanded={expandedSamples}
            onToggle={toggleSample}
          />
          <ProblemGroup
            title="循环样本（状态键重复）"
            items={report.loops}
            expanded={expandedSamples}
            onToggle={toggleSample}
          />
          <ProblemGroup
            title="超限样本（超过 20 步）"
            items={report.maxSteps}
            expanded={expandedSamples}
            onToggle={toggleSample}
          />
          <ProblemGroup
            title="非法输入样本（行格式有误或 URL 无法解析）"
            items={report.invalid}
            expanded={expandedSamples}
            onToggle={toggleSample}
          />
          <ProblemGroup
            title="规则目标无法解析的样本（请检查规则动作目标）"
            items={report.invalidTarget}
            expanded={expandedSamples}
            onToggle={toggleSample}
          />
        </div>
      )}
    </section>
  );
}

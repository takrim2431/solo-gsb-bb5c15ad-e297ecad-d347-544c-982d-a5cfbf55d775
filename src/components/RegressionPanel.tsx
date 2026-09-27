import { useEffect, useMemo, useState } from 'react';
import type { Rule, Simulation, Step } from '../types';
import { REQUEST_METHODS } from '../types';
import { uid } from '../validate';
import {
  freezeBaseline,
  runRegression,
  stepActionOutcome,
  type CaseRun,
  type RegressionCase,
  type RegressionStore,
} from '../regression';
import { StepCard } from './TraceView';
import {
  loadManaged,
  regressionStore,
  type ManagedStore,
} from '../persistence';

/** 首次挂载时读取版本化存储（历史无版本对象自动迁移；损坏隔离到诊断区，
 * 与规则表互不影响）；加载永不抛出，最差回退为空存储 */
let regressionManaged: ManagedStore<RegressionStore> | null = null;
function loadStore(): RegressionStore {
  if (regressionManaged === null) regressionManaged = loadManaged(regressionStore);
  return regressionManaged.value;
}

/** 一侧的可观察结果：终止类型 + 该类型对应的可观察字段（不展示原因文案） */
function OutcomeView({ sim }: { sim: Simulation }) {
  return (
    <div className="outcome">
      <div className="outcome-head">
        <span className={`tag status-${sim.status}`}>{sim.status}</span>
        <span className="outcome-steps">{sim.steps.length} 步</span>
      </div>
      {sim.status === 'final' && <code className="url-to">{sim.finalUrl}</code>}
      {sim.status === 'redirect' && (
        <span className="outcome-redirect">
          {sim.redirectStatus} → <code className="url-to">{sim.redirectLocation}</code>
        </span>
      )}
    </div>
  );
}

/** 首个差异说明：按 rule.id、urlBefore、动作结果定位；长度不同单独说明 */
function DivergenceNote({ run }: { run: CaseRun }) {
  const d = run.divergence;
  if (!d) return null;
  let text: string;
  if (d.kind === 'step') {
    const a = run.baseline.steps[d.index];
    const b = run.current.steps[d.index];
    const diffs: string[] = [];
    if (a.rule.id !== b.rule.id) diffs.push('命中规则（rule.id）');
    if (a.urlBefore !== b.urlBefore) diffs.push('命中前 URL（urlBefore）');
    if (stepActionOutcome(a) !== stepActionOutcome(b)) diffs.push('动作结果');
    text = `首个差异在第 ${d.index + 1} 步：${diffs.join('、')}不同。`;
  } else if (d.kind === 'baseline-longer') {
    text = `前 ${d.index} 步一致；当前规则在此终止，基线继续执行了 ${
      run.baseline.steps.length - d.index
    } 步。`;
  } else {
    text = `前 ${d.index} 步一致；基线在此终止，当前规则继续执行了 ${
      run.current.steps.length - d.index
    } 步。`;
  }
  return <div className="banner warn">🔀 {text}</div>;
}

function TraceColumn({
  title,
  steps,
  other,
  divergenceIndex,
}: {
  title: string;
  steps: Step[];
  other: Step[];
  divergenceIndex: number | null;
}) {
  return (
    <div className="trace-col">
      <h4>{title}</h4>
      {steps.length === 0 && <p className="empty">（无命中步骤）</p>}
      {steps.map((s, i) => {
        const divergent = divergenceIndex === i;
        const extra = i >= other.length; // 另一侧没有对应步（轨迹长度不同）
        return (
          <div
            key={s.n}
            className={`trace-step${divergent ? ' divergent' : ''}${extra ? ' extra' : ''}`}
          >
            {divergent && <div className="div-marker">⤵ 首个差异</div>}
            <StepCard step={s} showRuleId />
          </div>
        );
      })}
      {steps.length < other.length && (
        <p className="trace-end-note">
          （轨迹在此结束，另一侧还有 {other.length - steps.length} 步）
        </p>
      )}
    </div>
  );
}

function TraceCompare({ run }: { run: CaseRun }) {
  const { baseline, current, divergence } = run;
  return (
    <div className="trace-compare">
      <DivergenceNote run={run} />
      <div className="trace-cols">
        <TraceColumn
          title={`基线轨迹（${baseline.steps.length} 步）`}
          steps={baseline.steps}
          other={current.steps}
          divergenceIndex={divergence?.index ?? null}
        />
        <TraceColumn
          title={`当前轨迹（${current.steps.length} 步）`}
          steps={current.steps}
          other={baseline.steps}
          divergenceIndex={divergence?.index ?? null}
        />
      </div>
    </div>
  );
}

function CaseResultRow({
  run,
  expanded,
  onToggle,
}: {
  run: CaseRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { testCase, baseline, current, changed } = run;
  return (
    <div className={`case-result${changed ? ' changed' : ''}`}>
      <header>
        <span className="tag case-method">{testCase.method}</span>
        <code className="case-url">{testCase.url}</code>
        {changed ? (
          <span className="tag tag-changed">有变化</span>
        ) : (
          <span className="tag tag-same">一致</span>
        )}
        {changed && (
          <button className="trace-toggle" onClick={onToggle}>
            {expanded ? '收起轨迹 ▲' : '展开两侧轨迹 ▼'}
          </button>
        )}
      </header>
      <div className="outcome-cols">
        <div className="outcome-col">
          <span className="share-label">基线结果</span>
          <OutcomeView sim={baseline} />
        </div>
        <div className="outcome-col">
          <span className="share-label">当前结果</span>
          <OutcomeView sim={current} />
        </div>
      </div>
      {changed && expanded && <TraceCompare run={run} />}
    </div>
  );
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
}

interface Props {
  rules: Rule[];
}

export function RegressionPanel({ rules }: Props) {
  const [store, setStore] = useState<RegressionStore>(loadStore);
  const [lastRun, setLastRun] = useState<{ stamp: string; results: CaseRun[] } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // 用例与基线经版本化持久化层原子写入（独立于规则表的存储键）；
  // 校验不过不写任何键，存储不可用（隐私模式等）静默退回内存，不影响使用
  useEffect(() => {
    regressionManaged?.save(store);
  }, [store]);

  const { baseline, cases } = store;

  // 输入指纹：规则 / 基线 / 用例任一变化后，上次运行结果标记为过期
  const stamp = useMemo(
    () => JSON.stringify({ rules, baseline, cases }),
    [rules, baseline, cases],
  );
  const stale = lastRun !== null && lastRun.stamp !== stamp;

  const updateCase = (id: string, patch: Partial<RegressionCase>) =>
    setStore((s) => ({
      ...s,
      cases: s.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));

  const addCase = () =>
    setStore((s) => ({
      ...s,
      cases: [...s.cases, { id: uid(), method: 'GET', url: '' }],
    }));

  const removeCase = (id: string) =>
    setStore((s) => ({ ...s, cases: s.cases.filter((c) => c.id !== id) }));

  const freeze = () => setStore((s) => ({ ...s, baseline: freezeBaseline(rules) }));
  const clearBaseline = () => setStore((s) => ({ ...s, baseline: null }));

  const runAll = () => {
    if (!baseline) return;
    setLastRun({ stamp, results: runRegression(cases, baseline.rules, rules) });
    setExpanded(new Set());
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const frozenAt = baseline ? fmtTime(baseline.frozenAt) : '';
  const changedCount = lastRun?.results.filter((r) => r.changed).length ?? 0;

  return (
    <section className="panel regression-panel">
      <div className="panel-title">
        <h2>规则回归对比</h2>
        <div className="toolbar">
          <button onClick={freeze}>
            {baseline ? '重新冻结基线' : '冻结当前规则为基线'}
          </button>
          <button className="danger" onClick={clearBaseline} disabled={!baseline}>
            清除基线
          </button>
          <button
            className="primary"
            onClick={runAll}
            disabled={!baseline || cases.length === 0}
          >
            运行回归{cases.length > 0 ? `（${cases.length} 条用例）` : ''}
          </button>
        </div>
      </div>

      {baseline ? (
        <p className="baseline-info">
          已冻结基线：{baseline.rules.length} 条规则
          {frozenAt !== '' && ` · 冻结于 ${frozenAt}`}
          。基线为深拷贝快照，之后对规则表的编辑不会影响它；可重新冻结或清除。
        </p>
      ) : (
        <p className="empty">
          尚未冻结基线。点击「冻结当前规则为基线」保存当前规则表的深拷贝快照，
          之后继续编辑规则，即可用同一批用例对比基线与当前规则的行为差异。
        </p>
      )}

      <h3 className="reg-subtitle">用例（方法 + URL）</h3>
      {cases.map((c) => (
        <div className="case-row" key={c.id}>
          <select
            value={c.method}
            onChange={(e) => updateCase(c.id, { method: e.target.value })}
          >
            {REQUEST_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            value={c.url}
            placeholder="http://api.example.com/v1/users/42"
            spellCheck={false}
            onChange={(e) => updateCase(c.id, { url: e.target.value })}
          />
          <button className="danger" onClick={() => removeCase(c.id)}>
            删除
          </button>
        </div>
      ))}
      {cases.length === 0 && (
        <p className="empty">暂无用例。点击「添加用例」登记一条「方法 + URL」。</p>
      )}
      <div className="case-add">
        <button onClick={addCase}>＋ 添加用例</button>
      </div>

      {lastRun && (
        <div className="reg-results">
          <h3 className="reg-subtitle">
            回归结果：共 {lastRun.results.length} 条用例，
            {changedCount === 0 ? (
              <span className="ok-text">全部一致</span>
            ) : (
              <span className="changed-text">{changedCount} 条有变化</span>
            )}
          </h3>
          {stale && (
            <div className="banner warn">
              ⚠️ 规则、基线或用例在上次运行后已变更，以下结果可能已过期，请重新运行回归。
            </div>
          )}
          {lastRun.results.map((run) => (
            <CaseResultRow
              key={run.testCase.id}
              run={run}
              expanded={expanded.has(run.testCase.id)}
              onToggle={() => toggle(run.testCase.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

import { useMemo, useState } from 'react';
import type { Rule, Simulation } from '../types';
import { minimizeRules, type MinimizeEntry, type MinimizeReport } from '../minimize';
import { StepCard } from './TraceView';

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

/** 保留 / 剔除规则清单中的一条：按原顺序展示序号与名称 */
function RuleRef({ entry }: { entry: MinimizeEntry }) {
  return (
    <li className="mz-rule">
      <span className="mz-rule-order">#{entry.index + 1}</span>
      <span className="mz-rule-name">{entry.rule.name}</span>
      <span className={`tag action-${entry.rule.action.type}`}>
        {entry.rule.action.type}
      </span>
    </li>
  );
}

function TraceColumn({ title, sim }: { title: string; sim: Simulation }) {
  return (
    <div className="trace-col">
      <h4>{title}</h4>
      {sim.steps.length === 0 && <p className="empty">（无命中步骤）</p>}
      {sim.steps.map((s) => (
        <StepCard key={s.n} step={s} />
      ))}
    </div>
  );
}

interface Props {
  /** 当前规则表（生成时冻结快照） */
  rules: Rule[];
  /** 模拟器中的方法（生成时冻结） */
  method: string;
  /** 模拟器中的 URL（生成时冻结） */
  url: string;
}

/**
 * 请求最小复现面板：接收模拟器中的「方法 + URL」与当前规则表，
 * 对已启用规则做分块删除试探，找出仍能复现同一可观察结果的最小规则子集。
 * 输入与结果只保留在当前页面会话（内存），不写入 localStorage。
 */
export function MinimizePanel({ rules, method, url }: Props) {
  const [touched, setTouched] = useState(false);
  const [lastRun, setLastRun] = useState<{ stamp: string; report: MinimizeReport } | null>(
    null,
  );

  // 输入指纹：规则或请求（方法 / URL）变化后，上次结果标记为过期
  const stamp = useMemo(() => JSON.stringify({ rules, method, url }), [rules, method, url]);
  const stale = lastRun !== null && lastRun.stamp !== stamp;
  const report = lastRun?.report ?? null;

  const empty = url.trim() === '';

  const run = () => {
    setTouched(true);
    if (empty) return;
    // minimizeRules 内部深拷贝规则表并冻结方法 / URL：本次结果基于生成时快照
    setLastRun({ stamp, report: minimizeRules(rules, method, url) });
  };

  const download = () => {
    if (!report || report.status !== 'reduced') return;
    // 仅含保留规则的现有导入格式 JSON（validateRules 可直接导入）
    const blob = new Blob(
      [JSON.stringify(report.retained.map((e) => e.rule), null, 2)],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'url-rules-minimal.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="panel minimize-panel">
      <div className="panel-title">
        <h2>请求最小复现</h2>
        <div className="toolbar">
          <button className="primary" onClick={run} disabled={empty}>
            缩减规则
          </button>
        </div>
      </div>
      <p className="baseline-info">
        接收上方模拟器中的「方法 + URL」与当前规则表：先复用 simulate 取得原始结果，
        再对已启用规则<strong>按原顺序分块删除试探、逐条复核</strong>，找出仍能复现同一
        <strong>可观察结果</strong>的最小规则子集——终止类型须相同，final 比较最终 URL，
        redirect 比较状态码与 Location，其余类型只比较终止类型。每次试探都重新完整模拟，
        允许命中轨迹改变（避免删除后首命中转移造成误判）。生成时冻结输入；
        规则或请求变化后结果标记过期。
      </p>
      <div className="mz-request">
        <span className="tag case-method">{method}</span>
        <code className="mz-request-url">{empty ? '（模拟器中尚未填写 URL）' : url}</code>
      </div>
      {touched && empty && <div className="banner error">请先在模拟器中输入待复现的 URL。</div>}

      {report && (
        <div className="mz-results">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或请求在上次缩减后已变更，以下结果可能已过期，请重新缩减。
            </div>
          )}

          <p className="mz-frozen">
            生成时已冻结：<span className="tag case-method">{report.method}</span>{' '}
            <code>{report.inputUrl}</code> · 共 {report.ruleCount} 条规则
            （已启用 {report.ruleCount - report.disabled.length} 条
            {report.disabled.length > 0 && `、未启用 ${report.disabled.length} 条`}）
          </p>

          {report.status === 'invalid-url' && (
            <div className="banner error">
              <strong>❌ URL 非法，无法缩减</strong>
              <p>{report.original.reason}</p>
            </div>
          )}

          {report.status === 'no-hit' && (
            <div className="banner warn">
              <strong>⚪ 无命中，无法缩减</strong>
              <p>
                请求「{report.method} {report.inputUrl}」没有命中任何已启用规则，
                原始结果就是直接放行（空规则子集），不存在需要复现的规则，无法缩减。
              </p>
            </div>
          )}

          {report.status === 'reduced' && report.reduced && (
            <>
              <div className="banner ok">
                <strong>
                  ✅ 缩减完成：保留 {report.retained.length} 条、剔除{' '}
                  {report.removed.length} 条
                </strong>
                <p>
                  共试探 {report.attempts} 次（每次重新完整模拟）；保留集满足
                  「任意单条删除都会改变可观察结果」。
                  {report.disabled.length > 0 &&
                    ` 另有 ${report.disabled.length} 条未启用规则自始不参与匹配，不列入保留集。`}
                </p>
              </div>

              <div className="mz-rule-cols">
                <div className="mz-rule-col">
                  <h3 className="reg-subtitle">
                    保留规则（{report.retained.length}）
                  </h3>
                  {report.retained.length === 0 ? (
                    <p className="empty">（无）</p>
                  ) : (
                    <ul className="mz-rule-list mz-kept">
                      {report.retained.map((e) => (
                        <RuleRef key={e.index} entry={e} />
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mz-rule-col">
                  <h3 className="reg-subtitle">
                    剔除规则（{report.removed.length}）
                  </h3>
                  {report.removed.length === 0 ? (
                    <p className="empty">（没有一条可以剔除，每条都必要）</p>
                  ) : (
                    <ul className="mz-rule-list mz-removed">
                      {report.removed.map((e) => (
                        <RuleRef key={e.index} entry={e} />
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <h3 className="reg-subtitle">缩减前后可观察结果</h3>
              <div className="outcome-cols">
                <div className="outcome-col">
                  <span className="share-label">缩减前（全部规则）</span>
                  <OutcomeView sim={report.original} />
                </div>
                <div className="outcome-col">
                  <span className="share-label">缩减后（仅保留规则）</span>
                  <OutcomeView sim={report.reduced} />
                </div>
              </div>

              <div className="trace-cols">
                <TraceColumn
                  title={`缩减前轨迹（${report.original.steps.length} 步）`}
                  sim={report.original}
                />
                <TraceColumn
                  title={`缩减后轨迹（${report.reduced.steps.length} 步）`}
                  sim={report.reduced}
                />
              </div>

              <div className="mz-download">
                <button onClick={download} disabled={stale}>
                  ⬇ 下载仅含保留规则的 JSON（现有导入格式）
                </button>
                {stale && (
                  <span className="mz-download-note">结果已过期，重新缩减后才能下载。</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

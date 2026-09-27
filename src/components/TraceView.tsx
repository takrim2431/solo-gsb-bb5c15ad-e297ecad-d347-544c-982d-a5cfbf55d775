import type { Simulation, Step } from '../types';
import { formatQueryConditions } from '../types';
import { MAX_STEPS } from '../engine';

const ACTION_LABEL: Record<Step['rule']['action']['type'], string> = {
  rewrite: '重写',
  redirect: '重定向',
  stop: '停止',
};

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '?';
  }
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '?';
  }
}

/** 命中前 URL 的查询串原文（含前导 ?）；无查询串时返回空串 */
function searchOf(u: string): string {
  try {
    return new URL(u).search;
  } catch {
    return '';
  }
}

export function StepCard({
  step,
  showRuleId = false,
  pending = false,
  pauseReason,
}: {
  step: Step;
  /** 回归对比等场景需要按 rule.id 定位差异时开启 */
  showRuleId?: boolean;
  /** 断点 / 单步暂停：动作尚未执行，只展示即将执行的动作（不显示执行结果） */
  pending?: boolean;
  /** 暂停时标注停在断点还是单步 */
  pauseReason?: 'breakpoint' | 'step';
}) {
  const { rule } = step;
  const paramEntries = Object.entries(step.params);
  return (
    <div className={`step${pending ? ' step-pending' : ''}`}>
      <header>
        <span className="step-n">步骤 {step.n}</span>
        命中规则 #{step.ruleIndex + 1}「{rule.name}」
        <span className={`tag action-${rule.action.type}`}>
          {ACTION_LABEL[rule.action.type]}
        </span>
        {pauseReason === 'breakpoint' && <span className="tag tag-bp">⏸ 断点暂停</span>}
        {pauseReason === 'step' && <span className="tag tag-step">⏸ 单步暂停</span>}
      </header>
      <ul className="conds">
        <li>
          方法 <code>{step.method}</code> ✓ 匹配{' '}
          <code>{rule.method === 'ANY' ? 'ANY（任意方法）' : rule.method}</code>
        </li>
        <li>
          主机 <code>{hostOf(step.urlBefore)}</code> ✓ 匹配 <code>{rule.host}</code>
        </li>
        <li>
          路径 <code>{pathOf(step.urlBefore)}</code> ✓ 匹配模板{' '}
          <code>{rule.pathTemplate.trim() === '' ? '（任意路径）' : rule.pathTemplate}</code>
        </li>
        {(rule.query ?? []).length > 0 && (
          <li>
            查询 <code>{searchOf(step.urlBefore) || '（无查询串）'}</code> ✓ 满足{' '}
            <code>{formatQueryConditions(rule.query ?? [])}</code>
          </li>
        )}
      </ul>
      {paramEntries.length > 0 && (
        <div className="params">
          路径参数：
          {paramEntries.map(([k, v]) => (
            <span key={k} className="chip">
              :{k} = {v}
            </span>
          ))}
        </div>
      )}
      <div className="url-line">
        <span className="url-from">{step.urlBefore}</span>
        {pending && (
          <>
            <span className="arrow">即将执行 · {ACTION_LABEL[rule.action.type]}</span>
            {rule.action.type !== 'stop' && (
              <span className="url-to url-pending">{rule.action.target}</span>
            )}
          </>
        )}
        {!pending && rule.action.type === 'rewrite' && (
          <>
            <span className="arrow">→ 重写为</span>
            <span className="url-to">{step.urlAfter}</span>
          </>
        )}
        {!pending && rule.action.type === 'redirect' && (
          <>
            <span className="arrow">→ {step.status} 重定向到</span>
            <span className="url-to">{step.location}</span>
          </>
        )}
        {!pending && rule.action.type === 'stop' && (
          <span className="arrow">→ 请求被停止</span>
        )}
      </div>
      <div className="state-key">状态键：{step.stateKey}</div>
      {showRuleId && <div className="state-key">规则 id：{rule.id}</div>}
    </div>
  );
}

const STATUS_META: Record<
  Simulation['status'],
  { cls: string; icon: string; title: string }
> = {
  final: { cls: 'ok', icon: '✅', title: '成功 · 得出最终 URL' },
  redirect: { cls: 'ok', icon: '↪️', title: '成功 · 重定向终止' },
  stopped: { cls: 'warn', icon: '⛔', title: '终止 · 规则停止' },
  loop: { cls: 'error', icon: '🔁', title: '失败 · 检测到循环' },
  'max-steps': { cls: 'error', icon: '⚠️', title: `失败 · 超过 ${MAX_STEPS} 步上限` },
  'invalid-url': { cls: 'error', icon: '❌', title: '失败 · URL 无法解析' },
  'invalid-target': { cls: 'error', icon: '❌', title: '失败 · 目标无法解析' },
};

export function TraceView({ sim }: { sim: Simulation }) {
  return (
    <section className="panel">
      <h2>执行轨迹（共 {sim.steps.length} 步）</h2>
      {sim.steps.length === 0 && sim.status !== 'invalid-url' && (
        <p className="empty">没有任何规则命中。</p>
      )}
      {sim.steps.map((s) => (
        <StepCard key={s.n} step={s} />
      ))}
      <ResultBanner sim={sim} />
    </section>
  );
}

/** 终止结果横幅：执行轨迹与断点调试结束时共用 */
export function ResultBanner({ sim }: { sim: Simulation }) {
  const meta = STATUS_META[sim.status];
  return (
    <div className={`banner ${meta.cls}`}>
      <strong>
        {meta.icon} {meta.title}
      </strong>
      <p>{sim.reason}</p>
      {sim.status === 'final' && sim.finalUrl && (
        <p>
          最终 URL：<code className="url-to">{sim.finalUrl}</code>
        </p>
      )}
      {sim.status === 'redirect' && (
        <p>
          {sim.redirectStatus} Location：
          <code className="url-to">{sim.redirectLocation}</code>
        </p>
      )}
    </div>
  );
}

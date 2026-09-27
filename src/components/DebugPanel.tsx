import type { DebugSession } from '../debug';
import { StepCard, ResultBanner } from './TraceView';

interface Props {
  session: DebugSession;
  /** 规则或请求已变化，暂停会话过期 */
  stale: boolean;
  onStep: () => void;
  onResume: () => void;
  onRestart: () => void;
  onStop: () => void;
}

function DebugPanel({ session, stale, onStep, onResume, onRestart, onStop }: Props) {
  const { pending, pauseReason, steps, result, finished } = session;

  return (
    <section className="panel debug-panel">
      <div className="panel-title">
        <h2>
          断点调试
          <span className="debug-state">
            {finished ? '已终止' : stale ? '会话已过期' : '暂停中'}
          </span>
        </h2>
        <div className="toolbar">
          {!finished && (
            <>
              <button onClick={onStep} disabled={stale} title="执行当前动作后，停在下一条实际命中规则前">
                ⤼ 单步
              </button>
              <button
                className="primary"
                onClick={onResume}
                disabled={stale}
                title="运行到下一断点；之后没有断点则运行到终止"
              >
                ⏵ 继续
              </button>
              <span className="toolbar-sep" aria-hidden />
              <button onClick={onRestart}>重新开始调试</button>
              <button className="danger" onClick={onStop}>
                结束调试
              </button>
            </>
          )}
          {finished && (
            <>
              <button onClick={onRestart}>重新开始调试</button>
              <button className="danger" onClick={onStop}>
                结束调试
              </button>
            </>
          )}
        </div>
      </div>

      {!finished && (
        <p className="debug-context">
          当前请求：<code>{session.method}</code>{' '}
          <code>{session.inputUrl}</code>
          <span className="debug-count">
            已执行 {steps.length} 步 · 命中断点 {session.breakpointHits} 次
          </span>
        </p>
      )}

      {stale && !finished && (
        <div className="banner warn">
          规则或请求自调试开始后已变化，本次暂停会话已作废。点击「重新开始调试」
          按最新规则与请求从第一条规则重新执行；也可以「结束调试」放弃本次会话。
        </div>
      )}

      {!finished && pending && (
        <div className="banner warn">
          即将执行第 {pending.n} 步命中的第 {pending.ruleIndex + 1} 条规则「
          {pending.rule.name}」的{pauseReason === 'breakpoint' ? '断点' : '单步'}
          暂停动作：方法 <code>{pending.method}</code>，URL{' '}
          <code>{pending.urlBefore}</code>
          {Object.keys(pending.params).length > 0 && (
            <>
              {' '}
              ，已捕获路径参数{' '}
              {Object.entries(pending.params).map(([k, v]) => (
                <span key={k} className="chip">
                  :{k} = {v}
                </span>
              ))}
            </>
          )}
        </div>
      )}

      {steps.map((s) => (
        <StepCard key={s.n} step={s} />
      ))}

      {!finished && pending && (
        <StepCard step={pending} pending pauseReason={pauseReason ?? undefined} />
      )}

      {finished && result && (
        <>
          <div className="debug-finished-note">
            调试结束（共 {result.steps.length} 步，命中断点 {session.breakpointHits} 次）
          </div>
          <ResultBanner sim={result} />
        </>
      )}
    </section>
  );
}

export default DebugPanel;

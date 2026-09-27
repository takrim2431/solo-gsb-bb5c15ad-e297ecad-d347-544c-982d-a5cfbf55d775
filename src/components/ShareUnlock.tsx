import { useState } from 'react';
import type { SharePayload } from '../share';
import { openShare } from '../share';

interface Props {
  /** location.hash 中的加密片段 */
  fragment: string;
  /** 用户确认预览后调用：只有确认才会真正替换状态 */
  onConfirm: (payload: SharePayload) => void;
  /** 用户放弃导入：移除 hash 回到主界面，不改动任何当前状态 */
  onAbort: () => void;
}

type Stage = 'enter' | 'preview';

/**
 * 打开加密分享链接时的解锁页：界面上只有口令输入框。
 * 解密 + 校验成功后先展示预览，由用户显式确认才替换状态；
 * 口令错误、密文损坏、内容不合法或用户取消，都不改动当前状态。
 */
export function ShareUnlock({ fragment, onConfirm, onAbort }: Props) {
  const [stage, setStage] = useState<Stage>('enter');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<SharePayload | null>(null);

  const unlock = async () => {
    if (password === '') {
      setError('请输入口令');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const opened = await openShare(fragment, password);
      // 解密与校验都通过，但先不动任何当前状态，只展示预览
      setPayload(opened);
      setStage('preview');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app unlock-page">
      <header className="app-header">
        <h1>URL 路由规则调试台</h1>
        <p>收到一个加密分享链接，内容已通过 AES-GCM 加密。请输入口令解锁并预览。</p>
      </header>

      <div className="panel unlock-panel">
        {stage === 'enter' || !payload ? (
          <>
            <h2>输入分享口令</h2>
            <form
              className="sim-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void unlock();
              }}
            >
              <input
                type="password"
                value={password}
                autoFocus
                autoComplete="off"
                placeholder="分享口令"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="submit" className="primary" disabled={busy}>
                {busy ? '解密中…' : '解锁'}
              </button>
            </form>
            {error && <div className="banner error">{error}</div>}
            <p className="unlock-hint">
              口令错误或链接被篡改时无法解密，且不会影响你当前的规则表。
            </p>
            <div className="modal-actions">
              <button onClick={onAbort} disabled={busy}>放弃导入，返回调试台</button>
            </div>
          </>
        ) : (
          <>
            <h2>预览分享内容</h2>
            <div className="banner ok">
              口令正确，内容校验通过。确认后将<strong>整体替换</strong>当前规则表、
              请求方法与 URL，并清空已有执行轨迹。
            </div>
            <div className="share-preview">
              <div>
                <span className="share-label">请求方法</span>
                <code>{payload.method}</code>
              </div>
              <div>
                <span className="share-label">请求 URL</span>
                <code className="url-from">{payload.url}</code>
              </div>
              <div>
                <span className="share-label">
                  规则表（{payload.rules.length} 条）
                </span>
                <ol className="share-rule-list">
                  {payload.rules.map((r, i) => (
                    <li key={r.id}>
                      <span className="rule-order">#{i + 1}</span>
                      {r.enabled ? '' : '（已停用）'}
                      <strong>{r.name}</strong>
                      <code>
                        {' '}{r.method} {r.host || '*'}{r.pathTemplate || '/*'} →{' '}
                        {r.action.type}
                        {r.action.type === 'stop' ? '' : ` ${r.action.target}`}
                      </code>
                    </li>
                  ))}
                  {payload.rules.length === 0 && (
                    <li className="empty">（空规则表）</li>
                  )}
                </ol>
              </div>
            </div>
            <div className="modal-actions">
              <button onClick={() => { setStage('enter'); setPayload(null); }}>
                取消
              </button>
              <button
                className="primary"
                onClick={() => onConfirm(payload)}
              >
                确认替换并导入
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { Rule } from '../types';
import { buildShareUrl, encryptShare } from '../share';

interface Props {
  rules: Rule[];
  method: string;
  url: string;
  onClose: () => void;
}

/**
 * 「加密分享」创建对话框：
 * 输入并确认口令后，在本地派生密钥、加密当前规则表 / 方法 / URL，
 * 生成写入 hash 的链接供复制。口令只保留在组件内存中，
 * 生成或关闭后即清空，绝不进入链接与 localStorage。
 */
export function ShareCreateDialog({ rules, method, url, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    // 关闭即擦除内存中的口令与链接
    setPassword('');
    setConfirmPwd('');
    setShareUrl(null);
    onClose();
  };

  const generate = async () => {
    if (password === '') {
      setError('请输入口令');
      return;
    }
    if (password !== confirmPwd) {
      setError('两次输入的口令不一致');
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const fragment = await encryptShare({ rules, method, url }, password);
      const full = buildShareUrl(fragment);
      window.history.replaceState(null, '', full);
      setShareUrl(full);
      // 口令完成使命，立即从内存擦除
      setPassword('');
      setConfirmPwd('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      // 非安全上下文或无剪贴板权限时降级为手动选择复制
      const input = document.getElementById('share-url-input') as HTMLInputElement | null;
      input?.select();
      document.execCommand('copy');
      setCopied(true);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="share-create-title">
        <h2 id="share-create-title">加密分享当前配置</h2>

        {!shareUrl ? (
          <>
            <p className="modal-desc">
              将加密分享当前 <strong>{rules.length}</strong> 条规则、请求方法
              <code> {method}</code> 与 URL。链接本身不含明文与口令，
              口令经 PBKDF2-SHA-256（150000 次）派生密钥，AES-GCM 加密，
              全程仅在浏览器端完成。请通过其他安全渠道把口令告知对方。
            </p>
            <div className="share-preview">
              <div>
                <span className="share-label">请求</span>
                <code>{method} {url}</code>
              </div>
            </div>
            <label className="field">
              口令
              <input
                type="password"
                value={password}
                autoFocus
                autoComplete="new-password"
                placeholder="设置一个分享口令"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              确认口令
              <input
                type="password"
                value={confirmPwd}
                autoComplete="new-password"
                placeholder="再次输入口令"
                onChange={(e) => setConfirmPwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void generate();
                }}
              />
            </label>
            {error && <div className="banner error">{error}</div>}
            <div className="modal-actions">
              <button onClick={close} disabled={busy}>取消</button>
              <button className="primary" onClick={generate} disabled={busy}>
                {busy ? '加密中…' : '生成分享链接'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-desc">
              链接已写入地址栏（仅含密文）。复制链接连同口令一起发送给对方；
              忘记口令将无法恢复内容。
            </p>
            <input
              id="share-url-input"
              className="share-url"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.target.select()}
            />
            {copied && <div className="banner ok">已复制到剪贴板</div>}
            <div className="modal-actions">
              <button onClick={close}>关闭</button>
              <button className="primary" onClick={copy}>
                {copied ? '再次复制' : '复制链接'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

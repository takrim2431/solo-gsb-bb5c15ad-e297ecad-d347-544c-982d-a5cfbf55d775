import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import { findBundleIssues, generateBundle } from '../bundle';

interface Props {
  rules: Rule[];
  onClose: () => void;
}

/**
 * 「导出可执行路由器」对话框：
 * 把当前已启用规则生成单个自 route-bundle.mjs（自包含、零依赖），
 * 提供代码预览、复制与下载；规则不合法时列出位置并阻止导出。
 */
export function BundleExportDialog({ rules, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const enabledCount = rules.filter((r) => r.enabled).length;
  const issues = useMemo(() => findBundleIssues(rules), [rules]);
  const code = useMemo(() => generateBundle(rules), [rules]);
  const blocked = issues.length > 0 || enabledCount === 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // 非安全上下文或无剪贴板权限时降级为选中复制
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
    }
  };

  const download = () => {
    const blob = new Blob([code], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'route-bundle.mjs';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="bundle-title">
        <h2 id="bundle-title">导出可执行路由器</h2>
        <p className="modal-desc">
          将当前 <strong>{enabledCount}</strong> 条已启用规则（共 {rules.length} 条）
          打包为单个 <code>route-bundle.mjs</code>：不依赖项目源码与第三方包，
          可直接 <code>node route-bundle.mjs METHOD URL</code> 运行（Node 20+），
          也可 <code>import {'{ route }'}</code> 调用。语义与调试台一致：
          首条命中、重写后从头匹配、路径参数替换、查询参数条件（存在 / 不存在 / 值等于）、
          循环检测、20 步上限。
        </p>

        {enabledCount === 0 && (
          <div className="banner error">没有已启用的规则，无法导出。</div>
        )}

        {issues.length > 0 && (
          <div className="banner error">
            {issues.length} 条已启用规则不合法，已阻止导出：
            <ul className="bundle-issues">
              {issues.map((issue, i) => (
                <li key={i}>
                  第 {issue.index + 1} 条规则「{issue.ruleName}」：{issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <pre className="bundle-preview"><code>{code}</code></pre>

        {copied && <div className="banner ok">已复制到剪贴板</div>}

        <div className="modal-actions">
          <button onClick={onClose}>关闭</button>
          <button onClick={copy} disabled={blocked}>
            {copied ? '再次复制' : '复制代码'}
          </button>
          <button className="primary" onClick={download} disabled={blocked}>
            下载 route-bundle.mjs
          </button>
        </div>
      </div>
    </div>
  );
}

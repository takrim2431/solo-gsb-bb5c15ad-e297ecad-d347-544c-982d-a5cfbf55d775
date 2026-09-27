import { useSyncExternalStore } from 'react';
import {
  clearQuarantine,
  downloadDiagnostics,
  getQuarantineEntries,
  subscribeQuarantine,
  type QuarantineEntry,
} from '../persistence';

const REASON_LABELS: Record<QuarantineEntry['reason'], string> = {
  unreadable: '内容无法解析',
  'unknown-version': '版本不被识别',
  'invalid-data': '数据结构无效',
  'migration-error': '迁移失败',
};

/**
 * 启动期（或其他组件读取时）隔离的损坏存储数据在此提示：
 * 不阻塞应用使用，支持一键下载诊断 JSON 或忽略（清空隔离区）。
 */
export function StorageDiagnosticsBanner() {
  const entries = useSyncExternalStore(
    subscribeQuarantine,
    () => getQuarantineEntries() as QuarantineEntry[],
    () => [] as QuarantineEntry[],
  );

  if (entries.length === 0) return null;

  const byStore = new Map<string, QuarantineEntry[]>();
  for (const entry of entries) {
    byStore.set(entry.store, [...(byStore.get(entry.store) ?? []), entry]);
  }

  return (
    <div className="banner error storage-diag-banner" role="alert">
      <div className="storage-diag-head">
        <strong>
          ⚠️ 检测到 {entries.length} 条无法读取的本地存储数据（
          {[...byStore.keys()].join(' / ')}），已隔离，不影响应用使用。
        </strong>
        <div className="toolbar">
          <button className="primary" onClick={() => downloadDiagnostics()}>
            下载诊断 JSON
          </button>
          <button onClick={() => clearQuarantine()}>忽略并清除</button>
        </div>
      </div>
      <ul className="storage-diag-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <code>{entry.storeKey}</code>
            <span className="tag">{REASON_LABELS[entry.reason]}</span>
            {entry.fromVersion !== undefined && <span>数据版本 v{entry.fromVersion}</span>}
            <span>{entry.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

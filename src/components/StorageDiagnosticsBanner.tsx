import { useSyncExternalStore } from 'react';
import {
  clearQuarantine,
  downloadDiagnostics,
  getQuarantineEntries,
  getStorageHealth,
  subscribeQuarantine,
  subscribeStorageHealth,
  type QuarantineEntry,
} from '../persistence';

const REASON_LABELS: Record<QuarantineEntry['reason'], string> = {
  unreadable: '内容无法解析',
  'unknown-version': '版本不被识别',
  'invalid-data': '数据结构无效',
  'migration-error': '迁移失败',
};

/**
 * 浏览器存储（localStorage）读写 / 删除抛错后的粘滞降级提示：
 * 规则表、回归基线 / 用例与诊断记录此刻起只保存在**本页面内存副本**中，
 * 同页操作与重读都正常，但刷新 / 关闭页面可能丢失——明确不显示为已持久化。
 * 状态随运行中发生的降级实时出现（由存储适配器通知）。
 */
export function StorageHealthBanner() {
  const health = useSyncExternalStore(
    subscribeStorageHealth,
    getStorageHealth,
    getStorageHealth,
  );

  if (!health.degraded) return null;

  return (
    <div className="banner warn storage-health-banner" role="status">
      <strong>⚠️ 浏览器本地存储不可用，当前改动仅保存在本页面（内存）。</strong>
      <p>
        规则表、回归基线 / 用例等数据在本次页面会话内可正常编辑、删除与重读，
        但无法写入磁盘；<strong>刷新或关闭页面后可能全部丢失</strong>
        {health.error ? `（存储错误：${health.error}）` : ''}
        。如需保留，请先用规则表的「导出 JSON」下载，或修复浏览器存储
        （关闭无痕模式 / 释放站点配额）后重新打开本页。
      </p>
    </div>
  );
}

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

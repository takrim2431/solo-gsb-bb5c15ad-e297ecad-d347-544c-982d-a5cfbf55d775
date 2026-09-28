import { useSyncExternalStore } from 'react';
import {
  isStorageDegraded,
  subscribeStorageDegraded,
} from '../persistence';

/**
 * 浏览器存储降级提示：localStorage 可读但写入 / 删除抛错（典型为配额耗尽），
 * 或存储自启动即不可用时，规则表与回归数据只保存在**本页面内存副本**中。
 *
 * 状态随运行中降级实时出现（适配器翻转时通知），且不把内存保存伪装成已持久化：
 * 明确告知「仅本页临时保存、刷新可能丢失」。
 */
export function StorageDegradedBanner() {
  const degraded = useSyncExternalStore(
    subscribeStorageDegraded,
    () => isStorageDegraded(),
    () => false,
  );

  if (!degraded) return null;

  return (
    <div className="banner warn storage-degraded-banner" role="status">
      <strong>⚠️ 浏览器本地存储不可用：规则与回归数据仅临时保存在本页面内存中。</strong>
      <span>
        本次会话内编辑、保存、删除都照常生效且彼此一致；但<strong>刷新或关闭页面后可能恢复为磁盘上的旧数据（或丢失）</strong>，
        请改用「导出 JSON」或加密分享链接留存内容。常见原因：浏览器存储配额已满、隐私 / 无痕模式或站点存储被禁用。
      </span>
    </div>
  );
}

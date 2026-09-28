import { useCallback, useEffect, useState } from 'react';
import type { Rule, Simulation } from './types';
import { simulate } from './engine';
import { DebugSession, debugContextKey } from './debug';
import { PRESETS } from './samples';
import { useRuleHistory } from './useRuleHistory';
import { RulesPanel } from './components/RulesPanel';
import { Simulator } from './components/Simulator';
import { TraceView } from './components/TraceView';
import DebugPanel from './components/DebugPanel';
import { RedirectChainPanel } from './components/RedirectChainPanel';
import { MinimizePanel } from './components/MinimizePanel';
import { RegressionPanel } from './components/RegressionPanel';
import { CoveragePanel } from './components/CoveragePanel';
import { PartialIntersectionPanel } from './components/PartialIntersectionPanel';
import { ShareCreateDialog } from './components/ShareCreateDialog';
import { ShareUnlock } from './components/ShareUnlock';
import {
  cleanLocationUrl,
  parseShareHash,
  type SharePayload,
} from './share';
import { loadManaged, rulesStore, type ManagedStore } from './persistence';
import {
  StorageDiagnosticsBanner,
  StorageHealthBanner,
} from './components/StorageDiagnosticsBanner';

/** 首次渲染时读取一次版本化存储（含历史数据迁移、损坏隔离、临时键恢复）；
 * 加载永不抛出，损坏数据回退为示例规则并可在诊断横幅中下载 */
let rulesManaged: ManagedStore<Rule[]> | null = null;
function loadRules(): Rule[] {
  if (rulesManaged === null) rulesManaged = loadManaged(rulesStore);
  return rulesManaged.value;
}

function readPendingShare(): string | null {
  try {
    return parseShareHash(window.location.hash);
  } catch {
    return null;
  }
}

/** 移除地址栏中的分享 hash（用 replaceState，不新增历史记录） */
function removeShareHash() {
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', cleanLocationUrl());
  }
}

/** 事件目标是否是可编辑控件：此时保留浏览器原生编辑行为，不拦截快捷键 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  // 打开分享链接时，整个调试台让位给口令解锁页；任何解密/校验失败都保持当前状态不变
  const [pendingShare, setPendingShare] = useState<string | null>(readPendingShare);
  const [sharing, setSharing] = useState(false);

  const hist = useRuleHistory(loadRules);
  const { rules } = hist;
  const [method, setMethod] = useState(PRESETS[0].method);
  const [url, setUrl] = useState(PRESETS[0].url);
  const [sim, setSim] = useState<Simulation | null>(null);
  // 断点仅保留在当前页面会话（内存），不写入 localStorage
  const [breakpoints, setBreakpoints] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [debug, setDebug] = useState<DebugSession | null>(null);
  // 每次调试状态变化（暂停 / 继续 / 单步）递增，强制重渲染面板
  const [, setDebugTick] = useState(0);
  const bump = useCallback(() => setDebugTick((t) => t + 1), []);

  useEffect(() => {
    // 经版本化持久化层原子写入：临时键校验通过后再替换主键，
    // 刷新 / 崩溃落在任何一步都不会读到半写入数据；浏览器存储报错
    // （配额 / 隐私模式等）后粘滞降级到本页内存副本，保存仍成功、
    // 同页重读为最新值，页面顶部横幅明确提示刷新可能丢失
    rulesManaged?.save(rules);
  }, [rules]);

  const toggleBreakpoint = useCallback((ruleId: string) => {
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }, []);

  // 撤销 / 重做恢复的是完整规则快照，旧轨迹引用的是旧快照，因此同时清空当前模拟轨迹；
  // 进行中的断点会话也因规则变化而过期，由 contextKey 比对自动提示重新开始。
  const undo = useCallback(() => {
    const ok = hist.undo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);
  const redo = useCallback(() => {
    const ok = hist.redo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);

  // Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做；焦点在输入控件时交给浏览器原生编辑行为
  useEffect(() => {
    if (pendingShare) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingShare, undo, redo]);

  // 监听浏览器前进 / 后退或手工改写 hash 带来的分享链接变化
  useEffect(() => {
    const onHashChange = () => setPendingShare(readPendingShare());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 普通「运行」：保持原行为，一次跑完全程；同时结束任何进行中的断点会话
  const run = () => {
    setSim(simulate(rules, method, url));
    setDebug(null);
  };

  const startDebug = useCallback(() => {
    const session = new DebugSession(
      rules,
      method,
      url,
      breakpoints,
      debugContextKey(rules, method, url),
    );
    session.start();
    setDebug(session);
    setSim(null);
    bump();
  }, [rules, method, url, breakpoints, bump]);

  const debugStep = useCallback(() => {
    debug?.step();
    bump();
  }, [debug, bump]);

  const debugResume = useCallback(() => {
    debug?.resume();
    bump();
  }, [debug, bump]);

  const stopDebug = useCallback(() => setDebug(null), []);

  // 部分交集见证：点击示例请求仅填入模拟输入，不自动运行、不改变模拟行为
  const fillRequest = useCallback((m: string, u: string) => {
    setMethod(m);
    setUrl(u);
  }, []);

  // 规则或请求变化时比对会话上下文签名：不一致即把暂停会话判为过期
  const debugStale =
    debug !== null &&
    !debug.finished &&
    debug.contextKey !== debugContextKey(rules, method, url);

  // 用户在预览页确认：此刻才真正替换状态，同时清空旧轨迹与地址栏 hash。
  // 分享导入相当于换了一份文档，撤销 / 重做分支一并清空。
  const confirmImport = (payload: SharePayload) => {
    hist.reset(payload.rules);
    setMethod(payload.method);
    setUrl(payload.url);
    setSim(null);
    setDebug(null);
    removeShareHash();
    setPendingShare(null);
  };

  // 用户放弃导入：仅移除 hash 回到调试台，当前规则表 / 请求 / 轨迹一概不动
  const abortImport = () => {
    removeShareHash();
    setPendingShare(null);
  };

  // 创建者关闭分享对话框：清掉自己刚写入地址栏的 hash（复制出的链接不受影响）
  const closeShareDialog = () => {
    setSharing(false);
    removeShareHash();
  };

  if (pendingShare) {
    return (
      <ShareUnlock
        fragment={pendingShare}
        onConfirm={confirmImport}
        onAbort={abortImport}
      />
    );
  }

  return (
    <div className="app">
      <StorageHealthBanner />
      <StorageDiagnosticsBanner />
      <header className="app-header">
        <h1>URL 路由规则调试台</h1>
        <p>
          编排有序规则（方法 / 主机 / 路径模板 / 查询参数条件 → 重写、重定向或停止），模拟请求逐步追踪命中过程。
          重写后从第一条规则重新匹配；以「方法 + URL」识别循环，最多执行 20 步。
        </p>
      </header>
      <main className="layout">
        <div className="left-col">
          <RulesPanel
            history={{ ...hist, undo, redo }}
            onShare={() => setSharing(true)}
            breakpoints={breakpoints}
            onToggleBreakpoint={toggleBreakpoint}
          />
          <CoveragePanel rules={rules} />
          <PartialIntersectionPanel rules={rules} onUseRequest={fillRequest} />
        </div>
        <div className="right-col">
          <Simulator
            method={method}
            url={url}
            onMethodChange={setMethod}
            onUrlChange={setUrl}
            onRun={run}
            onStartDebug={startDebug}
            breakpointCount={breakpoints.size}
            debugging={debug !== null}
          />
          {debug ? (
            <DebugPanel
              session={debug}
              stale={debugStale}
              onStep={debugStep}
              onResume={debugResume}
              onRestart={startDebug}
              onStop={stopDebug}
            />
          ) : (
            sim && <TraceView sim={sim} />
          )}
        </div>
      </main>
      <RedirectChainPanel rules={rules} />
      <MinimizePanel rules={rules} method={method} url={url} />
      <RegressionPanel rules={rules} />
      {sharing && (
        <ShareCreateDialog
          rules={rules}
          method={method}
          url={url}
          onClose={closeShareDialog}
        />
      )}
    </div>
  );
}

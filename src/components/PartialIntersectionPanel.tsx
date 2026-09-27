import { useMemo } from 'react';
import type { Rule } from '../types';
import {
  analyzePartialIntersections,
  type PartialIntersection,
} from '../intersection';

interface Props {
  rules: Rule[];
  /** 点击见证请求：填入模拟请求输入（不自动运行，模拟行为不受分析影响） */
  onUseRequest: (method: string, url: string) => void;
}

/** 规则名前的序号标记 */
function RuleRef({ index, name }: { index: number; name: string }) {
  return (
    <span className="pi-rule-ref">
      <span className="pi-rule-order">#{index + 1}</span>
      <span className="pi-rule-name">{name}</span>
    </span>
  );
}

function PairCard({
  item,
  onUseRequest,
}: {
  item: PartialIntersection;
  onUseRequest: (method: string, url: string) => void;
}) {
  return (
    <div className="pi-card">
      <div className="pi-pair">
        <RuleRef index={item.aIndex} name={item.aName} />
        <span className="pi-cross" title="部分交集">
          ⇄
        </span>
        <RuleRef index={item.bIndex} name={item.bName} />
      </div>
      <button
        type="button"
        className="pi-witness"
        title="点击填入模拟请求输入"
        onClick={() => onUseRequest(item.method, item.url)}
      >
        <span className="tag case-method">{item.method}</span>
        <code className="pi-url">{item.url}</code>
        <span className="pi-fill-hint">点击填入模拟 →</span>
      </button>
      <div className="pi-winner">
        {item.winnerInPair ? (
          <>
            当前顺序下先命中对中更早的一条：
            <RuleRef index={item.winnerIndex} name={item.winnerName} />
            <span className="pi-winner-note">
              （另一条在该请求上不会被触达；两者在规则表中相距{' '}
              {Math.abs(item.bIndex - item.aIndex)} 个位置）
            </span>
          </>
        ) : (
          <>
            <span className="tag tag-third">被更早的第三条抢先</span>
            该请求实际先命中
            <RuleRef index={item.winnerIndex} name={item.winnerName} />
            ，对中两条规则在当前顺序下都触达不到它。
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 部分交集见证面板：规则表每次变更即时重新分析已启用规则对，
 * 只展示「有共同请求、但双方都不能完整覆盖对方」的规则对，
 * 并给出两条规则都能命中的见证请求与当前顺序下实际先命中的规则。
 * 纯分析展示：不修改规则表，也不改变模拟行为。
 */
export function PartialIntersectionPanel({ rules, onUseRequest }: Props) {
  const items = useMemo(() => analyzePartialIntersections(rules), [rules]);
  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <section className="panel pi-panel">
      <div className="panel-title">
        <h2>部分交集见证</h2>
      </div>
      <p className="baseline-info">
        随规则表即时分析全部已启用规则（当前 {enabledCount} 条），只列出
        <strong>存在共同请求、但双方都不能完整覆盖对方</strong>的规则对：
        对方法、主机、路径段与查询条件分别求交，生成一条两条规则都能命中的
        <strong> METHOD URL</strong>（通配子域取至少一级子域；路径参数段与字面段兼容；
        不同 equals 值用同名重复查询参数同时满足；not-exists 与要求出现冲突时判无交集）。
        每条见证同时标出<strong>当前顺序下实际先命中的规则</strong>——可能是对中更早的一条，
        也可能被更早的第三条规则抢先。点击见证请求可填入模拟请求输入框（只填入、不自动运行）。
        分析仅作提示，不改变规则表与模拟行为。
      </p>
      {enabledCount < 2 ? (
        <p className="empty">已启用规则少于 2 条，不存在可求交的规则对。</p>
      ) : items.length === 0 ? (
        <p className="empty">
          已启用规则对之间没有部分交集：要么请求空间互不相交，要么一方已完整覆盖另一方
          （见规则卡片上的「不可达」遮蔽诊断）。
        </p>
      ) : (
        <>
          <h3 className="reg-subtitle">
            发现 {items.length} 对部分交集的已启用规则
          </h3>
          <div className="pi-list">
            {items.map((item) => (
              <PairCard
                key={`${item.aRuleId}⇄${item.bRuleId}`}
                item={item}
                onUseRequest={onUseRequest}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

import type { ChangeEvent } from 'react';
import type { QueryCondition, QueryOperator, Rule } from '../types';
import {
  formatQueryConditions,
  METHOD_MATCHERS,
  QUERY_OPERATOR_LABELS,
  QUERY_OPERATORS,
  REDIRECT_STATUSES,
} from '../types';
import type { ShadowReport } from '../shadow';
import type { TextSession } from './RulesPanel';

interface Props {
  rule: Rule;
  index: number;
  total: number;
  /** 遮蔽诊断结果：存在即表示该规则不可达 */
  shadow?: ShadowReport;
  /** 该规则上是否设有断点（仅保留在当前页面会话） */
  breakpoint: boolean;
  /** 离散改动（下拉选择、启停等）：立即作为一步进入历史 */
  onCommit: (next: Rule) => void;
  /** 文本输入框的聚焦 / 输入 / 失焦：同一次聚焦周期合并为一步 */
  session: TextSession<Rule>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onToggleBreakpoint: () => void;
}

const ACTION_LABEL: Record<Rule['action']['type'], string> = {
  rewrite: '重写',
  redirect: '重定向',
  stop: '停止',
};

/** 路径模式展示：空值与 * 都表示「任意路径」 */
function fmtPath(template: string): string {
  const t = template.trim();
  return t === '' ? '（空，任意路径）' : t;
}

/** 同一规则内被重复使用的查询参数名（导入 / 导出路由器前会作为定位错误拦截） */
function duplicateQueryNames(conds: QueryCondition[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const cond of conds) {
    const name = cond.name.trim();
    if (name === '') continue;
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  return [...dup];
}

export function RuleCard({
  rule,
  index,
  total,
  shadow,
  breakpoint,
  onCommit,
  session,
  onMove,
  onRemove,
  onToggleBreakpoint,
}: Props) {
  const set = <K extends keyof Rule>(key: K, value: Rule[K]) =>
    onCommit({ ...rule, [key]: value });
  const setAction = (patch: Partial<Rule['action']>) =>
    onCommit({ ...rule, action: { ...rule.action, ...patch } });
  const setQuery = (query: QueryCondition[]) => onCommit({ ...rule, query });

  /** 文本字段（name / host / pathTemplate）的连续输入合并为一步；失焦时 rule 已含最新输入 */
  const textProps = (key: 'name' | 'host' | 'pathTemplate') => ({
    value: rule[key],
    onFocus: session.begin,
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      session.change({ ...rule, [key]: e.target.value }),
    onBlur: () => session.end(rule),
  });

  /** 查询条件的参数名 / 比较值文本输入：同样按聚焦周期合并为一步 */
  const condTextProps = (ci: number, key: 'name' | 'value') => ({
    value: rule.query[ci][key],
    onFocus: session.begin,
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      session.change({
        ...rule,
        query: rule.query.map((c, j) => (j === ci ? { ...c, [key]: e.target.value } : c)),
      }),
    onBlur: () => session.end(rule),
  });

  const setCondOp = (ci: number, op: QueryOperator) =>
    setQuery(rule.query.map((c, j) => (j === ci ? { ...c, op } : c)));

  const addCond = () =>
    setQuery([...rule.query, { name: '', op: 'exists', value: '' }]);

  const removeCond = (ci: number) => setQuery(rule.query.filter((_, j) => j !== ci));

  const dupNames = duplicateQueryNames(rule.query);

  return (
    <div
      className={`rule-card${rule.enabled ? '' : ' rule-off'}${shadow ? ' rule-shadowed' : ''}${breakpoint ? ' rule-breakpoint' : ''}`}
    >
      <div className="rule-head">
        <span className="rule-order">#{index + 1}</span>
        <button
          type="button"
          className={`bp-toggle${breakpoint ? ' on' : ''}`}
          title={breakpoint ? '移除断点' : '在此规则上设置断点（仅当前页面会话保留）'}
          aria-pressed={breakpoint}
          onClick={onToggleBreakpoint}
        >
          {breakpoint ? '●' : '○'}
        </button>
        <input
          className="rule-name"
          placeholder="规则名称"
          {...textProps('name')}
        />
        {shadow && <span className="tag tag-shadow">不可达</span>}
        <label className="rule-enable">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          启用
        </label>
        <span className="rule-buttons">
          <button title="上移" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            title="下移"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button className="danger" title="删除规则" onClick={onRemove}>
            删除
          </button>
        </span>
      </div>

      <div className="rule-grid">
        <label>
          方法
          <select
            value={rule.method}
            onChange={(e) => set('method', e.target.value as Rule['method'])}
          >
            {METHOD_MATCHERS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          主机
          <input
            placeholder="example.com 或 *.example.com"
            spellCheck={false}
            {...textProps('host')}
          />
        </label>
        <label>
          路径模板
          <input
            placeholder="/users/:id（留空或 * 匹配任意）"
            spellCheck={false}
            {...textProps('pathTemplate')}
          />
        </label>
        <label>
          动作
          <select
            value={rule.action.type}
            onChange={(e) =>
              setAction({ type: e.target.value as Rule['action']['type'] })
            }
          >
            {(Object.keys(ACTION_LABEL) as Rule['action']['type'][]).map((t) => (
              <option key={t} value={t}>
                {ACTION_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {rule.action.type !== 'stop' && (
          <label className="span-2">
            目标（可引用 :参数）
            <input
              value={rule.action.target}
              placeholder="/new/path/:id 或 https://other.com/:id"
              spellCheck={false}
              onFocus={session.begin}
              onChange={(e) =>
                session.change({
                  ...rule,
                  action: { ...rule.action, target: e.target.value },
                })
              }
              onBlur={() => session.end(rule)}
            />
          </label>
        )}
        {rule.action.type === 'redirect' && (
          <label>
            状态码
            <select
              value={rule.action.status}
              onChange={(e) => setAction({ status: Number(e.target.value) })}
            >
              {REDIRECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="query-conds">
        <div className="query-conds-head">
          <span>
            查询参数条件（多条按「且」组合；为空则任意查询串均可命中）
          </span>
          <button onClick={addCond}>＋ 添加条件</button>
        </div>
        {rule.query.map((cond, ci) => (
          <div className="query-cond-row" key={ci}>
            <input
              placeholder="参数名"
              spellCheck={false}
              {...condTextProps(ci, 'name')}
            />
            <select
              value={cond.op}
              onChange={(e) => setCondOp(ci, e.target.value as QueryOperator)}
            >
              {QUERY_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {QUERY_OPERATOR_LABELS[op]}
                </option>
              ))}
            </select>
            {cond.op === 'equals' && (
              <input
                placeholder="比较值（同名参数任一值相等即命中）"
                spellCheck={false}
                {...condTextProps(ci, 'value')}
              />
            )}
            <button
              className="danger"
              title="删除该条件"
              onClick={() => removeCond(ci)}
            >
              删除
            </button>
          </div>
        ))}
        {dupNames.length > 0 && (
          <div className="banner error">
            查询条件存在重复参数名：{dupNames.map((n) => `「${n}」`).join('、')}
            。同一规则内参数名必须唯一，否则导入校验与导出路由器会拦截。
          </div>
        )}
      </div>

      {shadow && (
        <div className="shadow-detail">
          <div>
            ⚠️ 不可达：全部可匹配请求已被第 {shadow.byRuleIndex + 1} 条规则「
            {shadow.byRuleName}」完全覆盖，本条永远不会命中。
          </div>
          <ul className="shadow-basis">
            <li>
              方法 <code>{shadow.basis.method.upper}</code> ⊇{' '}
              <code>{shadow.basis.method.lower}</code>
            </li>
            <li>
              主机 <code>{shadow.basis.host.upper}</code> ⊇{' '}
              <code>{shadow.basis.host.lower}</code>
            </li>
            <li>
              路径 <code>{fmtPath(shadow.basis.path.upper)}</code> ⊇{' '}
              <code>{fmtPath(shadow.basis.path.lower)}</code>
            </li>
            <li>
              查询 <code>{formatQueryConditions(shadow.basis.query.upper)}</code> ⊇{' '}
              <code>{formatQueryConditions(shadow.basis.query.lower)}</code>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** 方法匹配器：ANY 或具体 HTTP 方法 */
export const METHOD_MATCHERS = [
  'ANY',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;
export type MethodMatcher = (typeof METHOD_MATCHERS)[number];

/** 模拟请求可选的具体方法（请求必须有确定方法，不能是 ANY） */
export const REQUEST_METHODS = METHOD_MATCHERS.filter((m) => m !== 'ANY');

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

/** 查询参数条件的操作符：存在 / 不存在 / 值等于 */
export const QUERY_OPERATORS = ['exists', 'not-exists', 'equals'] as const;
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

export const QUERY_OPERATOR_LABELS: Record<QueryOperator, string> = {
  exists: '存在',
  'not-exists': '不存在',
  equals: '值等于',
};

/** 一条查询参数条件：同一规则内的多条条件按 AND 组合 */
export interface QueryCondition {
  /** 查询参数名（区分大小写） */
  name: string;
  op: QueryOperator;
  /** 仅 equals 使用的比较值；同名参数任一值相等即命中 */
  value: string;
}

/** 单条查询条件的展示文本，如「存在 debug」「mode 等于 canary」 */
export function formatQueryCondition(cond: QueryCondition): string {
  switch (cond.op) {
    case 'exists':
      return `存在 ${cond.name}`;
    case 'not-exists':
      return `不存在 ${cond.name}`;
    case 'equals':
      return `${cond.name} 等于 ${cond.value}`;
  }
}

/** 查询条件列表的展示文本；空列表表示「任意查询串」 */
export function formatQueryConditions(conds: QueryCondition[]): string {
  if (conds.length === 0) return '（无条件，任意查询串）';
  return conds.map(formatQueryCondition).join(' 且 ');
}

export type ActionType = 'rewrite' | 'redirect' | 'stop';

export interface RuleAction {
  type: ActionType;
  /** 重写 / 重定向目标，可引用路径参数（如 /users/:id 或 https://a.com/:id）；stop 时忽略 */
  target: string;
  /** 重定向状态码，仅 redirect 使用 */
  status: number;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  method: MethodMatcher;
  /** 精确主机（example.com）或通配子域（*.example.com），* 匹配任意主机；忽略端口 */
  host: string;
  /** 路径模板：字面段与 :name 参数段；留空或 * 匹配任意路径 */
  pathTemplate: string;
  /** 查询参数条件：多条按 AND 组合；空数组表示任意查询串（旧数据缺省即为此） */
  query: QueryCondition[];
  action: RuleAction;
}

export interface MatchResult {
  rule: Rule;
  index: number;
  params: Record<string, string>;
}

export interface Step {
  n: number;
  method: string;
  /** 状态标识：`方法 + 序列化 URL`，用于循环检测 */
  stateKey: string;
  urlBefore: string;
  ruleIndex: number;
  /** 命中时的规则快照（规则之后被编辑也不影响这次轨迹的展示） */
  rule: Rule;
  params: Record<string, string>;
  /** rewrite：重写后的 URL */
  urlAfter?: string;
  /** redirect：Location 与状态码 */
  location?: string;
  status?: number;
}

export type SimulationStatus =
  | 'final' // 无更多规则命中，当前 URL 为最终结果
  | 'redirect' // 重定向终止
  | 'stopped' // 停止动作终止
  | 'loop' // 检测到循环（失败）
  | 'max-steps' // 超过最大步数（失败）
  | 'invalid-url' // 输入 URL 无法解析（失败）
  | 'invalid-target'; // 动作目标无法解析（失败）

export interface Simulation {
  status: SimulationStatus;
  /** 是否为成功的终止结果（循环 / 超限 / 非法输入为 false） */
  ok: boolean;
  steps: Step[];
  reason: string;
  finalUrl?: string;
  redirectLocation?: string;
  redirectStatus?: number;
}

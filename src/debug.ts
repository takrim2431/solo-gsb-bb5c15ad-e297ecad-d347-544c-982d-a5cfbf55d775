import { runSimulation } from './engine';
import type { Rule, Simulation, Step } from './types';

/** 暂停原因：命中断点 / 单步停在下一条命中规则前 */
export type PauseReason = 'breakpoint' | 'step';

/** 推进模式：run 只在断点前停；step 在下一条实际命中规则前停 */
type AdvanceMode = 'run' | 'step';

/**
 * 断点调试会话。
 *
 * 会话开始时对规则表、方法、URL 与断点集合做**快照**：
 * 之后单步 / 继续都跑在同一份快照与同一个 {@link runSimulation} 生成器上，
 * 循环检测的 seen 状态与 20 步上限随暂停保留，不会重置。
 * 外部规则或请求发生变化时，调用方通过 {@link contextKey} 比对并将会话判为过期。
 */
export class DebugSession {
  /** 会话开始时的规则快照（断点判定与执行都基于它，不受后续编辑影响） */
  readonly rules: Rule[];
  readonly method: string;
  readonly inputUrl: string;
  /** 会话开始时的断点规则 id 集合快照 */
  readonly breakpoints: ReadonlySet<string>;
  /** 会话上下文签名：规则表 + 方法 + URL，变化即表示会话过期 */
  readonly contextKey: string;

  private gen: Generator<Step, Simulation>;
  private _steps: Step[] = [];
  private _pending: Step | null = null;
  private _pauseReason: PauseReason | null = null;
  private _result: Simulation | null = null;
  /** 暂停发生在带断点规则前的次数 */
  private _breakpointHits = 0;

  constructor(
    rules: readonly Rule[],
    method: string,
    inputUrl: string,
    breakpoints: ReadonlySet<string>,
    contextKey: string,
  ) {
    this.rules = structuredClone(rules) as Rule[];
    this.method = method;
    this.inputUrl = inputUrl;
    this.breakpoints = new Set(breakpoints);
    this.contextKey = contextKey;
    this.gen = runSimulation(this.rules, this.method, this.inputUrl);
  }

  /** 已执行完动作的步骤（暂停时不含当前待执行步骤） */
  get steps(): readonly Step[] {
    return this._steps;
  }

  /** 当前暂停点：即将执行其动作的命中规则；会话结束后为 null */
  get pending(): Step | null {
    return this._pending;
  }

  get pauseReason(): PauseReason | null {
    return this._pauseReason;
  }

  /** 是否已运行到终止（final / redirect / stopped / loop / max-steps / 非法输入） */
  get finished(): boolean {
    return this._result !== null;
  }

  get result(): Simulation | null {
    return this._result;
  }

  get breakpointHits(): number {
    return this._breakpointHits;
  }

  private isBreakpoint(step: Step): boolean {
    return this.breakpoints.has(step.rule.id);
  }

  /**
   * 推进生成器：
   * - 从暂停恢复时，当前待执行步骤先转为已执行；
   * - run：执行动作并一路运行，直到下一条带断点的命中规则（动作执行前）或终止；
   * - step：执行当前动作后，停在下一条实际命中规则前（无断点也停）。
   */
  private advance(mode: AdvanceMode): void {
    if (this._result) return;

    if (this._pending) {
      this._steps = [...this._steps, this._pending];
      this._pending = null;
      this._pauseReason = null;
    }

    for (;;) {
      const cur = this.gen.next();
      if (cur.done) {
        this._result = cur.value;
        return;
      }
      const step = cur.value;
      if (this.isBreakpoint(step)) {
        this._breakpointHits++;
        this._pending = step;
        this._pauseReason = 'breakpoint';
        return;
      }
      if (mode === 'step') {
        this._pending = step;
        this._pauseReason = 'step';
        return;
      }
      // run 模式且该命中规则无断点：当场执行其动作，继续循环
      this._steps = [...this._steps, step];
    }
  }

  /**
   * 启动调试：从首条规则开始，在即将执行**首条带断点的命中规则**前暂停。
   * 若运行到终止都没有命中断点（或没有规则命中 / 输入非法），直接得到最终结果。
   */
  start(): void {
    if (this._steps.length > 0 || this._pending || this._result) return;
    this.advance('run');
  }

  /** 单步：执行当前暂停点动作后，暂停在下一条实际命中规则前；已终止则无操作 */
  step(): void {
    if (!this._pending || this._result) return;
    this.advance('step');
  }

  /** 继续：从当前暂停点运行到下一断点，或直到终止；已终止则无操作 */
  resume(): void {
    if (!this._pending || this._result) return;
    this.advance('run');
  }
}

/**
 * 计算调试会话上下文签名：规则表（内容 + 顺序 + 启停）+ 方法 + URL。
 * 任一变化都会得到不同签名，用于把进行中的暂停会话判为过期。
 */
export function debugContextKey(rules: readonly Rule[], method: string, url: string): string {
  return JSON.stringify({ m: method, u: url, r: rules });
}

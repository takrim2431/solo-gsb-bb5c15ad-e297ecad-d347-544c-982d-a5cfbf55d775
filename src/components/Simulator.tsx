import { useState } from 'react';
import { REQUEST_METHODS } from '../types';
import { PRESETS } from '../samples';

interface Props {
  method: string;
  url: string;
  onMethodChange: (m: string) => void;
  onUrlChange: (u: string) => void;
  onRun: () => void;
  onStartDebug: () => void;
  /** 当前设有断点的规则数（仅当前页面会话保留） */
  breakpointCount: number;
  /** 是否正处在断点调试会话中 */
  debugging: boolean;
}

export function Simulator({
  method,
  url,
  onMethodChange,
  onUrlChange,
  onRun,
  onStartDebug,
  breakpointCount,
  debugging,
}: Props) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && url.trim() === '';
  const submit = () => {
    setTouched(true);
    if (url.trim() !== '') onRun();
  };
  const startDebug = () => {
    setTouched(true);
    if (url.trim() !== '') onStartDebug();
  };

  return (
    <section className="panel">
      <h2>模拟请求</h2>
      <form
        className="sim-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <select value={method} onChange={(e) => onMethodChange(e.target.value)}>
          {REQUEST_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={invalid ? 'invalid' : ''}
          value={url}
          placeholder="http://api.example.com/v1/users/42"
          spellCheck={false}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        <button type="submit" className="primary">
          运行
        </button>
        <button
          type="button"
          onClick={startDebug}
          disabled={breakpointCount === 0}
          title={
            breakpointCount === 0
              ? '先在规则卡片上用 ○ 设置至少一个断点'
              : '在首条带断点的命中规则前暂停'
          }
        >
          {debugging ? '重新开始调试' : '开始调试'}
        </button>
      </form>
      {invalid && <div className="banner error">请输入待模拟的 URL</div>}
      <div className="debug-hint">
        {breakpointCount === 0
          ? '点击规则卡片左侧的 ○ 设置断点（仅本页面会话保留），即可开始断点调试。'
          : `已设 ${breakpointCount} 个断点：开始调试后在首条带断点的命中规则前暂停，可用「单步 / 继续」推进。`}
      </div>
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="chip"
            title={p.url}
            onClick={() => {
              onMethodChange(p.method);
              onUrlChange(p.url);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

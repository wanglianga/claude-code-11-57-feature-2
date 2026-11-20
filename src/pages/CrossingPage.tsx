import { useEffect, useMemo, useState } from 'react';
import {
  getAllCrossingAnalyses,
  getAllReservoirs,
  getAllRuleCurves,
  getAllRuns,
  getSeriesForRun,
  getSnapshot,
  putRuleCurve,
  saveCrossingAnalysis,
} from '../db';
import { useAppState } from '../appState';
import {
  adviseCrossingMode,
  analyzeScenario,
  bindingDrift,
  buildObservedSeries,
  candidateRuleCurves,
  compareScenarios,
  freezeAnalysisRecord,
  medianIntervalSeconds,
  sortedCurvePoints,
  WARNING_LEVEL_LABEL,
  type ModeAdvice,
} from '../lib/crossings';
import { nowISO } from '../lib/time';
import { formatHuman } from '../lib/time';
import { ApprovalPill } from '../components/Pills';
import type {
  BalanceRun,
  CrossingAnalysisRecord,
  CrossingMode,
  ObservedSeries,
  Reservoir,
  RuleCurve,
  RuleMetric,
  RunSnapshot,
} from '../types';

const MODE_LABEL: Record<CrossingMode, string> = {
  interpolated: '连续插值（点时刻）',
  grid: '观测格判定（时间区间）',
};

const ATTRIBUTION_LABEL: Record<string, string> = {
  threshold_definition: '阈值定义',
  fact_change: '事实变化',
  mixed: '事实与阈值共同',
  no_difference: '无差异',
  indeterminate: '无法归因',
};

const STATUS_LABEL: Record<CrossingAnalysisRecord['status'], { cls: string; text: string }> = {
  ok: { cls: 'ok', text: '已发布' },
  needs_confirmation: { cls: 'warn', text: '需确认' },
  draft_bound: { cls: 'pending', text: '绑定草案（演练）' },
  blocked: { cls: 'danger', text: '不可求解' },
};

function short(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(5, 16).replace('T', ' ');
}
function fmtDuration(sec: number): string {
  if (sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 || (h === 0 && m === 0) ? `${s}s` : ''].filter(Boolean).join('');
}

export default function CrossingPage() {
  const { dataVersion, bumpData } = useAppState();
  const [runs, setRuns] = useState<BalanceRun[]>([]);
  const [ruleCurves, setRuleCurves] = useState<RuleCurve[]>([]);
  const [reservoirs, setReservoirs] = useState<Reservoir[]>([]);
  const [analyses, setAnalyses] = useState<CrossingAnalysisRecord[]>([]);

  const [runId, setRunId] = useState('');
  const [currentRun, setCurrentRun] = useState<BalanceRun | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [runSeries, setRunSeries] = useState<ObservedSeries[]>([]);
  const [reservoirId, setReservoirId] = useState('qx');
  const [metric, setMetric] = useState<RuleMetric>('water_level');
  const [sourceKind, setSourceKind] = useState<'water_level' | 'inflow' | 'outflow'>('water_level');
  const [variant, setVariant] = useState<'base' | 'strict'>('base');
  const [ruleAId, setRuleAId] = useState('');
  const [ruleBId, setRuleBId] = useState('');
  const [modeA, setModeA] = useState<CrossingMode>('interpolated');
  const [modeB, setModeB] = useState<CrossingMode>('grid');
  const [bVariant, setBVariant] = useState<'same' | 'base' | 'strict'>('same');
  const [margin, setMargin] = useState(0.1);
  const [useScenarioB, setUseScenarioB] = useState(true);
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);

  const refresh = async () => {
    const [rs, rcs, res, an] = await Promise.all([
      getAllRuns(), getAllRuleCurves(), getAllReservoirs(), getAllCrossingAnalyses(),
    ]);
    const usable = rs.filter((r) => r.status !== 'running' && r.status !== 'failed');
    setRuns(usable.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setRuleCurves(rcs);
    setReservoirs(res);
    setAnalyses(an.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    if (!runId && usable.length > 0) setRunId(usable[0].id);
  };
  useEffect(() => { void refresh(); /* dataVersion */ }, [dataVersion]);

  useEffect(() => {
    if (!runId) { setSnapshot(null); setRunSeries([]); setCurrentRun(null); return; }
    let cancelled = false;
    void (async () => {
      const [snap, series, allRuns] = await Promise.all([getSnapshot(runId), getSeriesForRun(runId), getAllRuns()]);
      if (cancelled) return;
      setSnapshot(snap ?? null);
      setRunSeries(series);
      setCurrentRun(allRuns.find((r) => r.id === runId) ?? null);
    })();
    return () => { cancelled = true; };
  }, [runId]);

  useEffect(() => {
    const first = snapshot?.reservoirs[0];
    if (first && !snapshot?.reservoirs.some((r) => r.id === reservoirId)) setReservoirId(first.id);
  }, [snapshot, reservoirId]);

  const reservoir = reservoirs.find((r) => r.id === reservoirId) ?? snapshot?.reservoirs.find((r) => r.id === reservoirId);

  const series = useMemo<ObservedSeries | null>(() => {
    const existing = runSeries.find(
      (s) => s.reservoirId === reservoirId && s.sourceKind === sourceKind && s.variant === variant,
    );
    if (existing) return existing;
    if (!snapshot || !reservoir) return null;
    return buildObservedSeries({
      readings: snapshot.readings,
      reservoirId,
      metric,
      sourceKind,
      nominalStepSeconds: currentRun?.gridStepSeconds ?? 3600,
      variant,
      runId: snapshot.runId,
    });
  }, [runSeries, reservoirId, sourceKind, variant, snapshot, reservoir, metric, currentRun]);

  const seriesB = useMemo<ObservedSeries | null>(() => {
    if (bVariant === 'same') return series;
    const existing = runSeries.find(
      (s) => s.reservoirId === reservoirId && s.sourceKind === sourceKind && s.variant === bVariant,
    );
    if (existing) return existing;
    if (!snapshot || !reservoir) return null;
    return buildObservedSeries({
      readings: snapshot.readings,
      reservoirId,
      metric,
      sourceKind,
      nominalStepSeconds: currentRun?.gridStepSeconds ?? 3600,
      variant: bVariant,
      runId: snapshot.runId,
    });
  }, [bVariant, series, runSeries, reservoirId, sourceKind, snapshot, reservoir, metric, currentRun]);

  // 新比较按“当前规则目录”给出候选：审批撤回后状态即可见，新比较须另绑新版本；
  // 已发布记录则保留冻结引用（见下方漂移检查）。
  const candidates = useMemo(() => {
    if (!reservoir) return [];
    return candidateRuleCurves(ruleCurves, {
      basinId: reservoir.basinId,
      reservoirId: reservoir.id,
      metric,
      window: series && series.points.length > 1 ? [series.points[0].t, series.points[series.points.length - 1].t] : undefined,
    });
  }, [ruleCurves, reservoir, metric, series]);

  const selectableRules = candidates.flatMap((g) => [...g.approved, ...g.drafts, ...g.retired]);
  const ruleA = selectableRules.find((r) => r.id === ruleAId) ?? null;
  const ruleB = selectableRules.find((r) => r.id === ruleBId) ?? null;

  const advice: ModeAdvice | null = series && series.points.length >= 2
    ? adviseCrossingMode(series, ruleA ? [ruleA] : selectableRules)
    : null;

  const singleResult = useMemo(() => {
    if (!series || !ruleA) return null;
    return analyzeScenario(
      { label: '情景 A', mode: modeA, series, rules: [ruleA] },
      { margin },
    );
  }, [series, ruleA, modeA, margin]);

  const comparisonResult = useMemo(() => {
    if (!series || !ruleA || !ruleB || !seriesB) return null;
    const bObservation = bVariant === 'same' ? '' : `/${bVariant}`;
    return compareScenarios({
      a: { spec: { label: '情景 A', mode: modeA, series, rules: [ruleA] }, series, rules: [ruleA] },
      b: { spec: { label: `情景 B（${ruleB.version}${bObservation}）`, mode: modeB, series: seriesB, rules: [ruleB] }, series: seriesB, rules: [ruleB] },
      margin,
    });
  }, [series, seriesB, ruleA, ruleB, modeA, modeB, bVariant, margin]);

  const publish = async () => {
    if (!series || !ruleA || !singleResult) return;
    const record = freezeAnalysisRecord({
      runId: snapshot?.runId,
      reservoirId,
      basinId: reservoir?.basinId,
      series,
      rules: [ruleA],
      mode: modeA,
      events: singleResult.events,
      issues: singleResult.issues,
      comparison: useScenarioB && comparisonResult ? comparisonResult.comparison : undefined,
      note: `阈值裕度 ±${margin}${ruleA.unit}`,
      now: nowISO(),
    });
    await saveCrossingAnalysis(record);
    setMsg({ cls: 'ok', text: `已发布越线分析 ${record.id}：冻结观测 ${series.points.length} 点、规则 ${ruleA.version}（${ruleA.approvalStatus}）。` });
    bumpData();
    void refresh();
  };

  // 演示：模拟审批撤回，验证已发布记录仍保留当时引用
  const simulateRetire = async () => {
    const target = ruleCurves.find((r) => r.id === ruleAId);
    if (!target) {
      setMsg({ cls: 'warn', text: '请先在情景 A 绑定一条规则，再模拟审批撤回。' });
      return;
    }
    if (target.approvalStatus === 'retired') {
      setMsg({ cls: 'info', text: `${target.version} 已是停用状态。` });
      return;
    }
    await putRuleCurve({
      ...target,
      approvalStatus: 'retired',
      retiredAt: nowISO(),
      note: `${target.note ?? ''}（演示：审批撤回，目录内状态变更，已发布记录不动）`,
    });
    setMsg({ cls: 'info', text: `已撤回 ${target.version} 的审批（retired）。已发布分析记录仍保留冻结时的 approved 引用。` });
    bumpData();
    void refresh();
  };

  // 演示：模拟并发草案在目录内被修改，验证已发布记录仍保留当时引用
  const simulateDraftRevision = async () => {
    const target = ruleCurves.find((r) => r.id === ruleAId && r.approvalStatus === 'draft')
      ?? ruleCurves.find((r) => r.approvalStatus === 'draft');
    if (!target) {
      setMsg({ cls: 'warn', text: '目录中没有草稿规则可模拟；请选择并发草案 A/B 作为情景 A 的绑定规则。' });
      return;
    }
    const edited: RuleCurve = {
      ...target,
      curvePoints: sortedCurvePoints(target).map((p) => ({ ...p, threshold: p.threshold + 0.3 })),
      note: `${target.note ?? ''}（演示：草案并发修改 +0.3，仅在目录内改动，已发布记录不动）`,
    };
    await putRuleCurve(edited);
    setMsg({ cls: 'info', text: `已修改草稿 ${target.version} 的曲线点（+0.3），已发布分析记录仍保留冻结引用。` });
    bumpData();
    void refresh();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>规则曲线穿越与敏感区间</h1>
          <div className="sub">
            调度员关心的是某段水位/流量何时穿越哪条规则线。选择运行保存的连续序列，显式绑定一条规则曲线，
            对比两种判定语义与两套规则，区分差异来自事实变化还是阈值定义。
          </div>
        </div>
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ maxWidth: 380 }}>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.id}</option>)}
          {runs.length === 0 && <option value="">暂无可用运行</option>}
        </select>
      </div>

      {msg && <div className={`banner ${msg.cls}`}>{msg.text}</div>}
      {runs.length === 0 && (
        <div className="banner info">尚无可用运行。越线分析读取“指标运行保存的连续水位/流量序列”，请先到「平衡运行台」完成一次运行。</div>
      )}

      {snapshot && (
        <div className="card">
          <h2>1. 选择指标运行与序列</h2>
          <div className="form-row three">
            <label className="field">水库
              <select value={reservoirId} onChange={(e) => setReservoirId(e.target.value)}>
                {snapshot.reservoirs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field">指标
              <select
                value={sourceKind}
                onChange={(e) => {
                  const v = e.target.value as 'water_level' | 'inflow' | 'outflow';
                  setSourceKind(v);
                  setMetric(v === 'water_level' ? 'water_level' : 'flow');
                  setRuleAId(''); setRuleBId('');
                }}
              >
                <option value="water_level">水位（水位数序列）</option>
                <option value="inflow">入库流量</option>
                <option value="outflow">出库流量</option>
              </select>
            </label>
            <label className="field">观测变体
              <select value={variant} onChange={(e) => setVariant(e.target.value as 'base' | 'strict')}>
                <option value="base">base（含可疑/估算）</option>
                <option value="strict">strict（剔除可疑/估算）</option>
              </select>
            </label>
            <label className="field">接近阈值裕度（±{metric === 'water_level' ? 'm' : 'm³/s'}）
              <input type="number" step="0.05" min="0" value={margin} onChange={(e) => setMargin(Math.max(0, Number(e.target.value)))} />
            </label>
          </div>
          {series ? (
            <div className="small">
              连续序列 <span className="mono">{series.points.length}</span> 点（{formatHuman(series.points[0]?.t)} ~ {formatHuman(series.points[series.points.length - 1]?.t)}），
              中位采样间隔 <b>{Math.round(medianIntervalSeconds(series))}s</b>，名义步长 {series.nominalStepSeconds}s；
              闸门操作/指令 {series.gateOps.length} 条；可疑/估算 {series.suspectCount} 条（已剔除 {series.excludedCount} 条）。
              {series.points.length < 2 && <span className="pill danger" style={{ marginLeft: 8 }}>序列不足 2 点</span>}
              {series.points.length >= 2 && currentRun?.gridStepSeconds && medianIntervalSeconds(series) > currentRun.gridStepSeconds * 1.5 && (
                <span className="pill warn" style={{ marginLeft: 8 }}>低频观测（相对运行网格步长 {currentRun.gridStepSeconds}s）</span>
              )}
            </div>
          ) : <div className="muted small">该水库/指标在本运行无可用序列</div>}
          {advice && (
            <div className="banner info mt8">
              <strong>模式选择依据：</strong>建议 <b>{MODE_LABEL[advice.mode]}</b> —— {advice.reason}。
              观测密度、规则曲线连续性与指令是否依赖精确时刻共同决定；本页不预设连续插值更正确。
              <button className="small" style={{ marginLeft: 10 }} onClick={() => setModeA(advice.mode)}>情景A采用建议模式</button>
            </div>
          )}
        </div>
      )}

      {series && (
        <div className="card">
          <h2>2. 规则曲线候选（按等级分组，不为重叠自动选取）</h2>
          <div className="muted small" style={{ marginBottom: 8 }}>
            候选来源：当前规则目录（含冻结时为已审批、现已撤回的版本，会标注其当前状态）。发布记录另存冻结引用：
            撤回/改点不回改已发布结论，新比较须另绑版本。
          </div>
          {candidates.length === 0 && <div className="banner warn">当前水库/指标没有匹配的预警规则曲线。可到「曲线与规则目录 → 预警规则曲线」登记。</div>}
          {candidates.map((g) => (
            <div key={g.warningLevel} className="card" style={{ marginBottom: 10, boxShadow: 'none' }}>
              <h3 style={{ marginTop: 0 }}>
                {WARNING_LEVEL_LABEL[g.warningLevel]}等级
                {g.overlapApproved && <span className="pill warn" style={{ marginLeft: 8 }}>已审批规则适用期重叠：不自动选取</span>}
                {g.drafts.length > 1 && <span className="pill pending" style={{ marginLeft: 8 }}>{g.drafts.length} 个并发草案，须分别绑定</span>}
              </h3>
              <div className="small" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {g.approved.map((r) => (
                  <button
                    key={r.id}
                    className={`small ${ruleAId === r.id ? 'primary' : ''}`}
                    onClick={() => setRuleAId(ruleAId === r.id ? '' : r.id)}
                  >
                    绑定A：{r.version}
                  </button>
                ))}
                {g.drafts.map((r) => (
                  <button
                    key={r.id}
                    className={`small ${ruleAId === r.id ? 'primary' : ''}`}
                    onClick={() => setRuleAId(ruleAId === r.id ? '' : r.id)}
                  >
                    绑定A（草案）：{r.version}
                  </button>
                ))}
                {g.retired.map((r) => (
                  <button
                    key={r.id}
                    className={`small ${ruleAId === r.id ? 'primary' : ''}`}
                    onClick={() => setRuleAId(ruleAId === r.id ? '' : r.id)}
                  >
                    绑定A（已停用）：{r.version}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {selectableRules.length > 0 && (
            <div className="small">
              <div className="mt8">
                {selectableRules.map((r) => (
                  <label key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 14 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={ruleBId === r.id}
                      onChange={() => setRuleBId(ruleBId === r.id ? '' : r.id)}
                    />
                    情景B：{r.version} <ApprovalPill status={r.approvalStatus} />
                  </label>
                ))}
              </div>
              <div className="mt8">
                情景A 已绑定：<b>{ruleA ? `${ruleA.version}（${WARNING_LEVEL_LABEL[ruleA.warningLevel]}）` : '未选'}</b>；
                情景B 已绑定：<b>{ruleB ? `${ruleB.version}（${WARNING_LEVEL_LABEL[ruleB.warningLevel]}）` : '未选'}</b>
              </div>
              {ruleA && (
                <div className="muted mt8">
                  规则A曲线点：{sortedCurvePoints(ruleA).map((p) => `${short(p.t)}→${p.threshold}${ruleA.unit}`).join('；')}
                  {ruleA.downstreamSafeFlow ? `；下游安全流量 [${ruleA.downstreamSafeFlow.join(', ')}] m³/s` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {series && (
        <div className="card">
          <h2>3. 判定模式</h2>
          <div className="form-row">
            <label className="field">情景 A 模式
              <select value={modeA} onChange={(e) => setModeA(e.target.value as CrossingMode)}>
                <option value="interpolated">连续插值（相邻观测间求交点，给出点时刻）</option>
                <option value="grid">观测格判定（给出时间区间）</option>
              </select>
            </label>
            <label className="field">情景 B 模式
              <select value={modeB} onChange={(e) => setModeB(e.target.value as CrossingMode)}>
                <option value="interpolated">连续插值（相邻观测间求交点，给出点时刻）</option>
                <option value="grid">观测格判定（给出时间区间）</option>
              </select>
            </label>
            <label className="field">情景 B 观测变体
              <select value={bVariant} onChange={(e) => setBVariant(e.target.value as 'same' | 'base' | 'strict')}>
                <option value="same">与情景 A 相同（只比较规则/模式）</option>
                <option value="base">base（含可疑/估算）</option>
                <option value="strict">strict（剔除可疑/估算）</option>
              </select>
            </label>
          </div>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={useScenarioB} onChange={(e) => setUseScenarioB(e.target.checked)} />
            发布时附带情景B比较（需先绑定情景B规则）
          </label>
          <div className="muted small mt8">
            归因规则：同一模式、同一观测、仅规则不同 → 阈值定义；同一规则、仅观测不同 → 事实变化；两者都不同 → 用反事实替换拆分（可能为 mixed）。
            模式不同（interpolated vs grid）时语义不可相减，不做事实/阈值归因。
          </div>
        </div>
      )}

      {singleResult && series && ruleA && (
        <CrossingResultCard
          title={`情景 A · ${ruleA.version}（${WARNING_LEVEL_LABEL[ruleA.warningLevel]}） · ${MODE_LABEL[modeA]}`}
          analysis={singleResult}
          unit={ruleA.unit}
          margin={margin}
        />
      )}

      {singleResult && series && ruleA && (
        <div className="card">
          <h2>规则触发范围摘要（每条规则一行）</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>规则</th><th>等级</th><th>语义</th><th>首次越线</th><th className="num">确认时长</th><th className="num">时长上限</th><th className="num">峰值幅度</th><th>下游安全流量</th><th>越线成因</th></tr>
              </thead>
              <tbody>
                {singleResult.events.map((e) => (
                  <tr key={e.ruleId}>
                    <td className="mono small">{e.ruleVersion}</td>
                    <td>{WARNING_LEVEL_LABEL[e.warningLevel]}</td>
                    <td>{e.curveSemantics === 'linear' ? '线性' : '阶梯'}</td>
                    <td className="mono small">
                      {e.firstCrossing?.at ? short(e.firstCrossing.at) : e.firstCrossing?.interval ? `[${short(e.firstCrossing.interval[0])}, ${short(e.firstCrossing.interval[1])}]` : (e.alreadyAboveAtStart ? '起点已在线以上' : '未越线')}
                    </td>
                    <td className="num">{fmtDuration(e.durationConfirmedSeconds)}</td>
                    <td className="num">{fmtDuration(e.durationPossibleSeconds)}</td>
                    <td className="num">{e.peakExceedance === null ? '—' : e.peakExceedance.toFixed(3)}</td>
                    <td className="small">{e.downstreamSafeFlow ? `[${e.downstreamSafeFlow.join(', ')}]` : '—'}</td>
                    <td className="small">{e.firstCrossing ? (e.firstCrossing.inducedBy === 'observation' ? '观测变化' : e.firstCrossing.inducedBy === 'threshold_step' ? '阈值阶跃' : '阈值趋势') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {useScenarioB && comparisonResult && ruleA && ruleB && series && (
        <ComparisonCard
          comparison={comparisonResult.comparison}
          aAnalysis={comparisonResult.a}
          bAnalysis={comparisonResult.b}
        />
      )}

      {series && ruleA && (
        <div className="card">
          <h2>4. 发布分析记录</h2>
          <div className="small muted" style={{ marginBottom: 8 }}>
            发布时冻结观测序列与规则引用（深拷贝）。此后规则审批撤回、草案被修改或规则版本变更，已发布记录仍保留当时版本与审批状态；
            新建比较需另建版本/重新绑定。
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => void publish()}>发布冻结分析记录</button>
            <button onClick={() => void simulateRetire()}>模拟：撤回情景A规则的审批</button>
            <button onClick={() => void simulateDraftRevision()}>模拟：并发草案被修改（目录内 +0.3）</button>
          </div>
        </div>
      )}

      <SavedAnalyses
        analyses={analyses}
        ruleCurves={ruleCurves}
        runId={snapshot?.runId}
        onDeleted={() => { bumpData(); void refresh(); }}
      />
    </div>
  );
}

export function CrossingResultCard({
  title, analysis, unit, margin,
}: {
  title: string;
  analysis: ReturnType<typeof analyzeScenario>;
  unit: string;
  margin: number;
}) {
  const m = analysis.metrics;
  const ev = analysis.events[0];
  return (
    <div className="card">
      <h2>{title}</h2>
      {analysis.issues.length > 0 && (
        <ul className="reason-list">{analysis.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>
      )}
      {ev && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 10 }}>
            <div className="kpi"><div className="label">首次越线</div>
              <div className="value" style={{ fontSize: 16 }}>
                {m.firstCrossingAt ? short(m.firstCrossingAt) : m.firstCrossingInterval ? `[${short(m.firstCrossingInterval[0])}, ${short(m.firstCrossingInterval[1])}]` : (ev.alreadyAboveAtStart ? '起点已在线以上' : '未越线')}
              </div>
              <div className="sub">{ev.firstCrossing?.precision.note ?? '—'}</div>
            </div>
            <div className="kpi"><div className="label">高于阈值持续时长</div>
              <div className="value" style={{ fontSize: 16 }}>{fmtDuration(m.durationConfirmedSeconds)}</div>
              <div className="sub">{m.mode === 'grid' ? `上限（含跨界格）${fmtDuration(m.durationPossibleSeconds)}` : '按插值估计'}</div>
            </div>
            <div className="kpi"><div className="label">峰值越线幅度</div>
              <div className="value" style={{ fontSize: 16 }}>{m.peakExceedance === null ? '—' : `${m.peakExceedance.toFixed(3)} ${unit}`}</div>
              <div className="sub">{ev.peakAt ? short(ev.peakAt) : '—'}</div>
            </div>
            <div className="kpi"><div className="label">下游安全流量</div>
              <div className="value" style={{ fontSize: 16 }}>{m.downstreamSafeFlow ? `[${m.downstreamSafeFlow.join(', ')}]` : '—'}</div>
              <div className="sub">m³/s（随等级/规则版本变化）</div>
            </div>
          </div>

          {ev.firstCrossing && (
            <div className="small">
              穿越判定由 <b>{ev.firstCrossing.inducedBy === 'observation' ? '观测变化' : ev.firstCrossing.inducedBy === 'threshold_step' ? '规则阈值阶跃' : '规则阈值连续变化'}</b> 造成；
              前证据 {short(ev.firstCrossing.prev.t)} 观测 {ev.firstCrossing.prev.value} / 阈值 {ev.firstCrossing.prev.threshold.toFixed(3)}{unit}；
              后证据 {short(ev.firstCrossing.next.t)} 观测 {ev.firstCrossing.next.value} / 阈值 {ev.firstCrossing.next.threshold.toFixed(3)}{unit}。
              {m.mode === 'interpolated' && ` 时间精度：点时刻（名义 ±${Math.round(ev.firstCrossing.precision.seconds / 2)}s）。`}
            </div>
          )}

          <h3>规则阈值阶跃（阶梯曲线）</h3>
          {ev.thresholdStepEvents.length === 0 ? <div className="muted small">本窗口无阈值阶跃</div> : (
            <table>
              <thead><tr><th>时刻</th><th className="num">阈值 from</th><th className="num">阈值 to</th><th className="num">观测值</th><th>效果</th></tr></thead>
              <tbody>
                {ev.thresholdStepEvents.map((s, i) => (
                  <tr key={i}>
                    <td className="mono small">{short(s.at)}</td>
                    <td className="num">{s.fromThreshold}</td>
                    <td className="num">{s.toThreshold}</td>
                    <td className="num">{s.value}</td>
                    <td>{s.effect === 'none' ? '—' : s.effect === 'flip_below_to_above' ? <span className="pill danger">阶跃致越线</span> : <span className="pill neutral">回落线下</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>接近阈值的时间带（裕度 ±{margin}{unit}）</h3>
          {ev.bands.length === 0 ? <div className="muted small">窗口内无接近阈值的时段</div> : (
            <table>
              <thead><tr><th>起始</th><th>结束</th><th className="num">最小间距</th><th>位置</th></tr></thead>
              <tbody>
                {ev.bands.map((b, i) => (
                  <tr key={i}>
                    <td className="mono small">{short(b.start)}</td>
                    <td className="mono small">{short(b.end)}</td>
                    <td className="num">{b.minGap.toFixed(3)}</td>
                    <td>{b.side === 'straddles' ? '跨线' : b.side === 'below' ? '线下方' : '线上方'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>插值可信性 / 模式声明</h3>
          <ul className="reason-list" style={{ color: 'var(--muted)' }}>
            {ev.caveats.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

export function ComparisonCard({
  comparison, aAnalysis, bAnalysis,
}: {
  comparison: NonNullable<ReturnType<typeof compareScenarios>['comparison']>;
  aAnalysis: ReturnType<typeof analyzeScenario>;
  bAnalysis: ReturnType<typeof analyzeScenario>;
}) {
  const delta = comparison.deltas;
  return (
    <div className="card">
      <h2>情景差异与归因</h2>
      <div className="banner info">
        <strong>归因：{ATTRIBUTION_LABEL[comparison.attribution] ?? comparison.attribution}</strong> —— {comparison.explanation}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>指标</th><th>情景 A（{comparison.aLabel}）</th><th>情景 B（{comparison.bLabel}）</th><th className="num">B − A</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>首次越线</td>
              <td className="mono small">{comparison.a.firstCrossingAt ? short(comparison.a.firstCrossingAt) : comparison.a.firstCrossingInterval ? `[${short(comparison.a.firstCrossingInterval[0])}, ${short(comparison.a.firstCrossingInterval[1])}]` : '—'}</td>
              <td className="mono small">{comparison.b.firstCrossingAt ? short(comparison.b.firstCrossingAt) : comparison.b.firstCrossingInterval ? `[${short(comparison.b.firstCrossingInterval[0])}, ${short(comparison.b.firstCrossingInterval[1])}]` : '—'}</td>
              <td className="num">{delta.firstCrossingSeconds === null ? (comparison.comparable ? '—' : '不可比') : `${delta.firstCrossingSeconds}s`}</td>
            </tr>
            <tr>
              <td>确认越线时长</td>
              <td className="num">{fmtDuration(comparison.a.durationConfirmedSeconds)}</td>
              <td className="num">{fmtDuration(comparison.b.durationConfirmedSeconds)}</td>
              <td className="num">{comparison.comparable ? fmtDuration(delta.durationConfirmedSeconds) : '不可比'}</td>
            </tr>
            <tr>
              <td>时长上限</td>
              <td className="num">{fmtDuration(comparison.a.durationPossibleSeconds)}</td>
              <td className="num">{fmtDuration(comparison.b.durationPossibleSeconds)}</td>
              <td className="num">{comparison.comparable ? fmtDuration(delta.durationPossibleSeconds) : '不可比'}</td>
            </tr>
            <tr>
              <td>峰值越线幅度</td>
              <td className="num">{comparison.a.peakExceedance === null ? '—' : comparison.a.peakExceedance.toFixed(3)}</td>
              <td className="num">{comparison.b.peakExceedance === null ? '—' : comparison.b.peakExceedance.toFixed(3)}</td>
              <td className="num">{delta.peakExceedance === null ? '—' : delta.peakExceedance.toFixed(3)}</td>
            </tr>
            <tr>
              <td>下游安全流量</td>
              <td className="num">{comparison.a.downstreamSafeFlow ? `[${comparison.a.downstreamSafeFlow.join(', ')}]` : '—'}</td>
              <td className="num">{comparison.b.downstreamSafeFlow ? `[${comparison.b.downstreamSafeFlow.join(', ')}]` : '—'}</td>
              <td className="num">{delta.downstreamSafeMin === null ? '—' : `[${delta.downstreamSafeMin}, ${delta.downstreamSafeMax}]`}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3>反事实核对（解释差异来源，不能单独当作发布结论）</h3>
      {comparison.comparable ? (
        <div className="small">
          <div>· B 的观测套用 A 的规则：{comparison.counterfactual.fact ? summarizeMetrics(comparison.counterfactual.fact) : '不可用'}</div>
          <div>· A 的观测套用 B 的规则：{comparison.counterfactual.rule ? summarizeMetrics(comparison.counterfactual.rule) : '不可用'}</div>
        </div>
      ) : (
        <div className="muted small">两情景模式不同，一致性与归因不可直接计算；请统一模式后再做归因，或仅比较各自的精度声明。</div>
      )}
      {!comparison.comparable && (
        <div className="small mt8">
          A 精度：{aAnalysis.events[0]?.firstCrossing?.precision.note ?? '—'}<br />
          B 精度：{bAnalysis.events[0]?.firstCrossing?.precision.note ?? '—'}
        </div>
      )}
    </div>
  );
}

function summarizeMetrics(m: NonNullable<ReturnType<typeof compareScenarios>['comparison']['counterfactual']['fact']>): string {
  const at = m.firstCrossingAt ? short(m.firstCrossingAt) : m.firstCrossingInterval ? `[${short(m.firstCrossingInterval[0])}, ${short(m.firstCrossingInterval[1])}]` : '未越线';
  return `首次 ${at}；时长 ${fmtDuration(m.durationConfirmedSeconds)}；峰值 ${m.peakExceedance === null ? '—' : m.peakExceedance.toFixed(3)}；安全流量 ${m.downstreamSafeFlow ? `[${m.downstreamSafeFlow.join(', ')}]` : '—'}`;
}

function SavedAnalyses({
  analyses, ruleCurves, runId, onDeleted,
}: {
  analyses: CrossingAnalysisRecord[];
  ruleCurves: RuleCurve[];
  runId?: string;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState('');
  return (
    <div className="card">
      <h2>已发布越线分析记录（{analyses.length}）</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>记录</th><th>运行</th><th>水库</th><th>模式</th><th>绑定规则（冻结）</th><th>状态</th><th>创建</th><th>操作</th></tr>
          </thead>
          <tbody>
            {analyses.map((a) => {
              const drift = bindingDrift(a, ruleCurves);
              const status = STATUS_LABEL[a.status];
              return (
                <tr key={a.id}>
                  <td className="mono small">{a.id}</td>
                  <td className="mono small">{a.runId ?? '—'}</td>
                  <td>{a.reservoirId}</td>
                  <td>{MODE_LABEL[a.mode]}</td>
                  <td className="small">
                    {a.ruleBindings.map((r) => (
                      <div key={r.id}>
                        {r.version} <ApprovalPill status={r.approvalStatus} />
                        {r.retiredAt ? <span className="muted">（冻结时撤回于 {formatHuman(r.retiredAt)}）</span> : ''}
                      </div>
                    ))}
                    {drift.length > 0 && <div className="pill warn" style={{ marginTop: 4 }}>规则已变更：{drift.length} 项</div>}
                  </td>
                  <td><span className={`pill ${status.cls}`}>{status.text}</span></td>
                  <td className="mono small">{short(a.createdAt)}</td>
                  <td>
                    <button className="small" onClick={() => setExpanded(expanded === a.id ? '' : a.id)}>
                      {expanded === a.id ? '收起' : '查看冻结详情'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {analyses.length === 0 && <tr><td colSpan={8} className="muted">尚未发布分析记录</td></tr>}
          </tbody>
        </table>
      </div>
      {expanded && (() => {
        const a = analyses.find((x) => x.id === expanded);
        if (!a) return null;
        const drift = bindingDrift(a, ruleCurves);
        return (
          <div className="card" style={{ marginTop: 12, boxShadow: 'none' }}>
            <h3 style={{ marginTop: 0 }}>冻结详情 · {a.id} {runId && a.runId !== runId ? <span className="pill neutral">非当前运行</span> : null}</h3>
            <div className="small">
              冻结观测：{a.seriesSnapshot.points.length} 点（{a.seriesSnapshot.sourceKind} / {a.seriesSnapshot.variant}，中位步长 {Math.round(medianIntervalSeconds(a.seriesSnapshot))}s）；<br />
              冻结规则：
              {a.ruleBindings.map((r) => (
                <div key={r.id} className="mono small">
                  · {r.version} [{WARNING_LEVEL_LABEL[r.warningLevel]}] {r.curveSemantics} {sortedCurvePoints(r).map((p) => `${short(p.t)}→${p.threshold}`).join(' / ')}
                  {r.downstreamSafeFlow ? ` · 下游安全流量 [${r.downstreamSafeFlow.join(', ')}]` : ''}
                </div>
              ))}
              {drift.length > 0 && (
                <ul className="reason-list">{drift.map((d, i) => <li key={i}>{d}</li>)}</ul>
              )}
            </div>
            <h3>每条规则的越线结论</h3>
            <table>
              <thead><tr><th>规则</th><th>等级</th><th>首次越线</th><th className="num">确认时长</th><th className="num">峰值</th><th>下游安全流量</th></tr></thead>
              <tbody>
                {a.events.map((e) => (
                  <tr key={e.ruleId}>
                    <td className="mono small">{e.ruleVersion}</td>
                    <td>{WARNING_LEVEL_LABEL[e.warningLevel]}</td>
                    <td className="mono small">{e.firstCrossing?.at ? short(e.firstCrossing.at) : e.firstCrossing?.interval ? `[${short(e.firstCrossing.interval[0])}, ${short(e.firstCrossing.interval[1])}]` : (e.alreadyAboveAtStart ? '起点已在线以上' : '未越线')}</td>
                    <td className="num">{fmtDuration(e.durationConfirmedSeconds)}</td>
                    <td className="num">{e.peakExceedance === null ? '—' : e.peakExceedance.toFixed(3)}</td>
                    <td className="small">{e.downstreamSafeFlow ? `[${e.downstreamSafeFlow.join(', ')}]` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a.comparison && (
              <div className="small mt8">
                <b>附带比较：</b>{ATTRIBUTION_LABEL[a.comparison.attribution] ?? a.comparison.attribution} —— {a.comparison.explanation}
              </div>
            )}
            {a.issues.length > 0 && <ul className="reason-list">{a.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            <button className="small mt8" onClick={() => onDeleted()}>刷新目录对照</button>
          </div>
        );
      })()}
    </div>
  );
}

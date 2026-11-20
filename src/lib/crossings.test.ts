import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/demoData';
import {
  adviseCrossingMode,
  analyzeRule,
  analyzeScenario,
  bindingDrift,
  buildObservedSeries,
  candidateRuleCurves,
  compareScenarios,
  freezeAnalysisRecord,
  medianIntervalSeconds,
  thresholdAt,
} from './crossings';
import type { ObservedSeries, RuleCurve } from '../types';

const data = buildDemoDataset();
const ruleOf = (id: string): RuleCurve => {
  const r = data.ruleCurves.find((x) => x.id === id);
  if (!r) throw new Error(`missing rule ${id}`);
  return r;
};
const seriesOf = (
  reservoirId: string,
  sourceKind: 'water_level' | 'inflow' | 'outflow',
  variant: 'base' | 'strict' = 'base',
): ObservedSeries =>
  buildObservedSeries({
    readings: data.readings,
    reservoirId,
    metric: sourceKind === 'water_level' ? 'water_level' : 'flow',
    sourceKind,
    nominalStepSeconds: 3600,
    variant,
    runId: 'test-run',
  });

describe('规则曲线阈值求值', () => {
  it('线性语义按曲线点插值且不外推', () => {
    const rule = ruleOf('rc-qx-lv-blue');
    expect(thresholdAt(rule, '2026-07-15T00:00:00.000Z')).toBeCloseTo(105.6, 9);
    expect(thresholdAt(rule, '2026-07-14T00:00:00.000Z')).toBeCloseTo(105.6, 9);
    expect(thresholdAt(rule, '2026-07-13T23:00:00.000Z')).toBeNull();
    expect(thresholdAt(rule, '2026-07-21T00:00:00.000Z')).toBeNull();
  });

  it('阶梯语义保持前值，在曲线点处跃变', () => {
    const rule = ruleOf('rc-bs-flow-orange-step');
    expect(thresholdAt(rule, '2026-07-15T02:59:59.999Z')).toBe(85);
    expect(thresholdAt(rule, '2026-07-15T03:00:00.000Z')).toBe(75);
    expect(thresholdAt(rule, '2026-07-15T05:00:00.000Z')).toBe(75);
  });
});

describe('等级切换：规则曲线与下游安全流量同时改变', () => {
  const qx = seriesOf('qx', 'water_level');

  it('蓝色与橙色规则给出不同首次越线时刻，差异归因为阈值定义', () => {
    const blue = analyzeScenario({ label: '蓝', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-blue')] }, { margin: 0.1 });
    const orange = analyzeScenario({ label: '橙', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange')] }, { margin: 0.1 });
    expect(blue.metrics.firstCrossingAt).not.toBeNull();
    expect(orange.metrics.firstCrossingAt).not.toBeNull();
    // 阈值更低（蓝 105.6）先穿越；橙色阈值更高（106.4）后穿越，但不把当前等级倒灌解释历史
    expect(Date.parse(blue.metrics.firstCrossingAt as string)).toBeLessThan(Date.parse(orange.metrics.firstCrossingAt as string));
    expect(blue.metrics.downstreamSafeFlow).toEqual([40, 120]);
    expect(orange.metrics.downstreamSafeFlow).toEqual([30, 90]);

    const cmp = compareScenarios({
      a: { spec: { label: '蓝', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-blue')] }, series: qx, rules: [ruleOf('rc-qx-lv-blue')] },
      b: { spec: { label: '橙', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange')] }, series: qx, rules: [ruleOf('rc-qx-lv-orange')] },
      margin: 0.1,
    });
    expect(cmp.comparison.attribution).toBe('threshold_definition');
    expect(cmp.comparison.deltas.downstreamSafeMax).toBe(-30);
    expect(cmp.comparison.deltas.downstreamSafeMin).toBe(-10);
    expect(cmp.comparison.counterfactual.fact?.ruleIds).toEqual(['rc-qx-lv-blue']);
  });

  it('敏感区间：阈值裕度内的观测/跨线段被归并为时间带', () => {
    const qxBlue = analyzeScenario({ label: '蓝', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-blue')] }, { margin: 0.1 });
    const blueBands = qxBlue.events[0].bands;
    expect(blueBands.length).toBeGreaterThan(0);
    expect(blueBands.some((b) => b.side === 'straddles' && b.minGap === 0)).toBe(true);
    // 精度声明：插值模式为点、网格模式为区间
    expect(qxBlue.events[0].firstCrossing?.precision.kind).toBe('point');
    const qxGrid = analyzeScenario({ label: '蓝格', mode: 'grid', series: qx, rules: [ruleOf('rc-qx-lv-blue')] }, { margin: 0.1 });
    expect(qxGrid.events[0].firstCrossing?.precision.kind).toBe('interval');
  });

  it('插值模式给出点时刻，网格模式给出穿越区间，两者语义不可直接相减', () => {
    const rule = ruleOf('rc-qx-lv-orange');
    const interp = analyzeScenario({ label: '插值', mode: 'interpolated', series: qx, rules: [rule] }, { margin: 0.1 });
    const grid = analyzeScenario({ label: '格', mode: 'grid', series: qx, rules: [rule] }, { margin: 0.1 });
    expect(interp.events[0].firstCrossing?.mode).toBe('interpolated');
    expect(interp.events[0].firstCrossing?.precision.kind).toBe('point');
    expect(interp.events[0].firstCrossing?.at).toMatch(/T04:4\d:/);
    expect(grid.events[0].firstCrossing?.mode).toBe('grid');
    expect(grid.events[0].firstCrossing?.precision.kind).toBe('interval');
    expect(grid.events[0].firstCrossing?.interval).toEqual([
      '2026-07-15T04:00:00.000Z',
      '2026-07-15T05:00:00.000Z',
    ]);
    // 网格模式的确认时长必然不超过插值估计，且给出上限
    expect(grid.events[0].durationConfirmedSeconds).toBeLessThanOrEqual(interp.events[0].durationConfirmedSeconds);
    expect(grid.events[0].durationPossibleSeconds).toBeGreaterThan(grid.events[0].durationConfirmedSeconds);

    const cmp = compareScenarios({
      a: { spec: { label: '插值', mode: 'interpolated', series: qx, rules: [rule] }, series: qx, rules: [rule] },
      b: { spec: { label: '格', mode: 'grid', series: qx, rules: [rule] }, series: qx, rules: [rule] },
      margin: 0.1,
    });
    expect(cmp.comparison.comparable).toBe(false);
    expect(cmp.comparison.attribution).toBe('indeterminate');
    expect(cmp.comparison.counterfactual.fact).toBeNull();
  });
});

describe('阶梯规则曲线与闸门操作', () => {
  const bs = seriesOf('bs', 'inflow');

  it('03:00 越线由阈值阶跃造成，而非观测变化', () => {
    const { event } = analyzeRule(bs, ruleOf('rc-bs-flow-orange-step'), { mode: 'interpolated', margin: 2 });
    expect(event.firstCrossing?.at).toBe('2026-07-15T03:00:00.000Z');
    expect(event.firstCrossing?.inducedBy).toBe('threshold_step');
    expect(event.thresholdStepEvents).toHaveLength(1);
    expect(event.thresholdStepEvents[0].effect).toBe('flip_below_to_above');
    expect(event.thresholdStepEvents[0].fromThreshold).toBe(85);
    expect(event.thresholdStepEvents[0].toThreshold).toBe(75);
    // 观测本身全程 80，越线 5 m³/s 是阈值下调造成
    expect(event.peakExceedance).toBeCloseTo(5, 9);
  });

  it('窗口含闸门操作时声明插值可信性受限，模式建议为观测格判定', () => {
    const { event } = analyzeRule(bs, ruleOf('rc-bs-flow-orange-step'), { mode: 'interpolated', margin: 2 });
    expect(event.caveats.join()).toMatch(/闸门开度\/指令/);
    const advice = adviseCrossingMode(bs, [ruleOf('rc-bs-flow-orange-step')]);
    expect(advice.mode).toBe('grid');
    expect(advice.hasStepCurve).toBe(true);
    expect(advice.gateOpCount).toBeGreaterThan(0);
  });
});

describe('低频观测', () => {
  const xl = seriesOf('xl', 'water_level');

  it('3 小时一次水位观测建议观测格模式，插值声明低频 caveat', () => {
    expect(medianIntervalSeconds(xl)).toBe(10800);
    const advice = adviseCrossingMode(xl, [ruleOf('rc-xl-lv-blue-a')]);
    expect(advice.mode).toBe('grid');
    expect(advice.lowFrequency).toBe(true);
    const { event } = analyzeRule(xl, ruleOf('rc-xl-lv-blue-a'), { mode: 'interpolated', margin: 0.05 });
    expect(event.caveats.join()).toMatch(/低频/);
    // 首次越线（95.2）在 03:00~06:00 之间；插值给出点时刻，网格给出整个格
    expect(event.firstCrossing?.mode).toBe('interpolated');
    const grid = analyzeRule(xl, ruleOf('rc-xl-lv-blue-a'), { mode: 'grid', margin: 0.05 });
    expect(grid.event.firstCrossing?.interval).toEqual(['2026-07-15T03:00:00.000Z', '2026-07-15T06:00:00.000Z']);
  });
});

describe('规则有效期重叠与并发草案', () => {
  const xl = seriesOf('xl', 'water_level');

  it('同等级已审批规则适用期重叠：候选组标记重叠且不自动选取', () => {
    const groups = candidateRuleCurves(data.ruleCurves, { basinId: 'xiling', reservoirId: 'xl', metric: 'water_level' });
    const blue = groups.find((g) => g.warningLevel === 'blue');
    expect(blue?.approved.map((r) => r.version).sort()).toEqual(['XL-LV-A', 'XL-LV-B']);
    expect(blue?.overlapApproved).toBe(true);

    const ambiguous = analyzeScenario(
      { label: '重叠', mode: 'grid', series: xl, rules: [ruleOf('rc-xl-lv-blue-a'), ruleOf('rc-xl-lv-blue-b')] },
      { margin: 0.05 },
    );
    expect(ambiguous.metrics.firstCrossingAt).toBeNull();
    expect(ambiguous.issues.join()).toMatch(/重叠时不自动选取/);
  });

  it('并发草案必须分别绑定，各自给出不同结论', () => {
    const qx = seriesOf('qx', 'water_level');
    const groups = candidateRuleCurves(data.ruleCurves, { basinId: 'qingxi', reservoirId: 'qx', metric: 'water_level' });
    const orange = groups.find((g) => g.warningLevel === 'orange');
    expect(orange?.drafts.map((r) => r.version)).toEqual(['QX-LV-ORANGE-2027-A(草案)', 'QX-LV-ORANGE-2027-B(草案)']);

    const a = analyzeScenario({ label: '草案A', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-a')] }, { margin: 0.1 });
    const b = analyzeScenario({ label: '草案B', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-b')] }, { margin: 0.1 });
    // 阈值 106.2 的草案 A 明显早于阈值 106.6 的草案 B
    expect(Date.parse(a.metrics.firstCrossingAt as string)).toBeLessThan(Date.parse(b.metrics.firstCrossingAt as string));
    const cmp = compareScenarios({
      a: { spec: { label: '草案A', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-a')] }, series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-a')] },
      b: { spec: { label: '草案B', mode: 'interpolated', series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-b')] }, series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-b')] },
      margin: 0.1,
    });
    expect(cmp.comparison.attribution).toBe('threshold_definition');

    const draftRecord = freezeAnalysisRecord({
      reservoirId: 'qx', basinId: 'qingxi', series: qx, rules: [ruleOf('rc-qx-lv-orange-draft-a')],
      mode: 'interpolated', events: a.events, issues: a.issues, now: '2026-07-15T10:00:00.000Z',
    });
    expect(draftRecord.status).toBe('draft_bound');
  });
});

describe('事实变化 vs 阈值定义归因', () => {
  it('同一规则下剔除不影响结论的可疑点（base vs strict）归为无差异，而不是强行归因', () => {
    const base = seriesOf('qx', 'water_level', 'base');
    const strict = seriesOf('qx', 'water_level', 'strict');
    expect(base.points.length).toBe(strict.points.length + 1);
    const rule = ruleOf('rc-qx-lv-orange');
    const cmp = compareScenarios({
      a: { spec: { label: 'base', mode: 'interpolated', series: base, rules: [rule] }, series: base, rules: [rule] },
      b: { spec: { label: 'strict', mode: 'interpolated', series: strict, rules: [rule] }, series: strict, rules: [rule] },
      margin: 0.1,
    });
    expect(cmp.comparison.attribution).toBe('no_difference');
    expect(cmp.comparison.explanation).toContain('一致');
  });

  it('同一规则、观测事实不同且结论改变时归因为事实变化', () => {
    const rule: RuleCurve = {
      id: 'rc-syn', basinId: 'b', basinName: 'B', reservoirId: 'qx',
      warningLevel: 'orange', version: 'SYN-ORANGE', metric: 'water_level', unit: 'm',
      validFrom: '2026-07-15T00:00:00.000Z', approvalStatus: 'approved', curveSemantics: 'linear',
      curvePoints: [
        { t: '2026-07-15T00:00:00.000Z', threshold: 106.0 },
        { t: '2026-07-15T06:00:00.000Z', threshold: 106.0 },
      ],
      downstreamSafeFlow: [30, 90],
    };
    const make = (offset: number): ObservedSeries => ({
      id: `syn-${offset}`, reservoirId: 'qx', metric: 'water_level', sourceKind: 'water_level',
      unit: 'm', nominalStepSeconds: 3600, gateOps: [], variant: 'base', suspectCount: 0, excludedCount: 0,
      builtAt: '2026-07-15T00:00:00.000Z',
      points: [105.0, 105.5, 106.2, 106.4, 106.6].map((v, i) => ({
        t: `2026-07-15T0${i}:00:00.000Z`, value: v + offset,
      })),
    });
    const early = make(0);
    // 观测整体抬升 0.3m -> 首次越线显著提前，事实变化
    const lateSeries = make(-0.3);
    const cmp = compareScenarios({
      a: { spec: { label: '原始', mode: 'interpolated', series: early, rules: [rule] }, series: early, rules: [rule] },
      b: { spec: { label: '订正', mode: 'interpolated', series: lateSeries, rules: [rule] }, series: lateSeries, rules: [rule] },
      margin: 0.1,
    });
    expect(cmp.comparison.attribution).toBe('fact_change');
    expect(cmp.comparison.deltas.firstCrossingSeconds).not.toBe(0);
    expect(cmp.comparison.deltas.downstreamSafeMax).toBe(0);
    expect(cmp.comparison.explanation).toContain('事实变化');
  });

  it('同一观测、蓝 vs 橙归因为阈值定义；观测与规则同时变化时用反事实拆分', () => {
    const qx = seriesOf('qx', 'water_level');
    const strict = seriesOf('qx', 'water_level', 'strict');
    const blue = ruleOf('rc-qx-lv-blue');
    const orange = ruleOf('rc-qx-lv-orange');
    const cmp = compareScenarios({
      a: { spec: { label: '蓝/base', mode: 'interpolated', series: qx, rules: [blue] }, series: qx, rules: [blue] },
      b: { spec: { label: '橙/strict', mode: 'interpolated', series: strict, rules: [orange] }, series: strict, rules: [orange] },
      margin: 0.1,
    });
    expect(['threshold_definition', 'fact_change', 'mixed']).toContain(cmp.comparison.attribution);
    expect(cmp.comparison.counterfactual.fact).not.toBeNull();
    expect(cmp.comparison.counterfactual.rule).not.toBeNull();
    expect(cmp.comparison.explanation.length).toBeGreaterThan(10);
  });
});

describe('发布冻结与审批撤回', () => {
  const qx = seriesOf('qx', 'water_level');

  it('发布记录深拷贝观测与规则；目录改动/撤回不改变已发布记录', () => {
    const orange = ruleOf('rc-qx-lv-orange');
    const analysis = analyzeScenario({ label: '橙', mode: 'interpolated', series: qx, rules: [orange] }, { margin: 0.1 });
    const record = freezeAnalysisRecord({
      runId: 'test-run', reservoirId: 'qx', basinId: 'qingxi', series: qx, rules: [orange],
      mode: 'interpolated', events: analysis.events, issues: analysis.issues, now: '2026-07-15T10:00:00.000Z',
    });
    expect(record.status).toBe('ok');
    expect(record.ruleBindings[0].approvalStatus).toBe('approved');
    expect(bindingDrift(record, data.ruleCurves)).toEqual([]);

    // 审批撤回 + 曲线点被改：已发布记录保留当时引用，漂移被列出
    const retired: RuleCurve = {
      ...orange, approvalStatus: 'retired', retiredAt: '2026-07-15T11:00:00.000Z',
      curvePoints: orange.curvePoints.map((p) => ({ ...p, threshold: p.threshold + 0.5 })),
    };
    const current = data.ruleCurves.map((r) => (r.id === orange.id ? retired : r));
    const drift = bindingDrift(record, current);
    expect(drift.join()).toMatch(/审批状态/);
    expect(drift.join()).toMatch(/曲线点已被修改/);
    expect(record.ruleBindings[0].approvalStatus).toBe('approved');
    expect(record.ruleBindings[0].curvePoints[0].threshold).toBe(106.4);

    // 在撤回状态下新建比较必须另绑版本（记录 status 变为需确认）
    const retiredAnalysis = analyzeScenario({ label: '撤回', mode: 'interpolated', series: qx, rules: [retired] }, { margin: 0.1 });
    const retiredRecord = freezeAnalysisRecord({
      reservoirId: 'qx', basinId: 'qingxi', series: qx, rules: [retired],
      mode: 'interpolated', events: retiredAnalysis.events, issues: retiredAnalysis.issues, now: '2026-07-15T11:30:00.000Z',
    });
    expect(retiredRecord.status).toBe('needs_confirmation');
    expect(retiredRecord.ruleBindings[0].approvalStatus).toBe('retired');
  });

  it('已停用规则绑定后，发布记录保留撤回时刻与状态', () => {
    const xl = seriesOf('xl', 'water_level');
    const retired = ruleOf('rc-xl-lv-yellow-retired');
    const analysis = analyzeScenario({ label: '停用', mode: 'grid', series: xl, rules: [retired] }, { margin: 0.05 });
    const record = freezeAnalysisRecord({
      reservoirId: 'xl', basinId: 'xiling', series: xl, rules: [retired],
      mode: 'grid', events: analysis.events, issues: analysis.issues, now: '2026-07-15T12:00:00.000Z',
    });
    expect(record.ruleBindings[0].retiredAt).toBe('2026-06-02T00:00:00.000Z');
    expect(record.status).toBe('needs_confirmation');
  });
});

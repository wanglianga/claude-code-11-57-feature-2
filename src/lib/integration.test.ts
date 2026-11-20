// 端到端集成测试：fake-indexeddb 复刻 Worker 的“播种→锁定快照→平衡→指标→落库”路径
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllData, getFactsByRun, getIndicatorsByRun, getReadingsForCutoff,
  getSnapshot, saveAnnotationFields,
  getAllRuleCurves, getAllSeries, getSeriesForRun, putRuleCurve, saveCrossingAnalysis,
  getAllCrossingAnalyses,
} from '../db';
import { seedDemoData } from '../services/seedService';
import { createRun } from '../services/runService';
import { executeRun, type RunContext } from './balance';
import { computeAllIndicators } from './indicators';
import { replaceFacts, replaceIndicators, saveRun } from '../db';
import { DEMO_CUTOFF_RUN1, DEMO_CUTOFF_RUN2 } from '../demo/demoData';
import type { BalanceRun } from '../types';
import {
  analyzeScenario, bindingDrift, freezeAnalysisRecord,
} from './crossings';
import { persistObservedSeries } from '../services/seriesService';

async function executeLikeWorker(run: BalanceRun) {
  const snapshot = (await getSnapshot(run.id))!;
  const ctx: RunContext = {
    snapshot,
    tolerance: run.tolerance,
    nominalStepSeconds: run.gridStepSeconds,
    gridStart: run.gridStart,
    gridEnd: run.gridEnd,
    gridStepSeconds: run.gridStepSeconds,
  };
  const facts = executeRun(ctx);
  const indicators = computeAllIndicators(snapshot, facts, {
    runId: run.id,
    asOf: run.gridEnd,
    pressureWindowSeconds: run.pressureWindowSeconds,
    decisionHorizonSeconds: run.decisionHorizonSeconds,
  });
  await replaceFacts(run.id, facts);
  await replaceIndicators(run.id, indicators);
  await saveRun({ ...run, status: 'completed', stats: { factCount: facts.length, pendingCount: indicators.filter((i) => i.pending).length, unclosedCount: facts.filter((f) => f.unclosedReasons.length > 0).length }, warnings: [] });
  return { facts, indicators };
}

afterEach(async () => {
  await clearAllData();
});

describe('端到端：六类验收场景', () => {
  it('播种与资料截止点：RUN1 排除迟到雨量，RUN2 纳入', async () => {
    await seedDemoData();
    const run1Readings = await getReadingsForCutoff(DEMO_CUTOFF_RUN1);
    const run2Readings = await getReadingsForCutoff(DEMO_CUTOFF_RUN2);
    const late = run2Readings.filter((r) => r.note === '通信中断后补传');
    expect(late.length).toBe(1);
    expect(run1Readings.some((r) => r.id === late[0].id)).toBe(false);
    expect(run2Readings.some((r) => r.id === late[0].id)).toBe(true);
  });

  it('RUN1 青溪河 05~06 区间因迟到雨量缺失不可闭合；RUN2 同区间闭合', async () => {
    await seedDemoData();
    const base = {
      name: 't', gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600, reservoirIds: ['qx'], design: 'materialized' as const,
    };
    const r1 = await createRun({ ...base, name: 'RUN1', cutoffAt: DEMO_CUTOFF_RUN1 });
    const r2 = await createRun({ ...base, name: 'RUN2', cutoffAt: DEMO_CUTOFF_RUN2 });
    const out1 = await executeLikeWorker(r1);
    const out2 = await executeLikeWorker(r2);

    const last1 = out1.facts.find((f) => f.t1 === '2026-07-15T05:00:00.000Z')!;
    const last2 = out2.facts.find((f) => f.t1 === '2026-07-15T05:00:00.000Z')!;
    expect(last1.closed).toBe(false);
    expect(last1.unclosedReasons.join()).toContain('覆盖率');
    expect(last2.closed).toBe(true);
    // 同一引擎两次运行确定性一致（除截止点差异外的区间完全相同）
    const f0run1 = out1.facts.find((f) => f.t1 === '2026-07-15T00:00:00.000Z')!;
    const f0run2 = out2.facts.find((f) => f.t1 === '2026-07-15T00:00:00.000Z')!;
    expect(f0run1.residual).toEqual(f0run2.residual);
  });

  it('跨库调水进入平衡项且符号正确（青溪河调入为正、白沙河调出为负）', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '调水', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T01:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['qx', 'bs'], design: 'materialized',
    });
    const { facts } = await executeLikeWorker(run);
    const qx = facts.find((f) => f.reservoirId === 'qx')!;
    const bs = facts.find((f) => f.reservoirId === 'bs')!;
    expect(qx.terms.find((t) => t.key === 'transferIn')!.valueM3).toBe(20 * 3600);
    expect(qx.terms.find((t) => t.key === 'transferOut')!.valueM3).toBe(0);
    expect(bs.terms.find((t) => t.key === 'transferOut')!.valueM3).toBe(10 * 3600);
    expect(bs.terms.find((t) => t.key === 'transferIn')!.valueM3).toBe(0);
  });

  it('库容曲线切换被记录，断面故障区间残差为 null', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '曲线与故障', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T02:00:00.000Z', gridEnd: '2026-07-15T05:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['bs'], design: 'materialized',
    });
    const { facts, indicators } = await executeLikeWorker(run);
    expect(facts[0].curveSwitched).toBe(true);
    expect(facts[0].storageCurveIdAtT1).toBe('cv-bs-s1');
    expect(facts[0].storageCurveIdAtT2).toBe('cv-bs-s2');
    const fault = facts.find((f) => f.t1 === '2026-07-15T03:00:00.000Z')!;
    expect(fault.residual).toBeNull();
    expect(fault.terms.find((t) => t.key === 'inflow')!.covered).toBe(false);
    expect(indicators[0].pending).toBe(true);
  });

  it('无效曲线 + 规则重叠：西岭指标保持待核，不输出确定性余量', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '待核', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['xl'], design: 'materialized',
    });
    const { indicators } = await executeLikeWorker(run);
    const ind = indicators[0];
    expect(ind.pending).toBe(true);
    expect(ind.floodMargin).toBeNull();
    expect(ind.pendingReasons.join()).toMatch(/曲线|规则/);
  });

  it('大文件下钻：东风水库 5 天 120 个小时区间、10 分钟级流量全部可闭合', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '大文件', cutoffAt: '2026-07-15T09:30:00.000Z',
      gridStart: '2026-07-10T00:00:00.000Z', gridEnd: '2026-07-15T00:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 50_000, relFraction: 0.05 },
      pressureWindowSeconds: 6 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['df'], design: 'materialized',
    });
    const { facts, indicators } = await executeLikeWorker(run);
    expect(facts.length).toBe(120);
    const unclosed = facts.filter((f) => !f.closed);
    expect(unclosed.length).toBe(0);
    const evidenceCount = facts[60].terms.reduce((s, t) => s + t.sourceReadingIds.length, 0);
    expect(evidenceCount).toBeGreaterThan(20); // 10 分钟级证据链
    expect(indicators[0].floodMargin).not.toBeNull();
    // 落库路径校验：物化事实与指标可被复盘页直接读取
    expect((await getFactsByRun(run.id)).length).toBe(120);
    expect((await getIndicatorsByRun(run.id)).length).toBe(1);
  });

  it('并发批注：不同字段保留、同字段冲突留痕，不做整单覆盖', async () => {
    await seedDemoData();
    await saveAnnotationFields('indicator', 'i-x', {
      处置理由: { field: '处置理由', author: '甲', value: '加强观测', updatedAt: '2026-07-15T07:00:00.000Z' },
    }, '2026-07-15T07:00:00.000Z');
    const b = await saveAnnotationFields('indicator', 'i-x', {
      风险结论: { field: '风险结论', author: '乙', value: '待核', updatedAt: '2026-07-15T07:01:00.000Z' },
    }, '2026-07-15T07:01:00.000Z');
    expect(Object.keys(b.annotation.fields).sort()).toEqual(['处置理由', '风险结论']);
    const c = await saveAnnotationFields('indicator', 'i-x', {
      处置理由: { field: '处置理由', author: '乙', value: '提前预泄', updatedAt: '2026-07-15T07:05:00.000Z' },
    }, '2026-07-15T07:05:00.000Z');
    expect(c.conflicts.length).toBe(1);
    expect(c.annotation.fields['处置理由'].value).toBe('提前预泄');
    expect(c.annotation.fields['风险结论'].value).toBe('待核');
    expect(c.annotation.revision).toBe(3);
  });
});

describe('端到端：规则曲线越线分析', () => {
  it('运行锁定快照冻结预警规则曲线，并保存连续观测序列', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '越线', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['qx', 'bs'], design: 'materialized',
    });
    const snapshot = (await getSnapshot(run.id))!;
    expect(snapshot.ruleCurves?.map((r) => r.id)).toContain('rc-qx-lv-orange');

    // 与 Worker 同一路径：指标运行保存水位/流量序列
    const saved = await persistObservedSeries(snapshot, run.gridStepSeconds);
    expect(saved).toBeGreaterThan(0);
    const qxLevel = (await getSeriesForRun(run.id)).find(
      (s) => s.reservoirId === 'qx' && s.sourceKind === 'water_level',
    );
    expect(qxLevel?.points.length).toBe(7);
    expect((await getAllSeries()).length).toBe(saved);

    // 目录后改不影响快照：撤回橙色规则审批，快照仍保留 approved
    const orange = (await getAllRuleCurves()).find((r) => r.id === 'rc-qx-lv-orange')!;
    await putRuleCurve({ ...orange, approvalStatus: 'retired', retiredAt: '2026-07-15T10:00:00.000Z' });
    const frozen = (await getSnapshot(run.id))!.ruleCurves!.find((r) => r.id === orange.id)!;
    expect(frozen.approvalStatus).toBe('approved');
  });

  it('发布冻结记录 → 目录撤回/改点 → 已发布结论不回改，漂移可查', async () => {
    await seedDemoData();
    const run = await createRun({
      name: '冻结', cutoffAt: DEMO_CUTOFF_RUN2,
      gridStart: '2026-07-15T00:00:00.000Z', gridEnd: '2026-07-15T06:00:00.000Z',
      gridStepSeconds: 3600, tolerance: { absM3: 20_000, relFraction: 0.02 },
      pressureWindowSeconds: 3 * 3600, decisionHorizonSeconds: 3600,
      reservoirIds: ['qx'], design: 'materialized',
    });
    const snapshot = (await getSnapshot(run.id))!;
    await persistObservedSeries(snapshot, run.gridStepSeconds);
    const series = (await getSeriesForRun(run.id)).find(
      (s) => s.reservoirId === 'qx' && s.sourceKind === 'water_level',
    )!;
    const orange = (await getAllRuleCurves()).find((r) => r.id === 'rc-qx-lv-orange')!;
    const analysis = analyzeScenario(
      { label: '橙', mode: 'interpolated', series, rules: [orange] },
      { margin: 0.1 },
    );
    const record = freezeAnalysisRecord({
      runId: run.id, reservoirId: 'qx', basinId: 'qingxi', series, rules: [orange],
      mode: 'interpolated', events: analysis.events, issues: analysis.issues,
      now: '2026-07-15T10:00:00.000Z',
    });
    await saveCrossingAnalysis(record);
    const stored = (await getAllCrossingAnalyses())[0];
    expect(stored.status).toBe('ok');
    expect(stored.events[0].firstCrossing?.at).not.toBeNull();

    // 撤回审批并修改曲线点
    await putRuleCurve({
      ...orange, approvalStatus: 'retired', retiredAt: '2026-07-15T11:00:00.000Z',
      curvePoints: orange.curvePoints.map((p) => ({ ...p, threshold: p.threshold + 0.4 })),
    });
    const current = await getAllRuleCurves();
    const drift = bindingDrift(stored, current);
    expect(drift.length).toBeGreaterThanOrEqual(2);
    // 已发布记录仍是冻结时的版本与审批状态
    const reread = (await getAllCrossingAnalyses())[0];
    expect(reread.ruleBindings[0].approvalStatus).toBe('approved');
    expect(reread.ruleBindings[0].curvePoints[0].threshold).toBe(106.4);
    expect(reread.events[0].firstCrossing?.at).toBe(stored.events[0].firstCrossing?.at);
  });
});

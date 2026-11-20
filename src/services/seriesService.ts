// 指标运行的连续观测序列：水位与入库/出库流量，随运行冻结来源，供越线分析复用。
import { saveSeries } from '../db';
import { buildObservedSeries } from '../lib/crossings';
import type { RuleMetric, RunSnapshot } from '../types';

/** 为每个参与水库保存水位与入库/出库流量序列（base 变体），供越线分析直接选用 */
export async function persistObservedSeries(snapshot: RunSnapshot, nominalStepSeconds: number): Promise<number> {
  let saved = 0;
  for (const reservoir of snapshot.reservoirs) {
    const specs: { metric: RuleMetric; sourceKind: 'water_level' | 'inflow' | 'outflow' }[] = [
      { metric: 'water_level', sourceKind: 'water_level' },
      { metric: 'flow', sourceKind: 'inflow' },
      { metric: 'flow', sourceKind: 'outflow' },
    ];
    for (const spec of specs) {
      const series = buildObservedSeries({
        readings: snapshot.readings,
        reservoirId: reservoir.id,
        metric: spec.metric,
        sourceKind: spec.sourceKind,
        nominalStepSeconds,
        variant: 'base',
        runId: snapshot.runId,
      });
      if (series.points.length > 0) {
        await saveSeries(series);
        saved += 1;
      }
    }
  }
  return saved;
}

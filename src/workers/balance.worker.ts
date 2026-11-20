// 平衡运行 WebWorker：在后台线程完成固定网格的平衡事实物化与指标计算，
// 不阻塞看板 UI。物化（materialized）与按需（on_demand）两种设计调用完全相同的
// 平衡方程、曲线版本与容差函数，保证可复算一致。
import { executeRun, ruleOverlapIssues, type RunContext } from '../lib/balance';
import { computeAllIndicators } from '../lib/indicators';
import {
  getFactsByRun,
  getIndicatorsByRun,
  getRun,
  getSnapshot,
  replaceFacts,
  replaceIndicators,
  saveRun,
} from '../db';
import { persistObservedSeries } from '../services/seriesService';
import { nowISO } from '../lib/time';

export interface WorkerRunRequest {
  type: 'run' | 'ondemand';
  runId: string;
}
export type WorkerProgress =
  | { type: 'progress'; runId: string; message: string }
  | {
      type: 'done';
      runId: string;
      factCount: number;
      indicatorCount: number;
      pendingCount: number;
      unclosedCount: number;
      warnings: string[];
    }
  | {
      type: 'ondemand_result';
      runId: string;
      facts: Awaited<ReturnType<typeof executeRun>>;
      indicators: Awaited<ReturnType<typeof computeAllIndicators>>;
    }
  | { type: 'error'; runId: string; message: string };

self.onmessage = async (ev: MessageEvent<WorkerRunRequest>) => {
  const msg = ev.data;
  const post = (p: WorkerProgress) => (self as unknown as Worker).postMessage(p);
  if (msg.type === 'ondemand') {
    try {
      const { facts, indicators } = await runOnDemand(msg.runId);
      post({ type: 'ondemand_result', runId: msg.runId, facts, indicators });
    } catch (e) {
      post({ type: 'error', runId: msg.runId, message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (msg.type !== 'run') return;
  const { runId } = msg;
  try {
    const run = await getRun(runId);
    const snapshot = await getSnapshot(runId);
    if (!run || !snapshot) throw new Error(`运行 ${runId} 的锁定快照不存在`);

    post({ type: 'progress', runId, message: '读取截止点快照完成，开始区间平衡计算' });
    const ctx: RunContext = {
      snapshot,
      tolerance: run.tolerance,
      nominalStepSeconds: run.gridStepSeconds,
      gridStart: run.gridStart,
      gridEnd: run.gridEnd,
      gridStepSeconds: run.gridStepSeconds,
    };

    // 小步让出事件循环以便进度消息可刷新（大文件下钻场景）
    const facts = await new Promise<Awaited<ReturnType<typeof executeRun>>>((resolve) => {
      setTimeout(() => resolve(executeRun(ctx)), 0);
    });
    post({ type: 'progress', runId, message: `平衡事实 ${facts.length} 条，开始指标计算` });

    const indicators = computeAllIndicators(snapshot, facts, {
      runId,
      asOf: run.gridEnd,
      pressureWindowSeconds: run.pressureWindowSeconds,
      decisionHorizonSeconds: run.decisionHorizonSeconds,
    });

    const warnings = ruleOverlapIssues(snapshot.rules, snapshot.reservoirs);
    const pendingCount = indicators.filter((i) => i.pending).length;
    const unclosedCount = facts.filter((f) => f.unclosedReasons.length > 0).length;

    // 物化设计持久化“水库—时段平衡事实”；按需设计只保留来源索引与运行定义，
    // 看板下钻时经 ondemand 通道用同一引擎即时求值。
    if (run.design === 'materialized') {
      await replaceFacts(runId, facts);
      await replaceIndicators(runId, indicators);
    }
    // 指标运行同时保存连续水位/流量序列，供规则曲线穿越与敏感区间分析复用，
    // 不直接读取“最新文件”。
    const seriesCount = await persistObservedSeries(snapshot, run.gridStepSeconds);
    await saveRun({
      ...run,
      status: warnings.length > 0 || pendingCount > 0 ? 'completed_with_warnings' : 'completed',
      finishedAt: nowISO(),
      warnings: [...warnings, ...(seriesCount > 0 ? [`已保存连续观测序列 ${seriesCount} 条，供越线分析回查`] : [])],
      stats: {
        factCount: facts.length,
        pendingCount,
        unclosedCount,
      },
    });
    post({
      type: 'done',
      runId,
      factCount: facts.length,
      indicatorCount: indicators.length,
      pendingCount,
      unclosedCount,
      warnings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const run = await getRun(runId);
    if (run) await saveRun({ ...run, status: 'failed', finishedAt: nowISO(), warnings: [message] });
    post({ type: 'error', runId, message });
  }
};

// 按需设计的下钻查询复用同一引擎（在 worker 内按子集即时计算，不预落库）
export async function runOnDemand(runId: string): Promise<{
  facts: Awaited<ReturnType<typeof getFactsByRun>>;
  indicators: Awaited<ReturnType<typeof getIndicatorsByRun>>;
}> {
  const run = await getRun(runId);
  const snapshot = await getSnapshot(runId);
  if (!run || !snapshot) throw new Error('按需计算缺少运行快照');
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
    runId,
    asOf: run.gridEnd,
    pressureWindowSeconds: run.pressureWindowSeconds,
    decisionHorizonSeconds: run.decisionHorizonSeconds,
  });
  return { facts, indicators };
}

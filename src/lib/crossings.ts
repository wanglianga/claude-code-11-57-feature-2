// 规则曲线穿越与敏感区间分析（纯函数引擎）
//
// 两种判定模式，语义不同、结论不同：
//  - interpolated：把规则曲线与观测序列都视为连续函数（规则按 linear/step 语义），
//    在相邻观测（及规则曲线点）之间求 g(t)=观测(t)-阈值(t) 的零点，穿越时刻为点；
//    精度受采样间隔、曲线线性假设与闸门/陡变影响，因此必须声明可信度。
//  - grid：只在观测时间格上判断规则关系，穿越时刻只能表示为 [前观测, 后观测] 区间；
//    语义保守、可回查，但无法给出格内时刻。
//
// 规则有效期重叠时不自动选取（analyzeScenario 对同等级多条规则拒绝求解）；
// 曲线审批撤回后，已发布分析保留冻结引用（见 CrossingAnalysisRecord.seriesSnapshot/ruleBindings）。
import type {
  CrossingAnalysisRecord,
  CrossingAttribution,
  CrossingComparison,
  CrossingEvent,
  CrossingMode,
  CrossingScenarioInput,
  FirstCrossing,
  NearThresholdBand,
  ObservedSeries,
  QualityFlag,
  RawReading,
  Reservoir,
  RuleCandidateGroup,
  RuleCurve,
  RuleCurvePoint,
  RuleMetric,
  ScenarioMetrics,
  SeriesPoint,
  ThresholdStepEvent,
  WarningLevel,
} from '../types';
import { t } from './time';

const EPS_MS = 1;
const TIME_EPS = 1e-9;

export const WARNING_LEVEL_LABEL: Record<WarningLevel, string> = {
  blue: '蓝色',
  yellow: '黄色',
  orange: '橙色',
  red: '红色',
};

export const WARNING_LEVEL_ORDER: WarningLevel[] = ['blue', 'yellow', 'orange', 'red'];

const METRIC_LABEL: Record<RuleMetric, string> = {
  water_level: '水位',
  flow: '流量',
};

// ---------------------------------------------------------------------------
// 观测序列
// ---------------------------------------------------------------------------

export interface BuildSeriesOptions {
  readings: RawReading[];
  reservoirId: string;
  /** 规则指标：水位 -> 水位读数；流量 -> 入库或出库流量 */
  metric: RuleMetric;
  sourceKind: 'water_level' | 'inflow' | 'outflow';
  nominalStepSeconds: number;
  /** base 保留可疑/估算读数；strict 剔除 */
  variant: 'base' | 'strict';
  runId?: string;
}

const QUALITY_SCORE: Record<QualityFlag, number> = {
  confirmed: 4,
  estimated: 3,
  suspect: 2,
  missing: 1,
  rejected: 0,
};

/**
 * 从运行快照构造连续观测序列。显式缺失、作废、量纲不相容读数剔除；
 * 同一采样时刻多条时按质量优先、接收时间较新者保留。
 */
export function buildObservedSeries(opts: BuildSeriesOptions): ObservedSeries {
  const expectedUnit = opts.metric === 'water_level' ? 'm' : 'm3/s';
  const relevant = opts.readings.filter(
    (r) =>
      r.reservoirId === opts.reservoirId &&
      r.kind === opts.sourceKind &&
      !r.supersededById &&
      r.quality !== 'rejected',
  );
  let excludedCount = 0;
  let suspectCount = 0;
  const byTime = new Map<number, RawReading>();
  for (const r of relevant) {
    if (r.value === null || r.quality === 'missing' || r.unit !== expectedUnit) {
      excludedCount += 1;
      continue;
    }
    const questionable = r.quality === 'suspect' || r.quality === 'estimated';
    if (questionable) {
      suspectCount += 1;
      if (opts.variant === 'strict') {
        excludedCount += 1;
        continue;
      }
    }
    const ms = t(r.sampledAt).valueOf();
    const cur = byTime.get(ms);
    if (
      !cur ||
      QUALITY_SCORE[r.quality] > QUALITY_SCORE[cur.quality] ||
      (QUALITY_SCORE[r.quality] === QUALITY_SCORE[cur.quality] &&
        t(r.receivedAt).valueOf() >= t(cur.receivedAt).valueOf())
    ) {
      byTime.set(ms, r);
    }
  }

  const points: SeriesPoint[] = [...byTime.values()]
    .sort((a, b) => t(a.sampledAt).valueOf() - t(b.sampledAt).valueOf())
    .map((r) => ({ t: r.sampledAt, value: r.value as number, readingId: r.id, quality: r.quality }));

  const firstMs = points.length > 0 ? t(points[0].t).valueOf() : Number.POSITIVE_INFINITY;
  const lastMs = points.length > 0 ? t(points[points.length - 1].t).valueOf() : Number.NEGATIVE_INFINITY;
  const gateOps = opts.readings
    .filter(
      (r) =>
        r.reservoirId === opts.reservoirId &&
        (r.kind === 'gate_opening' || r.kind === 'gate_order') &&
        !r.supersededById &&
        r.quality !== 'rejected' &&
        t(r.sampledAt).valueOf() >= firstMs &&
        t(r.sampledAt).valueOf() <= lastMs,
    )
    .map((r) => r.sampledAt)
    .sort();

  return {
    id: `${opts.runId ?? 'adhoc'}-series-${opts.reservoirId}-${opts.sourceKind}-${opts.variant}`,
    runId: opts.runId,
    reservoirId: opts.reservoirId,
    metric: opts.metric,
    sourceKind: opts.sourceKind,
    unit: expectedUnit,
    nominalStepSeconds: opts.nominalStepSeconds,
    points,
    gateOps: [...new Set(gateOps)],
    variant: opts.variant,
    suspectCount,
    excludedCount,
    builtAt: points.length > 0 ? points[0].t : new Date(0).toISOString(),
  };
}

export function medianIntervalSeconds(series: ObservedSeries): number {
  if (series.points.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < series.points.length; i += 1) {
    gaps.push(t(series.points[i].t).valueOf() - t(series.points[i - 1].t).valueOf());
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const ms = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  return ms / 1000;
}

// ---------------------------------------------------------------------------
// 规则曲线阈值求值
// ---------------------------------------------------------------------------

export function sortedCurvePoints(rule: RuleCurve): RuleCurvePoint[] {
  return [...rule.curvePoints].sort((a, b) => t(a.t).valueOf() - t(b.t).valueOf());
}

/** 阈值求值：linear 插值且不外推；step 保持前值。超出曲线定义域返回 null。 */
export function thresholdAt(rule: RuleCurve, at: string): number | null {
  const pts = sortedCurvePoints(rule);
  if (pts.length === 0) return null;
  const ms = t(at).valueOf();
  const firstMs = t(pts[0].t).valueOf();
  if (ms < firstMs) return null;
  if (rule.curveSemantics === 'step') {
    let val: number | null = null;
    for (const p of pts) {
      if (t(p.t).valueOf() <= ms) val = p.threshold;
      else break;
    }
    return val;
  }
  const lastMs = t(pts[pts.length - 1].t).valueOf();
  if (ms > lastMs) return null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const aMs = t(a.t).valueOf();
    const bMs = t(b.t).valueOf();
    if (ms >= aMs && ms <= bMs) {
      if (bMs === aMs) return a.threshold;
      return a.threshold + ((ms - aMs) / (bMs - aMs)) * (b.threshold - a.threshold);
    }
  }
  return pts[pts.length - 1].threshold;
}

// ---------------------------------------------------------------------------
// 规则候选（不自动选取重叠的已审批规则）
// ---------------------------------------------------------------------------

export interface CandidateOptions {
  basinId?: string;
  reservoirId: string;
  metric: RuleMetric;
  /** 分析窗口；只保留与该窗口有交集的有效期 */
  window?: [string, string];
}

export function candidateRuleCurves(rules: RuleCurve[], opts: CandidateOptions): RuleCandidateGroup[] {
  const winStart = opts.window ? t(opts.window[0]).valueOf() : Number.NEGATIVE_INFINITY;
  const winEnd = opts.window ? t(opts.window[1]).valueOf() : Number.POSITIVE_INFINITY;
  const matched = rules.filter((r) => {
    if (r.metric !== opts.metric) return false;
    if (r.reservoirId !== undefined && r.reservoirId !== opts.reservoirId) return false;
    if (r.reservoirId === undefined && opts.basinId !== undefined && r.basinId !== opts.basinId) return false;
    const start = t(r.validFrom).valueOf();
    const end = r.validTo ? t(r.validTo).valueOf() : Number.POSITIVE_INFINITY;
    return start < winEnd && end > winStart;
  });
  return WARNING_LEVEL_ORDER.map((level) => {
    const ofLevel = matched.filter((r) => r.warningLevel === level);
    const approved = ofLevel.filter((r) => r.approvalStatus === 'approved');
    const drafts = ofLevel.filter((r) => r.approvalStatus === 'draft');
    const retired = ofLevel.filter((r) => r.approvalStatus === 'retired');
    return {
      warningLevel: level,
      approved,
      drafts,
      retired,
      overlapApproved: approved.length > 1,
    };
  }).filter((g) => g.approved.length + g.drafts.length + g.retired.length > 0);
}

/** 规则是否覆盖目标水库（流域级规则按 basin 匹配） */
export function ruleAppliesTo(rule: RuleCurve, reservoir: Reservoir): boolean {
  if (rule.reservoirId) return rule.reservoirId === reservoir.id;
  return reservoir.basinId !== undefined && rule.basinId === reservoir.basinId;
}

// ---------------------------------------------------------------------------
// 单规则穿越分析
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  mode: CrossingMode;
  /** 接近阈值的裕度（与规则同单位） */
  margin: number;
}

interface SeriesView {
  times: number[];
  values: number[];
}

/** 观测序列在任意时刻的值：观测点间线性插值，序列范围外返回 null。 */
function valueAt(view: SeriesView, ms: number): number | null {
  const { times, values } = view;
  if (times.length === 0) return null;
  if (ms < times[0] - EPS_MS || ms > times[times.length - 1] + EPS_MS) return null;
  if (Math.abs(ms - times[0]) <= EPS_MS) return values[0];
  if (Math.abs(ms - times[times.length - 1]) <= EPS_MS) return values[values.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid;
  }
  if (Math.abs(ms - times[lo]) <= EPS_MS) return values[lo];
  if (Math.abs(ms - times[hi]) <= EPS_MS) return values[hi];
  const frac = (ms - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + frac * (values[hi] - values[lo]);
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function classifyInducedBy(dObs: number, dThr: number, semantics: RuleCurve['curveSemantics']): 'observation' | 'threshold_trend' | 'threshold_step' {
  const obsMoved = Math.abs(dObs) > TIME_EPS;
  const thrMoved = Math.abs(dThr) > TIME_EPS;
  if (!obsMoved && thrMoved) return semantics === 'step' ? 'threshold_step' : 'threshold_trend';
  if (obsMoved && !thrMoved) return 'observation';
  if (!obsMoved && !thrMoved) return 'observation';
  // 两者同时变化：谁对缩小间距贡献更大
  return dObs >= dThr ? 'observation' : semantics === 'step' ? 'threshold_step' : 'threshold_trend';
}

interface GPoint {
  ms: number;
  iso: string;
  g: number;
  thr: number;
  value: number;
  knotMs: number;
}

interface CrossingCandidate {
  atMs: number;
  prev: GPoint;
  next: GPoint;
  inducedBy: 'observation' | 'threshold_step' | 'threshold_trend';
}

function makeBands(
  stamps: { ms: number; g: number; thr: number; value: number }[],
  times: string[],
  margin: number,
): NearThresholdBand[] {
  // 每个观测点是否属于敏感带：自身距阈值不超过裕度，或其两侧线段发生跨线。
  const flag = stamps.map((s) => Math.abs(s.g) <= margin);
  const straddleLine = new Array<boolean>(Math.max(stamps.length - 1, 0)).fill(false);
  for (let i = 1; i < stamps.length; i += 1) {
    const a = stamps[i - 1].g;
    const b = stamps[i].g;
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      flag[i - 1] = true;
      flag[i] = true;
      straddleLine[i - 1] = true;
    }
  }
  const bands: NearThresholdBand[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    let below = 0;
    let above = 0;
    let minGap = Number.POSITIVE_INFINITY;
    for (let k = start; k <= end; k += 1) {
      if (stamps[k].g < 0) below += 1;
      else if (stamps[k].g > 0) above += 1;
      minGap = Math.min(minGap, Math.abs(stamps[k].g));
    }
    for (let k = start; k < end; k += 1) if (straddleLine[k]) minGap = 0;
    const side: NearThresholdBand['side'] = below > 0 && above > 0 ? 'straddles' : below > 0 ? 'below' : 'above';
    bands.push({
      start: times[start],
      end: times[end],
      minGap: Number.isFinite(minGap) ? minGap : 0,
      side,
    });
    start = -1;
  };
  for (let i = 0; i < flag.length; i += 1) {
    if (flag[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      flush(i - 1);
    }
  }
  if (start >= 0) flush(flag.length - 1);
  return bands;
}

function caveatsFor(
  series: ObservedSeries,
  rule: RuleCurve,
  mode: CrossingMode,
  window: [string, string],
  medianSeconds: number,
): string[] {
  const caveats: string[] = [];
  const lowFreq = series.nominalStepSeconds > 0 && medianSeconds > series.nominalStepSeconds * 1.5;
  if (mode === 'interpolated') {
    caveats.push(
      `穿越时刻为相邻观测/规则点之间的线性插值交点，名义分辨率约 ±${Math.round(medianSeconds / 2)}s（中位采样间隔 ${Math.round(medianSeconds)}s）；仅在观测足够密、曲线变化平缓时可信。`,
    );
    if (lowFreq) {
      caveats.push(
        `观测为低频（中位 ${Math.round(medianSeconds)}s，名义步长 ${series.nominalStepSeconds}s），插值交点可能显著偏离实际穿越，不宜据此发布精确指令。`,
      );
    }
    if (rule.curveSemantics === 'step') {
      caveats.push('规则曲线为阶梯语义：阈值在曲线点处跃变，阶跃当刻的穿越属于阈值定义变化，已单独标注为 threshold_step。');
    }
  } else {
    caveats.push('仅在观测时间格上判断规则关系，未对观测或阈值做插值；格内穿越时刻只表示为区间，语义保守且可回查。');
    if (rule.curveSemantics === 'linear') {
      caveats.push('规则曲线为线性语义但在网格模式下仅在观测时刻取样，格内阈值变化被折叠，可能高估/低估连续阈值的穿越位置。');
    }
  }
  const gateOps = series.gateOps.filter((g) => t(g).valueOf() >= t(window[0]).valueOf() && t(g).valueOf() <= t(window[1]).valueOf());
  if (gateOps.length > 0) {
    caveats.push(
      `窗口内含 ${gateOps.length} 条闸门开度/指令记录（${gateOps.slice(0, 3).map((x) => x.slice(5, 16).replace('T', ' ')).join('、')}${gateOps.length > 3 ? '…' : ''}）；陡变与闸门操作处插值穿越时刻不可视为精确。`,
    );
  }
  if (series.variant === 'base' && series.suspectCount > 0) {
    caveats.push(`序列含 ${series.suspectCount} 条可疑/估算读数（base 变体），穿越结论受其影响；可切换 strict 变体核对。`);
  }
  if (series.variant === 'strict' && series.excludedCount > 0) {
    caveats.push(`strict 变体已剔除 ${series.excludedCount} 条可疑/估算/不可用读数，观测间隔可能变稀疏。`);
  }
  if (rule.approvalStatus !== 'approved') {
    caveats.push(`绑定规则为${rule.approvalStatus === 'draft' ? '草稿' : '已停用'}状态（${rule.version}），仅作情景演练，不作为发布结论；草稿之间互不替代。`);
  }
  return caveats;
}

export interface RuleAnalysis {
  event: CrossingEvent;
  issues: string[];
}

/** 对单条规则曲线 + 观测序列做穿越分析 */
export function analyzeRule(series: ObservedSeries, rule: RuleCurve, opts: AnalyzeOptions): RuleAnalysis {
  const issues: string[] = [];
  const pts = sortedCurvePoints(rule);
  const baseEvent: CrossingEvent = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    warningLevel: rule.warningLevel,
    metric: rule.metric,
    unit: rule.unit,
    curveSemantics: rule.curveSemantics,
    downstreamSafeFlow: rule.downstreamSafeFlow ?? null,
    window: [series.points[0]?.t ?? rule.validFrom, series.points[series.points.length - 1]?.t ?? rule.validFrom],
    firstCrossing: null,
    alreadyAboveAtStart: false,
    thresholdStepEvents: [],
    durationConfirmedSeconds: 0,
    durationPossibleSeconds: 0,
    peakExceedance: null,
    peakAt: null,
    bands: [],
    caveats: [],
    sampleCount: series.points.length,
  };
  if (pts.length === 0) {
    issues.push(`规则 ${rule.version} 无曲线点，无法比较阈值`);
    return { event: baseEvent, issues };
  }
  if (series.points.length < 2) {
    issues.push(`水库 ${series.reservoirId} 的${METRIC_LABEL[rule.metric]}序列不足 2 点，无法判断穿越`);
    return { event: baseEvent, issues };
  }

  const seriesStart = t(series.points[0].t).valueOf();
  const seriesEnd = t(series.points[series.points.length - 1].t).valueOf();
  const domainStart = t(pts[0].t).valueOf();
  const domainEnd = rule.curveSemantics === 'step' ? Number.POSITIVE_INFINITY : t(pts[pts.length - 1].t).valueOf();
  const validStart = t(rule.validFrom).valueOf();
  const validEnd = rule.validTo ? t(rule.validTo).valueOf() : Number.POSITIVE_INFINITY;
  const winStart = Math.max(seriesStart, domainStart, validStart);
  const winEnd = Math.min(seriesEnd, domainEnd, validEnd);
  if (winStart > winEnd) {
    issues.push(`规则 ${rule.version} 的有效期/曲线定义域与${METRIC_LABEL[rule.metric]}序列无交集`);
    return { event: baseEvent, issues };
  }

  const obs = series.points.filter((p) => {
    const ms = t(p.t).valueOf();
    return ms >= winStart && ms <= winEnd;
  });
  if (obs.length < 2) {
    issues.push(`规则 ${rule.version} 与序列的交集窗口内观测不足 2 点`);
    return { event: baseEvent, issues };
  }
  const obsTimes = obs.map((p) => p.t);
  const obsView: SeriesView = { times: obs.map((p) => t(p.t).valueOf()), values: obs.map((p) => p.value) };
  const medianSeconds = medianIntervalSeconds({ ...series, points: obs });
  const window: [string, string] = [obsTimes[0], obsTimes[obsTimes.length - 1]];
  const caveats = caveatsFor(series, rule, opts.mode, window, medianSeconds);
  const thrOf = (iso: string) => thresholdAt(rule, iso);

  // 观测点上的 g（用于峰值/敏感区间/阶跃事件/网格模式）
  const obsG = obs.map((p) => {
    const thr = thrOf(p.t);
    return { ms: t(p.t).valueOf(), iso: p.t, g: thr === null ? null : p.value - thr, thr, value: p.value };
  });
  if (obsG.some((x) => x.g === null)) {
    issues.push(`规则 ${rule.version} 在部分观测时刻超出曲线定义域，已跳过不可求值点`);
  }
  const validObsG = obsG.filter((x) => x.g !== null) as { ms: number; iso: string; g: number; thr: number; value: number }[];

  let alreadyAbove = false;
  let firstCrossing: FirstCrossing | null = null;
  let durationConfirmed = 0;
  let durationPossible = 0;

  if (opts.mode === 'grid') {
    if (validObsG.length === 0) {
      issues.push(`规则 ${rule.version} 在观测时刻均不可求阈值`);
      return { event: { ...baseEvent, caveats, window }, issues };
    }
    alreadyAbove = validObsG[0].g > 0;
    for (let i = 0; i < validObsG.length - 1; i += 1) {
      const a = validObsG[i];
      const b = validObsG[i + 1];
      const dt = (b.ms - a.ms) / 1000;
      if (a.g > 0 && b.g > 0) durationConfirmed += dt;
      if ((a.g > 0) !== (b.g > 0)) durationPossible += dt;
      if (!firstCrossing && !alreadyAbove && a.g <= 0 && b.g > 0) {
        const inducedBy = classifyInducedBy(b.value - a.value, b.thr - a.thr, rule.curveSemantics);
        firstCrossing = {
          mode: 'grid',
          interval: [a.iso, b.iso],
          prev: { t: a.iso, value: a.value, threshold: a.thr },
          next: { t: b.iso, value: b.value, threshold: b.thr },
          inducedBy,
          precision: {
            kind: 'interval',
            seconds: dt,
            note: `穿越只可确定落在观测格 [${short(a.iso)}, ${short(b.iso)}] 内（${Math.round(dt)}s），未作插值。`,
          },
        };
      }
    }
    durationPossible += durationConfirmed;
  } else {
    // ---- interpolated：在观测点与规则曲线点之间求 g(t)=0 的交点 ----
    const knots = new Set<number>();
    for (const p of obs) knots.add(t(p.t).valueOf());
    for (const p of pts) {
      const ms = t(p.t).valueOf();
      if (ms >= windowStartMs(window) && ms <= windowEndMs(window)) knots.add(ms);
    }
    const stamps: GPoint[] = [];
    const knotList = [...knots].sort((a, b) => a - b);
    for (const knotMs of knotList) {
      const value = valueAt(obsView, knotMs);
      if (value === null) continue;
      if (rule.curveSemantics === 'step') {
        const thrBefore = thresholdAt(rule, isoAt(knotMs - EPS_MS));
        const thrAfter = thresholdAt(rule, isoAt(knotMs + EPS_MS));
        if (thrBefore !== null) {
          stamps.push({ ms: knotMs - EPS_MS, iso: isoAt(knotMs - EPS_MS), g: value - thrBefore, thr: thrBefore, value, knotMs });
        }
        if (thrAfter !== null) {
          stamps.push({ ms: knotMs + EPS_MS, iso: isoAt(knotMs + EPS_MS), g: value - thrAfter, thr: thrAfter, value, knotMs });
        }
      } else {
        const thr = thresholdAt(rule, isoAt(knotMs));
        if (thr !== null) stamps.push({ ms: knotMs, iso: isoAt(knotMs), g: value - thr, thr, value, knotMs });
      }
    }
    if (stamps.length < 2) {
      issues.push(`规则 ${rule.version} 在交集窗口内可用求值点不足`);
      return { event: { ...baseEvent, caveats, window }, issues };
    }
    const candidates: CrossingCandidate[] = [];
    alreadyAbove = stamps[0].g > 0;
    for (let i = 0; i < stamps.length - 1; i += 1) {
      const a = stamps[i];
      const b = stamps[i + 1];
      const sameKnot = a.knotMs === b.knotMs;
      const dtSec = (b.ms - a.ms) / 1000;
      if (!sameKnot) {
        if (a.g > 0 && b.g > 0) {
          durationConfirmed += dtSec;
        } else if (a.g > 0 && b.g <= 0) {
          const frac = a.g === b.g ? 1 : a.g / (a.g - b.g);
          durationConfirmed += frac * dtSec;
        } else if (a.g <= 0 && b.g > 0) {
          const frac = -a.g / (b.g - a.g);
          durationConfirmed += (1 - frac) * dtSec;
        }
      }
      if (!firstCrossing && a.g <= 0 && b.g > 0) {
        const inducedBy = sameKnot
          ? 'threshold_step'
          : classifyInducedBy(b.value - a.value, b.thr - a.thr, rule.curveSemantics);
        let atMs: number;
        if (sameKnot) atMs = a.knotMs;
        else if (Math.abs(b.g - a.g) < TIME_EPS) atMs = a.ms;
        else atMs = a.ms + ((0 - a.g) / (b.g - a.g)) * (b.ms - a.ms);
        candidates.push({ atMs, prev: a, next: b, inducedBy });
      }
    }
    if (candidates.length > 0) {
      const c = candidates[0];
      firstCrossing = {
        mode: 'interpolated',
        at: isoAt(c.atMs),
        prev: { t: c.prev.iso, value: c.prev.value, threshold: c.prev.thr },
        next: { t: c.next.iso, value: c.next.value, threshold: c.next.thr },
        inducedBy: c.inducedBy,
        precision: {
          kind: 'point',
          seconds: Math.round(medianSeconds),
          note:
            c.inducedBy === 'threshold_step'
              ? '穿越由规则阈值阶跃造成，时刻即曲线点时刻；观测本身可能并未变化。'
              : `由相邻观测/曲线点线性插值求得交点，中位采样间隔 ${Math.round(medianSeconds)}s；陡变或闸门操作时段仅作参考。`,
        },
      };
    }
    durationPossible = durationConfirmed;
  }

  // ---- 规则阈值阶跃事件（step 语义） ----
  const stepEvents: ThresholdStepEvent[] = [];
  if (rule.curveSemantics === 'step') {
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i];
      const ms = t(p.t).valueOf();
      if (ms < windowStartMs(window) || ms > windowEndMs(window)) continue;
      const thrBefore = thresholdAt(rule, isoAt(ms - EPS_MS));
      const thrAfter = thresholdAt(rule, isoAt(ms + EPS_MS));
      if (thrBefore === null || thrAfter === null || Math.abs(thrAfter - thrBefore) < TIME_EPS) continue;
      // 网格模式取阶跃时刻之前最近观测（保持前值，保守）；插值模式取插值值
      let value: number | null;
      if (opts.mode === 'grid') {
        const before = validObsG.filter((x) => x.ms <= ms);
        value = before.length > 0 ? before[before.length - 1].value : null;
      } else {
        value = valueAt(obsView, ms);
      }
      if (value === null) continue;
      const gBefore = value - thrBefore;
      const gAfter = value - thrAfter;
      // 阶跃使观测相对阈值翻转：below -> above 为向上越线
      const effect: ThresholdStepEvent['effect'] =
        gBefore <= 0 && gAfter > 0
          ? 'flip_below_to_above'
          : gBefore > 0 && gAfter <= 0
            ? 'flip_above_to_below'
            : 'none';
      stepEvents.push({
        at: isoAt(ms),
        fromThreshold: thrBefore,
        toThreshold: thrAfter,
        value,
        effect,
      });
    }
  }

  // ---- 峰值越线幅度与接近阈值时间带 ----
  let peak: number | null = null;
  let peakAt: string | null = null;
  for (const x of validObsG) {
    if (x.g > (peak ?? 0)) {
      peak = x.g;
      peakAt = x.iso;
    }
  }
  if (peak !== null && peak <= 0) {
    peak = null;
    peakAt = null;
  }
  const bands = makeBands(
    validObsG.map((x) => ({ ms: x.ms, g: x.g, thr: x.thr, value: x.value })),
    validObsG.map((x) => x.iso),
    opts.margin,
  );

  if (!firstCrossing && !alreadyAbove) {
    issues.push(`规则 ${rule.version}（${WARNING_LEVEL_LABEL[rule.warningLevel]}）在窗口内未被向上穿越`);
  }
  if (alreadyAbove) {
    caveats.push('窗口起点观测已高于该规则阈值，首次越线可能早于观测窗口，无法据此确定首次穿越时刻。');
  }

  const event: CrossingEvent = {
    ...baseEvent,
    window,
    firstCrossing,
    alreadyAboveAtStart: alreadyAbove,
    thresholdStepEvents: stepEvents,
    durationConfirmedSeconds: Math.round(durationConfirmed),
    durationPossibleSeconds: Math.round(durationPossible),
    peakExceedance: peak,
    peakAt,
    bands,
    caveats,
    sampleCount: obs.length,
  };
  return { event, issues };
}

function windowStartMs(w: [string, string]): number {
  return t(w[0]).valueOf();
}
function windowEndMs(w: [string, string]): number {
  return t(w[1]).valueOf();
}
function short(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// 情景求解与差异归因
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  margin: number;
}

export interface ScenarioAnalysis {
  metrics: ScenarioMetrics;
  events: CrossingEvent[];
  issues: string[];
}

export function analyzeScenario(input: CrossingScenarioInput, opts: ScenarioOptions): ScenarioAnalysis {
  const issues: string[] = [];
  const empty: ScenarioMetrics = {
    label: input.label,
    mode: input.mode,
    firstCrossingAt: null,
    firstCrossingInterval: null,
    durationConfirmedSeconds: 0,
    durationPossibleSeconds: 0,
    peakExceedance: null,
    downstreamSafeFlow: null,
    ruleIds: [],
  };
  if (input.rules.length === 0) {
    issues.push(`情景「${input.label}」未绑定规则曲线`);
    return { metrics: empty, events: [], issues };
  }
  if (input.rules.length > 1) {
    issues.push(
      `情景「${input.label}」绑定了 ${input.rules.length} 条同等级规则（${input.rules.map((r) => r.version).join('、')}），有效期/适用范围重叠时不自动选取，请显式指定一条。`,
    );
    return { metrics: empty, events: [], issues };
  }
  const rule = input.rules[0];
  const { event, issues: ruleIssues } = analyzeRule(input.series, rule, { mode: input.mode, margin: opts.margin });
  issues.push(...ruleIssues);
  const metrics: ScenarioMetrics = {
    label: input.label,
    mode: input.mode,
    firstCrossingAt: event.firstCrossing?.at ?? null,
    firstCrossingInterval: event.firstCrossing?.interval ?? null,
    durationConfirmedSeconds: event.durationConfirmedSeconds,
    durationPossibleSeconds: event.durationPossibleSeconds,
    peakExceedance: event.peakExceedance,
    downstreamSafeFlow: rule.downstreamSafeFlow ?? null,
    ruleIds: [rule.id],
  };
  return { metrics, events: [event], issues };
}

function seriesSignature(series: ObservedSeries): string {
  return JSON.stringify({
    kind: series.sourceKind,
    variant: series.variant,
    points: series.points.map((p) => [p.t, p.value]),
  });
}

function ruleSignature(rules: RuleCurve[]): string {
  return JSON.stringify(
    rules.map((r) => ({
      id: r.id,
      version: r.version,
      level: r.warningLevel,
      metric: r.metric,
      semantics: r.curveSemantics,
      points: sortedCurvePoints(r).map((p) => [p.t, p.threshold]),
      safe: r.downstreamSafeFlow ?? null,
      status: r.approvalStatus,
    })),
  );
}

function metricsSignature(m: ScenarioMetrics): string {
  return JSON.stringify({
    at: m.firstCrossingAt,
    interval: m.firstCrossingInterval,
    durC: m.durationConfirmedSeconds,
    durP: m.durationPossibleSeconds,
    peak: m.peakExceedance,
    safe: m.downstreamSafeFlow,
  });
}

function firstCrossingSeconds(m: ScenarioMetrics): number | null {
  if (m.firstCrossingAt) return t(m.firstCrossingAt).valueOf() / 1000;
  if (m.firstCrossingInterval) return t(m.firstCrossingInterval[0]).valueOf() / 1000;
  return null;
}

export interface ComparisonInput {
  a: { spec: CrossingScenarioInput; series: ObservedSeries; rules: RuleCurve[] };
  b: { spec: CrossingScenarioInput; series: ObservedSeries; rules: RuleCurve[] };
  margin: number;
}

export function compareScenarios(input: ComparisonInput): { comparison: CrossingComparison; a: ScenarioAnalysis; b: ScenarioAnalysis } {
  const a = analyzeScenario({ ...input.a.spec, series: input.a.series, rules: input.a.rules }, { margin: input.margin });
  const b = analyzeScenario({ ...input.b.spec, series: input.b.series, rules: input.b.rules }, { margin: input.margin });
  const comparable = input.a.spec.mode === input.b.spec.mode;

  const fact = comparable
    ? analyzeScenario(
        { ...input.a.spec, label: `${input.b.spec.label}观测 + ${input.a.spec.label}规则`, series: input.b.series, rules: input.a.rules },
        { margin: input.margin },
      )
    : null;
  const rule = comparable
    ? analyzeScenario(
        { ...input.b.spec, label: `${input.a.spec.label}观测 + ${input.b.spec.label}规则`, series: input.a.series, rules: input.b.rules },
        { margin: input.margin },
      )
    : null;

  const aSec = firstCrossingSeconds(a.metrics);
  const bSec = firstCrossingSeconds(b.metrics);
  // 时间与持续时长在两种模式下语义不同（点估计 vs 区间/确认值），不可相减；
  // 峰值幅度基于同一观测采样，下游安全流量是规则属性，仍可比较。
  const deltas: CrossingComparison['deltas'] = {
    firstCrossingSeconds: comparable && aSec !== null && bSec !== null ? Math.round(bSec - aSec) : null,
    durationConfirmedSeconds: comparable ? b.metrics.durationConfirmedSeconds - a.metrics.durationConfirmedSeconds : 0,
    durationPossibleSeconds: comparable ? b.metrics.durationPossibleSeconds - a.metrics.durationPossibleSeconds : 0,
    peakExceedance:
      a.metrics.peakExceedance !== null && b.metrics.peakExceedance !== null
        ? b.metrics.peakExceedance - a.metrics.peakExceedance
        : null,
    downstreamSafeMin:
      a.metrics.downstreamSafeFlow && b.metrics.downstreamSafeFlow
        ? b.metrics.downstreamSafeFlow[0] - a.metrics.downstreamSafeFlow[0]
        : null,
    downstreamSafeMax:
      a.metrics.downstreamSafeFlow && b.metrics.downstreamSafeFlow
        ? b.metrics.downstreamSafeFlow[1] - a.metrics.downstreamSafeFlow[1]
        : null,
  };

  let attribution: CrossingAttribution = 'indeterminate';
  let explanation = '';

  if (!comparable) {
    explanation =
      '两情景判定模式不同（interpolated 给出点时刻，grid 给出时间区间），语义不可直接相减，因此不做事实/阈值归因；请在同一模式下比较，或只并排核对时间精度。';
  } else if (a.metrics.ruleIds.length !== 1 || b.metrics.ruleIds.length !== 1) {
    attribution = 'indeterminate';
    explanation = `归因需要每个情景恰好一条规则；当前未满足：${[...a.issues, ...b.issues].join('；') || '规则未绑定。'}`;
  } else {
    const sameSeries = seriesSignature(input.a.series) === seriesSignature(input.b.series);
    const sameRules = ruleSignature(input.a.rules) === ruleSignature(input.b.rules);
    const outputDiff = metricsSignature(a.metrics) !== metricsSignature(b.metrics);
    const factChanged = fact !== null && metricsSignature(fact.metrics) !== metricsSignature(a.metrics);
    const ruleChanged = rule !== null && metricsSignature(rule.metrics) !== metricsSignature(a.metrics);

    if (!outputDiff) {
      attribution = 'no_difference';
      explanation = '两情景的首次越线时间、持续时长、越线幅度与下游安全流量范围一致，未检出差异。';
    } else if (sameRules && !sameSeries) {
      attribution = 'fact_change';
      explanation =
        '两情景绑定同一规则版本，仅观测序列不同；差异来自事实变化（观测值/采样点变化），不是阈值定义。' +
        describeCounterfactual(fact, 'fact') ;
    } else if (!sameRules && sameSeries) {
      attribution = 'threshold_definition';
      explanation =
        '两情景观测序列相同，仅绑定的规则/等级不同；差异来自阈值定义（含规则曲线、等级与下游安全流量），不是事实变化。' +
        describeCounterfactual(rule, 'rule');
    } else if (!sameRules && !sameSeries) {
      if (factChanged && ruleChanged) {
        attribution = 'mixed';
        explanation =
          '观测与规则同时不同，且两种替换各自都会改变结论：' +
          describeCounterfactual(fact, 'fact') +
          describeCounterfactual(rule, 'rule');
      } else if (factChanged) {
        attribution = 'fact_change';
        explanation = '观测与规则虽同时不同，但换用 B 的规则不改变结论，差异归因于事实变化。' + describeCounterfactual(fact, 'fact');
      } else if (ruleChanged) {
        attribution = 'threshold_definition';
        explanation = '观测与规则虽同时不同，但换用 B 的观测不改变结论，差异归因于阈值定义。' + describeCounterfactual(rule, 'rule');
      } else {
        attribution = 'no_difference';
        explanation = '观测与规则同时不同，但两种变化对结论的影响相互抵消（反事实替换均不改变结论）。';
      }
    } else {
      attribution = 'no_difference';
      explanation = '两情景的规则与观测签名一致。';
    }
  }

  const comparison: CrossingComparison = {
    aLabel: input.a.spec.label,
    bLabel: input.b.spec.label,
    modeA: input.a.spec.mode,
    modeB: input.b.spec.mode,
    comparable,
    a: a.metrics,
    b: b.metrics,
    counterfactual: {
      fact: fact?.metrics ?? null,
      rule: rule?.metrics ?? null,
    },
    deltas,
    attribution,
    explanation,
  };
  return { comparison, a, b };
}

function describeCounterfactual(analysis: ScenarioAnalysis | null, kind: 'fact' | 'rule'): string {
  if (!analysis) return '';
  const m = analysis.metrics;
  const at = m.firstCrossingAt
    ? `首次越线 ${short(m.firstCrossingAt)}`
    : m.firstCrossingInterval
      ? `首次越线落在 [${short(m.firstCrossingInterval[0])}, ${short(m.firstCrossingInterval[1])}]`
      : '窗口内未向上越线';
  return `（反事实${kind === 'fact' ? '：B 的观测套用 A 的规则' : '：A 的观测套用 B 的规则'} → ${at}，越线时长 ${m.durationConfirmedSeconds}s，峰值幅度 ${m.peakExceedance === null ? '—' : m.peakExceedance.toFixed(3)}）`;
}

// ---------------------------------------------------------------------------
// 模式建议与发布记录
// ---------------------------------------------------------------------------

export interface ModeAdvice {
  mode: CrossingMode;
  reason: string;
  medianSeconds: number;
  lowFrequency: boolean;
  hasStepCurve: boolean;
  gateOpCount: number;
}

/**
 * 选择依据（不预设连续插值更正确）：观测密度、规则曲线连续性、指令是否依赖精确时刻。
 * 低频观测优先 grid；阶梯曲线默认 grid（保守），若确实需要精确时刻可在 UI 主动切换并保留 caveat。
 */
export function adviseCrossingMode(series: ObservedSeries, rules: RuleCurve[]): ModeAdvice {
  const medianSeconds = medianIntervalSeconds(series);
  const lowFrequency = series.nominalStepSeconds > 0 && medianSeconds > series.nominalStepSeconds * 1.5;
  const hasStepCurve = rules.some((r) => r.curveSemantics === 'step');
  const gateOpCount = series.gateOps.length;
  if (series.points.length < 2) {
    return { mode: 'grid', reason: '观测不足 2 点，无法插值，只能使用保守网格判定', medianSeconds, lowFrequency, hasStepCurve, gateOpCount };
  }
  if (lowFrequency) {
    return {
      mode: 'grid',
      reason: `观测低频（中位 ${Math.round(medianSeconds)}s，名义步长 ${series.nominalStepSeconds}s），插值交点可能偏离实际，建议观测格区间判定`,
      medianSeconds,
      lowFrequency,
      hasStepCurve,
      gateOpCount,
    };
  }
  if (hasStepCurve) {
    return {
      mode: 'grid',
      reason: '规则为阶梯曲线，阶跃时刻可精确回查；若调度指令依赖精确穿越时刻，可切换连续插值并核对 caveat',
      medianSeconds,
      lowFrequency,
      hasStepCurve,
      gateOpCount,
    };
  }
  if (gateOpCount > 0) {
    return {
      mode: 'grid',
      reason: `窗口内含 ${gateOpCount} 条闸门操作/指令，观测可能非平滑跃变；若确认闸门期间观测仍连续，可用连续插值并声明可信性`,
      medianSeconds,
      lowFrequency,
      hasStepCurve,
      gateOpCount,
    };
  }
  return {
    mode: 'interpolated',
    reason: `观测足够密（中位 ${Math.round(medianSeconds)}s）且规则曲线连续，可在相邻观测间求交点获得精确穿越时刻`,
    medianSeconds,
    lowFrequency,
    hasStepCurve,
    gateOpCount,
  };
}

/** 发布分析记录：冻结观测序列与规则引用（深拷贝），撤回审批不改变已发布记录 */
export function freezeAnalysisRecord(params: {
  runId?: string;
  reservoirId: string;
  basinId?: string;
  series: ObservedSeries;
  rules: RuleCurve[];
  mode: CrossingMode;
  events: CrossingEvent[];
  issues: string[];
  comparison?: CrossingComparison;
  note?: string;
  now: string;
}): CrossingAnalysisRecord {
  const seriesSnapshot: ObservedSeries = JSON.parse(JSON.stringify(params.series));
  const ruleBindings: RuleCurve[] = JSON.parse(JSON.stringify(params.rules));
  const anyDraft = ruleBindings.some((r) => r.approvalStatus === 'draft');
  const anyRetired = ruleBindings.some((r) => r.approvalStatus === 'retired');
  const blocked = ruleBindings.length === 0 || params.events.length === 0;
  const status: CrossingAnalysisRecord['status'] = blocked
    ? 'blocked'
    : anyDraft
      ? 'draft_bound'
      : anyRetired
        ? 'needs_confirmation'
        : params.issues.length > 0
          ? 'needs_confirmation'
          : 'ok';
  return {
    id: `xing-${params.now.replace(/[:.]/g, '-')}`,
    createdAt: params.now,
    runId: params.runId,
    reservoirId: params.reservoirId,
    basinId: params.basinId,
    seriesId: seriesSnapshot.id,
    mode: params.mode,
    seriesSnapshot,
    ruleBindings,
    events: JSON.parse(JSON.stringify(params.events)),
    issues: [...params.issues],
    status,
    comparison: params.comparison ? JSON.parse(JSON.stringify(params.comparison)) : undefined,
    note: params.note,
  };
}

/** 当前规则目录与冻结绑定相比是否已撤回/变更 */
export function bindingDrift(record: CrossingAnalysisRecord, current: RuleCurve[]): string[] {
  const out: string[] = [];
  for (const frozen of record.ruleBindings) {
    const now = current.find((r) => r.id === frozen.id);
    if (!now) {
      out.push(`规则 ${frozen.version} 已从目录移除，已发布记录仍保留当时引用`);
      continue;
    }
    if (now.approvalStatus !== frozen.approvalStatus) {
      out.push(
        `规则 ${frozen.version} 当前审批状态为 ${now.approvalStatus}（记录冻结时为 ${frozen.approvalStatus}），已发布结论不回改；新建比较请绑定新版本`,
      );
    }
    if (JSON.stringify(sortedCurvePoints(now)) !== JSON.stringify(sortedCurvePoints(frozen))) {
      out.push(`规则 ${frozen.version} 曲线点已被修改（同一 ID），已发布记录保留冻结版本，新建比较另建版本`);
    }
  }
  return out;
}

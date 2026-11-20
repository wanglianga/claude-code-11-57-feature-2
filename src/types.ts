// 领域类型定义：所有时间统一使用 UTC ISO8601 字符串，内部计算单位统一为
// 水量 m³、流量 m³/s、水位 m、面积 m²、雨量/蒸发 mm。

export type ID = string;
export type ISOTime = string;

/** 质量标志：confirmed 已确认；estimated 估算可用；suspect 可疑；missing 显式缺失；rejected 作废 */
export type QualityFlag = 'confirmed' | 'estimated' | 'suspect' | 'missing' | 'rejected';

export type ReadingKind =
  | 'rainfall' // 雨量（区间累计，mm）
  | 'water_level' // 库水位（m）
  | 'inflow' // 入库流量（m³/s）
  | 'outflow' // 出库流量（m³/s）
  | 'gate_opening' // 闸门开度
  | 'gate_order' // 闸门指令
  | 'evaporation' // 蒸发（区间累计，mm）
  | 'diversion_in' // 跨库调入（m³/s）
  | 'diversion_out'; // 跨库调出（m³/s）

export interface RawReading {
  id: ID;
  reservoirId?: ID;
  stationId?: ID;
  zoneId?: ID;
  kind: ReadingKind;
  /** 采样时间；区间累计类为区间结束时刻 */
  sampledAt: ISOTime;
  /** 接收时间：迟到判定与资料截止点过滤依据 */
  receivedAt: ISOTime;
  /** 区间累计类（雨量/蒸发）的区间起点 */
  intervalStart?: ISOTime;
  /** 显式缺失记为 null，绝不以 0 补齐 */
  value: number | null;
  unit: string;
  quality: QualityFlag;
  sourceFile: string;
  /** 修订关系：本读数修订哪一条原始读数 */
  revisionOf?: ID;
  /** 被哪一条修订替代（物化在被替代记录上） */
  supersededById?: ID;
  /** 仪器额定不确定度（同 unit），缺失时用于未知范围估算 */
  uncertainty?: number;
  note?: string;
  createdAt: ISOTime;
}

export interface RainZone {
  id: ID;
  name: string;
}

export interface RainStation {
  id: ID;
  name: ID;
  zoneId: ID;
  lon: number;
  lat: number;
}

export interface Reservoir {
  id: ID;
  name: string;
  lon: number;
  lat: number;
  /** 所属流域（预警规则曲线按流域 + 水库匹配） */
  basinId?: ID;
  /** 面雨量分区权重，权重之和应为 1 */
  rainWeights: { zoneId: ID; weight: number }[];
}

export type CurveKind = 'storage' | 'area';
export type ApprovalStatus = 'draft' | 'approved' | 'retired';

export interface CurvePoint {
  x: number; // 水位 m
  y: number; // storage: 蓄水量（按 storageUnit）；area: 库面面积（按 areaUnit）
}

export interface CurveVersion {
  id: ID;
  reservoirId: ID;
  kind: CurveKind;
  version: string;
  validFrom: ISOTime;
  validTo?: ISOTime; // 空表示至今
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  points: CurvePoint[];
  /** storage 曲线点单位：m3 或 万m3；area 曲线点单位：m2 或 km2 */
  pointUnit: 'm3' | 'wan_m3' | 'm2' | 'km2';
  note?: string;
}

export interface DispatchRule {
  id: ID;
  reservoirId: ID;
  version: string;
  validFrom: ISOTime;
  validTo?: ISOTime;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  /** 汛限库容 m³ */
  floodLimitStorage: number;
  /** 规则目标库容 m³（泄洪空间回算目标） */
  targetStorage: number;
  /** 下游允许泄流范围 m³/s */
  downstreamMinRelease: number;
  downstreamMaxRelease: number;
  note?: string;
}

// ---------- 预警规则曲线与越线分析 ----------

/** 预警级别：蓝/黄/橙/红。等级切换时规则曲线与下游安全流量可以不同。 */
export type WarningLevel = 'blue' | 'yellow' | 'orange' | 'red';

/** 规则曲线指标：水位规则线或流量规则线 */
export type RuleMetric = 'water_level' | 'flow';

/** 规则曲线在各点之间的含义：线性连接，或阶梯（到下一时点前保持前值） */
export type RuleCurveSemantics = 'linear' | 'step';

export interface RuleCurvePoint {
  /** 规则点生效时刻 */
  t: ISOTime;
  /** 该时刻起（或插值到该时刻）的阈值（水位 m 或流量 m³/s） */
  threshold: number;
}

/**
 * 预警规则曲线：按流域保存、可带水库限定、按等级、有效期与审批状态治理。
 * 规则有效期重叠时不自动选取，由分析显式绑定。
 */
export interface RuleCurve {
  id: ID;
  basinId: ID;
  basinName: string;
  /** 为空表示流域级规则；否则只适用于该水库 */
  reservoirId?: ID;
  warningLevel: WarningLevel;
  version: string;
  metric: RuleMetric;
  /** 阈值单位：water_level -> m；flow -> m3/s */
  unit: string;
  validFrom: ISOTime;
  validTo?: ISOTime;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: ISOTime;
  /** 审批撤回时间：撤回后已发布运行/比较仍保留其当时引用 */
  retiredAt?: ISOTime;
  /** 阈值随时间变化的曲线点（时间升序，引擎内会再次排序） */
  curvePoints: RuleCurvePoint[];
  curveSemantics: RuleCurveSemantics;
  /** 该等级对应的下游安全流量范围 m³/s */
  downstreamSafeFlow?: [number, number] | null;
  note?: string;
}

/** 连续观测序列点（来自运行锁定快照，不含显式缺失/作废） */
export interface SeriesPoint {
  t: ISOTime;
  value: number;
  readingId?: ID;
  quality?: QualityFlag;
}

/** 指标运行保存的连续水位/流量序列 */
export interface ObservedSeries {
  id: ID;
  runId?: ID;
  reservoirId: ID;
  metric: RuleMetric;
  /** 原始读数类型：water_level / inflow / outflow */
  sourceKind: 'water_level' | 'inflow' | 'outflow';
  unit: string;
  /** 名义采样步长（秒），用于低频与缺口判断 */
  nominalStepSeconds: number;
  points: SeriesPoint[];
  /** 序列时段内的闸门操作/指令时刻（插值可信性声明依据） */
  gateOps: ISOTime[];
  /** base=含可疑/估算读数；strict=剔除可疑/估算 */
  variant: 'base' | 'strict';
  suspectCount: number;
  excludedCount: number;
  builtAt: ISOTime;
}

export type CrossingMode = 'interpolated' | 'grid';

export interface CrossingPoint {
  t: ISOTime;
  value: number;
  threshold: number;
}

/** 接近阈值的时间带：观测值距规则线不超过给定裕度 */
export interface NearThresholdBand {
  start: ISOTime;
  end: ISOTime;
  /** 带内观测值与阈值的最小间距（跨线时为 0） */
  minGap: number;
  side: 'below' | 'above' | 'straddles';
}

export interface ThresholdStepEvent {
  at: ISOTime;
  fromThreshold: number;
  toThreshold: number;
  value: number;
  effect: 'flip_above_to_below' | 'flip_below_to_above' | 'none';
}

export interface FirstCrossing {
  mode: CrossingMode;
  /** 连续插值模式：精确（受采样与插值假设约束）的穿越时刻 */
  at?: ISOTime;
  /** 观测格模式：穿越发生的保守区间 [前观测, 后观测] */
  interval?: [ISOTime, ISOTime];
  /** 零线穿越前后的观测/阈值证据 */
  prev: CrossingPoint;
  next: CrossingPoint;
  /** 穿越由观测值变化、阈值阶跃还是阈值连续移动造成 */
  inducedBy: 'observation' | 'threshold_step' | 'threshold_trend';
  /** 时间精度声明 */
  precision: {
    kind: 'point' | 'interval';
    seconds: number;
    note: string;
  };
}

export interface CrossingEvent {
  ruleId: ID;
  ruleVersion: string;
  warningLevel: WarningLevel;
  metric: RuleMetric;
  unit: string;
  curveSemantics: RuleCurveSemantics;
  downstreamSafeFlow: [number, number] | null;
  /** 分析适用窗口（序列与规则有效期交集） */
  window: [ISOTime, ISOTime];
  /** 首次向上越线；为 null 时见 caveats/issues（如未越线或起点已在阈值以上） */
  firstCrossing: FirstCrossing | null;
  /** 序列起点已高于阈值（首次越线早于观测窗口） */
  alreadyAboveAtStart: boolean;
  /** 规则阈值阶跃导致的穿越/翻转（与观测变化区分） */
  thresholdStepEvents: ThresholdStepEvent[];
  /** 高于阈值的持续时长：grid=完全越线格（确认），interpolated=估计 */
  durationConfirmedSeconds: number;
  /** 持续时长上限：grid=确认格+跨界格；interpolated=估计值 */
  durationPossibleSeconds: number;
  /** 越线幅度（观测值 − 阈值）的最大值 */
  peakExceedance: number | null;
  peakAt: ISOTime | null;
  bands: NearThresholdBand[];
  caveats: string[];
  sampleCount: number;
}

export interface RuleCandidateGroup {
  warningLevel: WarningLevel;
  approved: RuleCurve[];
  drafts: RuleCurve[];
  retired: RuleCurve[];
  /** 已审批规则适用期重叠：不自动选取 */
  overlapApproved: boolean;
}

export interface ScenarioMetrics {
  label: string;
  mode: CrossingMode;
  firstCrossingAt: ISOTime | null;
  firstCrossingInterval: [ISOTime, ISOTime] | null;
  durationConfirmedSeconds: number;
  durationPossibleSeconds: number;
  peakExceedance: number | null;
  downstreamSafeFlow: [number, number] | null;
  ruleIds: ID[];
}

export type CrossingAttribution =
  | 'threshold_definition'
  | 'fact_change'
  | 'mixed'
  | 'no_difference'
  | 'indeterminate';

export interface CrossingScenarioInput {
  label: string;
  mode: CrossingMode;
  series: ObservedSeries;
  rules: RuleCurve[];
}

export interface CrossingComparison {
  aLabel: string;
  bLabel: string;
  modeA: CrossingMode;
  modeB: CrossingMode;
  /** 两种模式不能直接做归因（语义不同），仅并排展示时间精度 */
  comparable: boolean;
  a: ScenarioMetrics;
  b: ScenarioMetrics;
  /** 反事实：在 A 的观测序列上换用 B 的规则 / 在 A 的规则上换用 B 的观测 */
  counterfactual: {
    fact: ScenarioMetrics | null;
    rule: ScenarioMetrics | null;
  };
  deltas: {
    firstCrossingSeconds: number | null;
    durationConfirmedSeconds: number;
    durationPossibleSeconds: number;
    peakExceedance: number | null;
    downstreamSafeMin: number | null;
    downstreamSafeMax: number | null;
  };
  attribution: CrossingAttribution;
  explanation: string;
}

export interface CrossingAnalysisRecord {
  id: ID;
  createdAt: ISOTime;
  runId?: ID;
  reservoirId: ID;
  basinId?: ID;
  seriesId: ID;
  mode: CrossingMode;
  /** 冻结的观测序列：发布后不随原始文件修订而变 */
  seriesSnapshot: ObservedSeries;
  /** 冻结的规则引用（深拷贝）：审批撤回后仍保留当时版本与状态 */
  ruleBindings: RuleCurve[];
  events: CrossingEvent[];
  issues: string[];
  status: 'ok' | 'needs_confirmation' | 'draft_bound' | 'blocked';
  comparison?: CrossingComparison;
  note?: string;
}

export type RunStatus = 'running' | 'completed' | 'completed_with_warnings' | 'failed';
export type RunDesign = 'materialized' | 'on_demand';

export interface RunTolerance {
  /** 绝对容差 m³ */
  absM3: number;
  /** 相对容差（占蓄变与各项绝对值均值的比例） */
  relFraction: number;
}

export interface BalanceRun {
  id: ID;
  name: string;
  /** 资料截止点：仅纳入 receivedAt <= cutoff 的读数 */
  cutoffAt: ISOTime;
  gridStart: ISOTime;
  gridEnd: ISOTime;
  /** 时间网格步长（秒） */
  gridStepSeconds: number;
  tolerance: RunTolerance;
  /** 近期来水压力窗口（秒） */
  pressureWindowSeconds: number;
  /** 下一决策时点距离（秒） */
  decisionHorizonSeconds: number;
  reservoirIds: ID[];
  status: RunStatus;
  design: RunDesign;
  createdAt: ISOTime;
  finishedAt?: ISOTime;
  warnings: string[];
  stats?: { factCount: number; pendingCount: number; unclosedCount: number };
}

/** 运行输入快照：运行时固定的一组来源、曲线版本、规则，保证可复算 */
export interface RunSnapshot {
  runId: ID;
  readings: RawReading[];
  curves: CurveVersion[];
  rules: DispatchRule[];
  /** 预警规则曲线也随运行冻结，供越线分析回查 */
  ruleCurves?: RuleCurve[];
  reservoirs: Reservoir[];
  zones: RainZone[];
  frozenAt: ISOTime;
}

export interface BalanceTerm {
  key: 'inflow' | 'outflow' | 'rainfall' | 'evaporation' | 'transferIn' | 'transferOut';
  label: string;
  /** 折算出的区间水量 m³；覆盖不足为 null */
  valueM3: number | null;
  covered: boolean;
  sourceReadingIds: ID[];
  /** 该项未知量的可能范围 m³（仅未覆盖/可疑时非零） */
  unknownRangeM3: [number, number];
  detail?: string;
}

export interface BalanceFact {
  id: ID;
  runId: ID;
  reservoirId: ID;
  t1: ISOTime;
  t2: ISOTime;
  durationSeconds: number;
  s1: number | null;
  s2: number | null;
  storageCurveIdAtT1?: ID;
  storageCurveIdAtT2?: ID;
  areaCurveId?: ID;
  curveSwitched: boolean;
  terms: BalanceTerm[];
  /** ΔS = S2-S1 m³ */
  deltaS: number | null;
  /** 可确认平衡项合计（方程括号内部分），m³ */
  confirmedNet: number | null;
  /** 残差 R = ΔS - 平衡项合计；任一关键项未覆盖则为 null */
  residual: number | null;
  closed: boolean;
  toleranceM3: number;
  unclosedReasons: string[];
  /** 整个区间未知量的可能范围 m³ */
  unknownRangeM3: [number, number];
}

export type IndicatorStatus = 'ok' | 'warn' | 'pending';

export interface ReservoirIndicator {
  id: ID;
  runId: ID;
  reservoirId: ID;
  asOf: ISOTime;
  currentStorage: number | null;
  floodLimitStorage: number | null;
  ruleId?: ID;
  /** 防洪余量 = 汛限库容 - 已确认蓄水量 m³ */
  floodMargin: number | null;
  marginStatus: IndicatorStatus;
  windowSeconds: number;
  /** 窗口内可确认净入库量 m³ */
  netInflowConfirmed: number | null;
  /** 净入库未知范围 m³ */
  netInflowUnknownRange: [number, number] | null;
  /** 来水压力比 = 可确认净入库 / 防洪余量 */
  pressureRatio: number | null;
  /** 计入未知范围后的压力比区间 */
  pressureRatioRange: [number | null, number | null];
  /** 回到目标库容所需出库流量范围 m³/s */
  releaseNeededRange: [number | null, number | null] | null;
  downstreamAllowableRange: [number, number] | null;
  /** 所需出库与下游允许范围的差额 m³/s（正值表示允许泄流不足） */
  releaseGapRange: [number | null, number | null] | null;
  pending: boolean;
  pendingReasons: string[];
  factIds: ID[];
}

export interface AnnotationField {
  field: string;
  author: string;
  value: string;
  updatedAt: ISOTime;
}

export interface Annotation {
  id: ID;
  subjectType: 'indicator' | 'fact' | 'reading' | 'rule' | 'curve';
  subjectId: ID;
  /** 字段级批注：两个页面并发修改不同字段时各自保留，不做整单覆盖 */
  fields: Record<string, AnnotationField>;
  revision: number;
  updatedAt: ISOTime;
}

export interface SourceFileRecord {
  id: ID;
  fileName: string;
  kind: ReadingKind | 'mixed';
  importedAt: ISOTime;
  readingCount: number;
  byteSize: number;
  note?: string;
}

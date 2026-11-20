import { useEffect, useState } from 'react';
import {
  getAllCurves, getAllReservoirs, getAllRuleCurves, getAllRules, putCurve, putRule, putRuleCurve,
} from '../db';
import { ApprovalPill } from '../components/Pills';
import { formatHuman } from '../lib/time';
import { WARNING_LEVEL_LABEL, sortedCurvePoints } from '../lib/crossings';
import { useAppState } from '../appState';
import type { ApprovalStatus, CurveVersion, DispatchRule, RuleCurve } from '../types';

function overlapRanges(items: { validFrom: string; validTo?: string; label: string }[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const aEnd = a.validTo ? Date.parse(a.validTo) : Number.POSITIVE_INFINITY;
      const bEnd = b.validTo ? Date.parse(b.validTo) : Number.POSITIVE_INFINITY;
      if (Date.parse(a.validFrom) < bEnd && Date.parse(b.validFrom) < aEnd) {
        issues.push(`${a.label} ⚔ ${b.label} 适用期重叠`);
      }
    }
  }
  return issues;
}

export default function CatalogPage() {
  const { dataVersion, bumpData } = useAppState();
  const [curves, setCurves] = useState<CurveVersion[]>([]);
  const [rules, setRules] = useState<DispatchRule[]>([]);
  const [ruleCurves, setRuleCurves] = useState<RuleCurve[]>([]);
  const [reservoirNames, setReservoirNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'curve' | 'rule' | 'warning'>('curve');

  const refresh = async () => {
    const [cs, rs, rcs, reservoirs] = await Promise.all([
      getAllCurves(), getAllRules(), getAllRuleCurves(), getAllReservoirs(),
    ]);
    setCurves(cs);
    setRules(rs);
    setRuleCurves(rcs);
    setReservoirNames(Object.fromEntries(reservoirs.map((x) => [x.id, x.name])));
  };
  useEffect(() => { void refresh(); }, [dataVersion]);

  // 目录治理检查
  const curveIssues: string[] = [];
  for (const c of curves) {
    if (c.approvalStatus !== 'approved') curveIssues.push(`${c.id}（${c.version}）为${c.approvalStatus}状态，运行换算将判无效`);
    if (c.points.length < 2) curveIssues.push(`${c.id} 点数不足 2，无法插值`);
    if (c.validTo && Date.parse(c.validTo) <= Date.parse(c.validFrom)) curveIssues.push(`${c.id} 有效期起止倒置`);
  }
  const ruleIssues: string[] = [];
  for (const rid of Object.keys(reservoirNames)) {
    ruleIssues.push(...overlapRanges(
      rules.filter((r) => r.reservoirId === rid && r.approvalStatus === 'approved')
        .map((r) => ({ validFrom: r.validFrom, validTo: r.validTo, label: r.version })),
    ).map((x) => `${reservoirNames[rid]}：${x}`));
  }
  for (const r of rules) {
    if (r.downstreamMinRelease > r.downstreamMaxRelease) ruleIssues.push(`${r.version} 下游允许泄流范围倒置`);
    if (r.targetStorage > r.floodLimitStorage) ruleIssues.push(`${r.version} 目标库容高于汛限库容`);
  }

  // 预警规则曲线治理检查：同水库同等级已审批规则适用期重叠 -> 越线分析不自动选取
  const warningIssues: string[] = [];
  for (const rc of ruleCurves) {
    if (rc.approvalStatus !== 'approved') continue;
    if (rc.validTo && Date.parse(rc.validTo) <= Date.parse(rc.validFrom)) warningIssues.push(`${rc.version} 有效期起止倒置`);
    if (rc.curvePoints.length === 0) warningIssues.push(`${rc.version} 无曲线点`);
    for (const other of ruleCurves) {
      if (other.id === rc.id || other.approvalStatus !== 'approved') continue;
      if (other.reservoirId !== rc.reservoirId || other.warningLevel !== rc.warningLevel || other.basinId !== rc.basinId) continue;
      if (other.metric !== rc.metric) continue;
      const aEnd = rc.validTo ? Date.parse(rc.validTo) : Number.POSITIVE_INFINITY;
      const bEnd = other.validTo ? Date.parse(other.validTo) : Number.POSITIVE_INFINITY;
      if (Date.parse(rc.validFrom) < bEnd && Date.parse(other.validFrom) < aEnd) {
        warningIssues.push(`${rc.version} ⚔ ${other.version} ${WARNING_LEVEL_LABEL[rc.warningLevel]}规则适用期重叠（不自动选取，分析须显式绑定）`);
      }
    }
  }
  const draftGroup = new Map<string, string[]>();
  for (const rc of ruleCurves) {
    if (rc.approvalStatus !== 'draft') continue;
    const key = `${rc.basinId}/${rc.reservoirId ?? '*'}/${rc.warningLevel}/${rc.metric}`;
    draftGroup.set(key, [...(draftGroup.get(key) ?? []), rc.version]);
  }
  for (const [key, versions] of draftGroup) {
    if (versions.length > 1) {
      warningIssues.push(`${key} 存在 ${versions.length} 个并发草案（${versions.join('、')}）：必须在分析中分别绑定，不得互相替代`);
    }
  }

  const bannerText = tab === 'curve'
    ? (curveIssues.length ? curveIssues.join('；') : '未发现曲线有效性问题')
    : tab === 'rule'
      ? (ruleIssues.length ? ruleIssues.join('；') : '未发现规则适用期问题')
      : (warningIssues.length ? [...new Set(warningIssues)].join('；') : '未发现预警规则曲线有效期/草案冲突问题');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>曲线与规则目录</h1>
          <div className="sub">库容/面积曲线与调度规则的有效期、审批状态；重叠或无效时相关运行指标保持待核</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={tab === 'curve' ? 'primary' : ''} onClick={() => setTab('curve')}>库容/面积曲线（{curves.length}）</button>
          <button className={tab === 'rule' ? 'primary' : ''} onClick={() => setTab('rule')}>调度规则（{rules.length}）</button>
          <button className={tab === 'warning' ? 'primary' : ''} onClick={() => setTab('warning')}>预警规则曲线（{ruleCurves.length}）</button>
        </div>
      </div>

      <div className="banner warn">
        <strong>目录治理检查：</strong>
        {bannerText}
      </div>

      {tab === 'curve' ? (
        <>
          <CurveForm onSaved={() => { bumpData(); void refresh(); }} reservoirOptions={reservoirNames} />
          <div className="card">
            <h2>曲线版本目录</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>水库</th><th>类型</th><th>版本</th><th>有效期起</th><th>有效期止</th><th>审批</th><th>点数单位</th><th className="num">点数</th><th>备注</th></tr></thead>
                <tbody>
                  {curves.map((c) => (
                    <tr key={c.id}>
                      <td className="mono small">{c.id}</td>
                      <td>{reservoirNames[c.reservoirId] ?? c.reservoirId}</td>
                      <td>{c.kind === 'storage' ? '库容曲线' : '面积曲线'}</td>
                      <td className="mono">{c.version}</td>
                      <td className="mono small">{formatHuman(c.validFrom)}</td>
                      <td className="mono small">{c.validTo ? formatHuman(c.validTo) : '至今'}</td>
                      <td><ApprovalPill status={c.approvalStatus} /></td>
                      <td>{c.pointUnit}</td>
                      <td className="num">{c.points.length}</td>
                      <td className="muted small">{c.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : tab === 'rule' ? (
        <>
          <RuleForm onSaved={() => { bumpData(); void refresh(); }} reservoirOptions={reservoirNames} />
          <div className="card">
            <h2>调度规则目录</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ID</th><th>水库</th><th>版本</th><th>有效期</th><th>审批</th>
                    <th className="num">汛限库容(m³)</th><th className="num">目标库容(m³)</th>
                    <th className="num">允许泄流(m³/s)</th><th>备注</th></tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td className="mono small">{r.id}</td>
                      <td>{reservoirNames[r.reservoirId] ?? r.reservoirId}</td>
                      <td className="mono">{r.version}</td>
                      <td className="mono small">{formatHuman(r.validFrom)} ~ {r.validTo ? formatHuman(r.validTo) : '至今'}</td>
                      <td><ApprovalPill status={r.approvalStatus} /></td>
                      <td className="num">{r.floodLimitStorage.toLocaleString()}</td>
                      <td className="num">{r.targetStorage.toLocaleString()}</td>
                      <td className="num">[{r.downstreamMinRelease}, {r.downstreamMaxRelease}]</td>
                      <td className="muted small">{r.note ?? '—'}{r.approvedBy ? `；审批人 ${r.approvedBy}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <>
          <WarningRuleForm onSaved={() => { bumpData(); void refresh(); }} reservoirOptions={reservoirNames} />
          <div className="card">
            <h2>预警规则曲线目录（流域 / 等级 / 有效期 / 曲线点 / 审批）</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th><th>流域</th><th>适用水库</th><th>等级</th><th>版本</th><th>指标</th>
                    <th>有效期</th><th>审批</th><th>曲线点</th><th className="num">下游安全流量</th><th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {ruleCurves.map((rc) => (
                    <tr key={rc.id}>
                      <td className="mono small">{rc.id}</td>
                      <td>{rc.basinName}</td>
                      <td>{rc.reservoirId ? (reservoirNames[rc.reservoirId] ?? rc.reservoirId) : '流域级'}</td>
                      <td><span className={`pill ${rc.warningLevel === 'orange' ? 'warn' : rc.warningLevel === 'red' ? 'danger' : rc.warningLevel === 'yellow' ? 'pending' : 'info'}`}>{WARNING_LEVEL_LABEL[rc.warningLevel]}</span></td>
                      <td className="mono">{rc.version}</td>
                      <td>{rc.metric === 'water_level' ? '水位' : '流量'}（{rc.curveSemantics === 'linear' ? '线性' : '阶梯'}）</td>
                      <td className="mono small">{formatHuman(rc.validFrom)} ~ {rc.validTo ? formatHuman(rc.validTo) : '至今'}</td>
                      <td><ApprovalPill status={rc.approvalStatus} /></td>
                      <td className="mono small">
                        {sortedCurvePoints(rc).map((p) => `${formatHuman(p.t)}→${p.threshold}`).join('；')}
                      </td>
                      <td className="num">{rc.downstreamSafeFlow ? `[${rc.downstreamSafeFlow[0]}, ${rc.downstreamSafeFlow[1]}]` : '—'}</td>
                      <td className="muted small">
                        {rc.note ?? '—'}
                        {rc.approvedBy ? `；审批人 ${rc.approvedBy}` : ''}
                        {rc.retiredAt ? `；撤回于 ${formatHuman(rc.retiredAt)}` : ''}
                      </td>
                    </tr>
                  ))}
                  {ruleCurves.length === 0 && <tr><td colSpan={11} className="muted">暂无预警规则曲线，请播种演示数据或登记新曲线</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const RESERVOIR_IDS = ['qx', 'bs', 'df', 'xl'];

function CurveForm({ onSaved, reservoirOptions }: { onSaved: () => void; reservoirOptions: Record<string, string> }) {
  const [form, setForm] = useState({
    reservoirId: 'qx', kind: 'storage' as 'storage' | 'area', version: '', validFrom: '2026-07-15T00:00:00.000Z',
    validTo: '', approvalStatus: 'draft' as ApprovalStatus, pointUnit: 'm3' as CurveVersion['pointUnit'],
    pointsText: '100,0\n110,10000000', note: '',
  });
  const submit = async () => {
    const points = form.pointsText.split(/\r?\n/).filter(Boolean).map((line) => {
      const [x, y] = line.split(',').map(Number);
      return { x, y };
    });
    await putCurve({
      id: `cv-${form.reservoirId}-${form.kind}-${Date.now()}`,
      reservoirId: form.reservoirId, kind: form.kind, version: form.version || `V-${Date.now()}`,
      validFrom: form.validFrom, validTo: form.validTo || undefined,
      approvalStatus: form.approvalStatus, pointUnit: form.pointUnit, points, note: form.note,
    });
    onSaved();
  };
  return (
    <details className="card">
      <summary>＋ 登记新曲线版本（草稿需审批后才参与运行换算）</summary>
      <div className="form-row three">
        <label className="field">水库
          <select value={form.reservoirId} onChange={(e) => setForm({ ...form, reservoirId: e.target.value })}>
            {RESERVOIR_IDS.map((id) => <option key={id} value={id}>{reservoirOptions[id] ?? id}</option>)}
          </select>
        </label>
        <label className="field">类型
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'storage' | 'area' })}>
            <option value="storage">库容曲线</option>
            <option value="area">面积曲线</option>
          </select>
        </label>
        <label className="field">版本号<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="如 BS-S-2026" /></label>
        <label className="field">有效期起<input value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
        <label className="field">有效期止（空=至今）<input value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} placeholder="至今" /></label>
        <label className="field">审批状态
          <select value={form.approvalStatus} onChange={(e) => setForm({ ...form, approvalStatus: e.target.value as ApprovalStatus })}>
            <option value="draft">草稿</option><option value="approved">已审批</option><option value="retired">已停用</option>
          </select>
        </label>
        <label className="field">点值单位
          <select value={form.pointUnit} onChange={(e) => setForm({ ...form, pointUnit: e.target.value as CurveVersion['pointUnit'] })}>
            <option value="m3">m³（库容）</option><option value="wan_m3">万m³（库容）</option>
            <option value="m2">m²（面积）</option><option value="km2">km²（面积）</option>
          </select>
        </label>
      </div>
      <label className="field">曲线点（每行 “水位,值”）
        <textarea style={{ fontFamily: 'var(--mono)' }} value={form.pointsText} onChange={(e) => setForm({ ...form, pointsText: e.target.value })} />
      </label>
      <label className="field">备注<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button className="primary" onClick={() => void submit()}>保存曲线版本</button>
    </details>
  );
}

function RuleForm({ onSaved, reservoirOptions }: { onSaved: () => void; reservoirOptions: Record<string, string> }) {
  const [form, setForm] = useState({
    reservoirId: 'qx', version: '', validFrom: '2026-07-15T00:00:00.000Z', validTo: '',
    approvalStatus: 'draft' as ApprovalStatus, floodLimitStorage: 12_000_000, targetStorage: 10_000_000,
    downstreamMinRelease: 30, downstreamMaxRelease: 120, note: '',
  });
  const submit = async () => {
    await putRule({
      id: `rule-${form.reservoirId}-${Date.now()}`,
      reservoirId: form.reservoirId, version: form.version || `R-${Date.now()}`,
      validFrom: form.validFrom, validTo: form.validTo || undefined, approvalStatus: form.approvalStatus,
      floodLimitStorage: Number(form.floodLimitStorage), targetStorage: Number(form.targetStorage),
      downstreamMinRelease: Number(form.downstreamMinRelease), downstreamMaxRelease: Number(form.downstreamMaxRelease),
      note: form.note,
    });
    onSaved();
  };
  return (
    <details className="card">
      <summary>＋ 登记新调度规则（适用期重叠会导致指标待核）</summary>
      <div className="form-row three">
        <label className="field">水库
          <select value={form.reservoirId} onChange={(e) => setForm({ ...form, reservoirId: e.target.value })}>
            {RESERVOIR_IDS.map((id) => <option key={id} value={id}>{reservoirOptions[id] ?? id}</option>)}
          </select>
        </label>
        <label className="field">版本号<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
        <label className="field">审批状态
          <select value={form.approvalStatus} onChange={(e) => setForm({ ...form, approvalStatus: e.target.value as ApprovalStatus })}>
            <option value="draft">草稿</option><option value="approved">已审批</option><option value="retired">已停用</option>
          </select>
        </label>
        <label className="field">有效期起<input value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
        <label className="field">有效期止（空=至今）<input value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} /></label>
        <label className="field">汛限库容 m³<input type="number" value={form.floodLimitStorage} onChange={(e) => setForm({ ...form, floodLimitStorage: Number(e.target.value) })} /></label>
        <label className="field">目标库容 m³<input type="number" value={form.targetStorage} onChange={(e) => setForm({ ...form, targetStorage: Number(e.target.value) })} /></label>
        <label className="field">下游最小泄流 m³/s<input type="number" value={form.downstreamMinRelease} onChange={(e) => setForm({ ...form, downstreamMinRelease: Number(e.target.value) })} /></label>
        <label className="field">下游最大泄流 m³/s<input type="number" value={form.downstreamMaxRelease} onChange={(e) => setForm({ ...form, downstreamMaxRelease: Number(e.target.value) })} /></label>
      </div>
      <label className="field">备注<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button className="primary" onClick={() => void submit()}>保存规则</button>
    </details>
  );
}

function WarningRuleForm({ onSaved, reservoirOptions }: { onSaved: () => void; reservoirOptions: Record<string, string> }) {
  const [form, setForm] = useState({
    basinId: 'qingxi', basinName: '青溪河流域', reservoirId: '',
    warningLevel: 'orange' as RuleCurve['warningLevel'],
    version: '', metric: 'water_level' as RuleCurve['metric'],
    curveSemantics: 'linear' as RuleCurve['curveSemantics'],
    validFrom: '2026-06-01T00:00:00.000Z', validTo: '',
    approvalStatus: 'draft' as ApprovalStatus,
    curveText: '2026-07-14T00:00:00.000Z,106.0\n2026-07-20T00:00:00.000Z,106.0',
    safeMin: 30, safeMax: 90, note: '',
  });
  const submit = async () => {
    const curvePoints = form.curveText.split(/\r?\n/).filter(Boolean).map((line) => {
      const [time, thr] = line.split(',').map((x) => x.trim());
      return { t: time, threshold: Number(thr) };
    });
    await putRuleCurve({
      id: `rc-${form.reservoirId || form.basinId}-${Date.now()}`,
      basinId: form.basinId, basinName: form.basinName,
      reservoirId: form.reservoirId || undefined,
      warningLevel: form.warningLevel, version: form.version || `RC-${Date.now()}`,
      metric: form.metric,
      unit: form.metric === 'water_level' ? 'm' : 'm3/s',
      validFrom: form.validFrom, validTo: form.validTo || undefined,
      approvalStatus: form.approvalStatus,
      curvePoints, curveSemantics: form.curveSemantics,
      downstreamSafeFlow: [Number(form.safeMin), Number(form.safeMax)],
      note: form.note,
    });
    onSaved();
  };
  return (
    <details className="card">
      <summary>＋ 登记预警规则曲线（同等级有效期重叠不自动选取；并发草案须分别绑定）</summary>
      <div className="form-row three">
        <label className="field">流域 ID<input value={form.basinId} onChange={(e) => setForm({ ...form, basinId: e.target.value })} /></label>
        <label className="field">流域名称<input value={form.basinName} onChange={(e) => setForm({ ...form, basinName: e.target.value })} /></label>
        <label className="field">适用水库（空＝流域级）
          <select value={form.reservoirId} onChange={(e) => setForm({ ...form, reservoirId: e.target.value })}>
            <option value="">流域级规则</option>
            {Object.entries(reservoirOptions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="field">预警级别
          <select value={form.warningLevel} onChange={(e) => setForm({ ...form, warningLevel: e.target.value as RuleCurve['warningLevel'] })}>
            <option value="blue">蓝色</option><option value="yellow">黄色</option><option value="orange">橙色</option><option value="red">红色</option>
          </select>
        </label>
        <label className="field">指标
          <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as RuleCurve['metric'] })}>
            <option value="water_level">水位</option><option value="flow">流量</option>
          </select>
        </label>
        <label className="field">曲线语义
          <select value={form.curveSemantics} onChange={(e) => setForm({ ...form, curveSemantics: e.target.value as RuleCurve['curveSemantics'] })}>
            <option value="linear">线性插值</option><option value="step">阶梯（保持前值）</option>
          </select>
        </label>
        <label className="field">版本号<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
        <label className="field">审批状态
          <select value={form.approvalStatus} onChange={(e) => setForm({ ...form, approvalStatus: e.target.value as ApprovalStatus })}>
            <option value="draft">草稿</option><option value="approved">已审批</option><option value="retired">已停用</option>
          </select>
        </label>
        <label className="field">有效期起<input value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
        <label className="field">有效期止（空=至今）<input value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} /></label>
        <label className="field">下游安全流量 min m³/s<input type="number" value={form.safeMin} onChange={(e) => setForm({ ...form, safeMin: Number(e.target.value) })} /></label>
        <label className="field">下游安全流量 max m³/s<input type="number" value={form.safeMax} onChange={(e) => setForm({ ...form, safeMax: Number(e.target.value) })} /></label>
      </div>
      <label className="field">曲线点（每行 “时刻ISO,阈值”）— 线性语义为插值点，阶梯语义为跃变点
        <textarea style={{ fontFamily: 'var(--mono)' }} value={form.curveText} onChange={(e) => setForm({ ...form, curveText: e.target.value })} />
      </label>
      <label className="field">备注<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button className="primary" onClick={() => void submit()}>保存预警规则曲线</button>
    </details>
  );
}

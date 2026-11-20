// 渲染冒烟（无浏览器环境）：确认新增页面/结果卡片在典型数据下可渲染，不依赖 IndexedDB。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { AppProvider } from '../appState';
import { CrossingResultCard, ComparisonCard } from '../pages/CrossingPage';
import { buildDemoDataset } from '../demo/demoData';
import { buildObservedSeries, analyzeScenario, compareScenarios } from './crossings';

const data = buildDemoDataset();
const qx = buildObservedSeries({
  readings: data.readings, reservoirId: 'qx', metric: 'water_level', sourceKind: 'water_level',
  nominalStepSeconds: 3600, variant: 'base', runId: 'r',
});
const rule = (id: string) => data.ruleCurves.find((r) => r.id === id)!;

describe('页面渲染冒烟', () => {
  it('越线分析路由可在无运行状态下渲染并给出引导', () => {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/crossing'] },
        React.createElement(AppProvider, null, React.createElement(App)),
      ),
    );
    expect(html).toContain('规则曲线穿越与敏感区间');
    expect(html).toContain('尚无可用运行');
  });

  it('越线结果卡片渲染首次越线、持续时长、敏感带与 caveat', () => {
    const analysis = analyzeScenario({ label: 'A', mode: 'interpolated', series: qx, rules: [rule('rc-qx-lv-orange')] }, { margin: 0.1 });
    const html = renderToString(
      React.createElement(CrossingResultCard, { title: '情景A', analysis, unit: 'm', margin: 0.1 }),
    );
    expect(html).toContain('首次越线');
    expect(html).toContain('高于阈值持续时长');
    expect(html).toContain('接近阈值的时间带');
    expect(html).toContain('插值可信性');
  });

  it('情景比较卡片渲染归因与反事实', () => {
    const cmp = compareScenarios({
      a: { spec: { label: '蓝', mode: 'interpolated', series: qx, rules: [rule('rc-qx-lv-blue')] }, series: qx, rules: [rule('rc-qx-lv-blue')] },
      b: { spec: { label: '橙', mode: 'interpolated', series: qx, rules: [rule('rc-qx-lv-orange')] }, series: qx, rules: [rule('rc-qx-lv-orange')] },
      margin: 0.1,
    });
    const html = renderToString(
      React.createElement(ComparisonCard, { comparison: cmp.comparison, aAnalysis: cmp.a, bAnalysis: cmp.b }),
    );
    expect(html).toContain('阈值定义');
    expect(html).toContain('反事实核对');
    expect(html).toContain('下游安全流量');
  });

  it('不同模式比较渲染“不可比”，不伪造归因数值', () => {
    const cmp = compareScenarios({
      a: { spec: { label: '插值', mode: 'interpolated', series: qx, rules: [rule('rc-qx-lv-orange')] }, series: qx, rules: [rule('rc-qx-lv-orange')] },
      b: { spec: { label: '格', mode: 'grid', series: qx, rules: [rule('rc-qx-lv-orange')] }, series: qx, rules: [rule('rc-qx-lv-orange')] },
      margin: 0.1,
    });
    const html = renderToString(
      React.createElement(ComparisonCard, { comparison: cmp.comparison, aAnalysis: cmp.a, bAnalysis: cmp.b }),
    );
    expect(html).toContain('不可比');
    expect(html).toContain('无法归因');
  });
});

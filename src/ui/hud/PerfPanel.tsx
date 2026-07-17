import { useEffect, useState } from 'preact/hooks';

import { PERF_SPARKLINE_BUDGET_Y, type PerfPanelDisplaySignals } from './perfPanelStore.js';

export interface PerfPanelProps {
  readonly display: PerfPanelDisplaySignals;
}

interface MetricProps {
  readonly id: string;
  readonly label: string;
  readonly value: PerfPanelDisplaySignals[keyof PerfPanelDisplaySignals];
}

function PerfMetric({ id, label, value }: MetricProps) {
  return (
    <div class="perf-detail-row">
      <dt>{label}</dt>
      <dd id={id}>{value}</dd>
    </div>
  );
}

/** Compact performance truth with an on-demand diagnostic expansion. */
export function PerfPanel({ display }: PerfPanelProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const toggleWithF3 = (event: KeyboardEvent): void => {
      if (event.code !== 'F3') return;
      event.preventDefault();
      setExpanded((current) => !current);
    };
    window.addEventListener('keydown', toggleWithF3);
    return () => window.removeEventListener('keydown', toggleWithF3);
  }, []);

  return (
    <section
      id="perf-panel"
      class={`hud-panel perf-panel${expanded ? ' perf-panel-expanded' : ''}`}
      data-cost-ms-per-frame={display.panelCost}
      data-sample-count={display.sampleCount}
      aria-label="Performance telemetry"
    >
      <button
        id="perf-panel-toggle"
        class="perf-panel-toggle"
        type="button"
        aria-controls="perf-panel-details"
        aria-expanded={expanded}
        title="Toggle performance details (F3)"
        onClick={() => setExpanded((current) => !current)}
      >
        <strong id="perf-panel-fps" class="perf-panel-fps">
          {display.fps}
        </strong>
        <svg
          id="perf-panel-sparkline"
          class="perf-panel-sparkline"
          viewBox="0 0 120 32"
          role="img"
          aria-label="Last 120 frame times with 16.6 millisecond budget"
        >
          <line
            id="perf-panel-budget-line"
            class="perf-panel-budget-line"
            x1="0"
            x2="120"
            y1={PERF_SPARKLINE_BUDGET_Y}
            y2={PERF_SPARKLINE_BUDGET_Y}
          />
          <polyline class="perf-panel-frame-line" points={display.sparklinePoints} />
        </svg>
        <span id="perf-panel-resolution" class="perf-panel-resolution">
          {display.resolution}
        </span>
        <span id="perf-panel-quality" class="perf-panel-quality">
          {display.qualityTier}
        </span>
        <span class="perf-panel-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      <div id="perf-panel-details" class="perf-panel-details" hidden={!expanded}>
        <dl>
          <PerfMetric
            id="perf-panel-one-percent-low"
            label="1% low"
            value={display.onePercentLow}
          />
          <PerfMetric id="perf-panel-sim-ms" label="Simulation" value={display.simMs} />
          <PerfMetric id="perf-panel-render-ms" label="Render" value={display.renderMs} />
          <PerfMetric id="perf-panel-ui-ms" label="UI / HUD" value={display.uiMs} />
          <PerfMetric id="perf-panel-gpu-ms" label="GPU" value={display.gpuMs} />
          <PerfMetric id="perf-panel-draw-stats" label="Draw" value={display.drawStats} />
          <PerfMetric
            id="perf-panel-resource-stats"
            label="Resources"
            value={display.resourceStats}
          />
          <PerfMetric id="perf-panel-js-heap" label="JS heap" value={display.jsHeap} />
          <PerfMetric id="perf-panel-context" label="Context" value={display.context} />
          <PerfMetric id="perf-panel-gpu-name" label="GPU" value={display.gpuName} />
          <PerfMetric id="perf-panel-governor" label="Governor" value={display.governorState} />
          <PerfMetric id="perf-panel-last-action" label="Last action" value={display.lastAction} />
          <PerfMetric id="perf-panel-cost" label="Panel cost" value={display.panelCost} />
        </dl>
      </div>
    </section>
  );
}

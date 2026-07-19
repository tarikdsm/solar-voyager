import { useEffect, useRef, useState } from 'preact/hooks';

import {
  PERF_SPARKLINE_BUDGET_Y,
  PERF_SPARKLINE_HEIGHT,
  PERF_SPARKLINE_MAX_FRAME_MS,
  type PerfPanelDisplaySignals,
  type PerfPanelSparklineSink,
  type PerfPanelStore,
  type PerfPanelTelemetrySource,
} from './perfPanelStore.js';

const SPARKLINE_WIDTH = 120;
const BUDGET_STROKE = 'rgb(251 191 36 / 38%)';
const FRAME_STROKE = 'rgb(125 211 252 / 82%)';

export interface PerfPanelProps {
  readonly store: PerfPanelStore;
  readonly onExpandedChange?: ((expanded: boolean) => void) | null;
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

class CanvasSparklineSink implements PerfPanelSparklineSink {
  constructor(private readonly context: CanvasRenderingContext2D) {}

  draw(telemetry: PerfPanelTelemetrySource): void {
    const context = this.context;
    const sampleCount = Math.min(SPARKLINE_WIDTH, telemetry.frameSampleCount);
    const firstX = SPARKLINE_WIDTH - sampleCount;
    context.clearRect(0, 0, SPARKLINE_WIDTH, PERF_SPARKLINE_HEIGHT);
    context.strokeStyle = BUDGET_STROKE;
    context.lineWidth = 0.75;
    context.beginPath();
    context.moveTo(0, PERF_SPARKLINE_BUDGET_Y);
    context.lineTo(SPARKLINE_WIDTH, PERF_SPARKLINE_BUDGET_Y);
    context.stroke();
    if (sampleCount === 0) return;
    context.strokeStyle = FRAME_STROKE;
    context.lineWidth = 1;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const age = sampleCount - 1 - sampleIndex;
      const rawFrameMs = telemetry.getFrameTimeByAge(age);
      const frameMs = Number.isFinite(rawFrameMs) ? Math.max(0, rawFrameMs) : 0;
      const y =
        PERF_SPARKLINE_HEIGHT -
        (Math.min(PERF_SPARKLINE_MAX_FRAME_MS, frameMs) / PERF_SPARKLINE_MAX_FRAME_MS) *
          PERF_SPARKLINE_HEIGHT;
      if (sampleIndex === 0) context.moveTo(firstX, y);
      else context.lineTo(firstX + sampleIndex, y);
    }
    context.stroke();
  }
}

/** Compact performance truth with an on-demand diagnostic expansion. */
export function PerfPanel({ store, onExpandedChange = null }: PerfPanelProps) {
  const display = store.display;
  const [expanded, setExpanded] = useState(false);
  const sparklineCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = sparklineCanvas.current?.getContext('2d');
    if (context === null || context === undefined) return;
    const sink = new CanvasSparklineSink(context);
    store.setSparklineSink(sink);
    return () => store.setSparklineSink(null);
  }, [store]);

  useEffect(() => {
    const toggle = (): void => {
      setExpanded((current) => {
        const next = !current;
        onExpandedChange?.(next);
        return next;
      });
    };
    const toggleWithF3 = (event: KeyboardEvent): void => {
      if (event.code !== 'F3' || event.repeat) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', toggleWithF3);
    return () => window.removeEventListener('keydown', toggleWithF3);
  }, [onExpandedChange]);

  const toggleExpanded = (): void => {
    setExpanded((current) => {
      const next = !current;
      onExpandedChange?.(next);
      return next;
    });
  };

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
        onClick={toggleExpanded}
      >
        <strong id="perf-panel-fps" class="perf-panel-fps">
          {display.fps}
        </strong>
        <canvas
          ref={sparklineCanvas}
          id="perf-panel-sparkline"
          class="perf-panel-sparkline"
          width={SPARKLINE_WIDTH}
          height={PERF_SPARKLINE_HEIGHT}
          role="img"
          aria-label="Last 120 frame times with 16.6 millisecond budget"
        />
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

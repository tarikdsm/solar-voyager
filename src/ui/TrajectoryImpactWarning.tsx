import { useComputed } from '@preact/signals';

import type { TrajectoryPredictionDisplaySignals } from './trajectoryPredictionSignals.js';

/** Persistent alert shell whose visibility and text are signal-only updates. */
export function TrajectoryImpactWarning({
  display,
}: {
  readonly display: TrajectoryPredictionDisplaySignals;
}) {
  const hidden = useComputed(() => !display.impactVisible.value);
  const visible = useComputed(() => String(display.impactVisible.value));
  return (
    <aside
      id="trajectory-impact-warning"
      class="trajectory-impact-warning"
      role="alert"
      aria-live="assertive"
      aria-hidden={hidden}
      data-visible={visible}
    >
      <span class="trajectory-impact-icon" aria-hidden="true">
        △
      </span>
      <span>
        <strong>Collision course</strong>
        <span id="trajectory-impact-message">{display.impactMessage}</span>
      </span>
    </aside>
  );
}

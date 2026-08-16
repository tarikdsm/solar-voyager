import { runCruiseScenario } from './src/game/flight/cruiseScenario.js';
for (const t of (process.argv.slice(2).length ? process.argv.slice(2) : ['moon'])) {
  const s = Date.now();
  const r = runCruiseScenario({ targetBodyId: t, maxFrames: 120000 });
  console.log(t, JSON.stringify({ phase: r.phase, frames: r.frames, wallSec: +r.wallSec.toFixed(1), simDays: +(r.simTimeSec/86400).toFixed(3), e: +r.eccentricity.toFixed(4), altKm: Math.round(r.altitudeKm), presetKm: Math.round(r.presetAltitudeKm), altErr: +((r.altitudeKm/r.presetAltitudeKm-1)*100).toFixed(2)+'%', vrel: +r.relativeSpeedKmS.toFixed(3), energyRatio: +r.energyRatio.toFixed(4), peakBeta: +r.peakBeta.toFixed(5), maxWarp: r.maxWarp, resolveFail: r.resolveFailures, ctrl: r.controllable }), `[${((Date.now()-s)/1000).toFixed(1)}s]`);
}

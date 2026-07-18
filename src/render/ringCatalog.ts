import ringDocument from '../../data/rings.json';

export interface RingBand {
  readonly name: string;
  readonly innerRadiusKm: number;
  readonly outerRadiusKm: number;
  readonly opticalDepth: number;
  readonly color: string;
}

export interface RingArc {
  readonly name: string;
  readonly centerDeg: number;
  readonly widthDeg: number;
  readonly gain: number;
}

export interface RingParticleDefinition {
  readonly seed: number;
  readonly maxCount: number;
  readonly patchRadiusKm: number;
  readonly verticalThicknessKm: number;
  readonly minSizeM: number;
  readonly maxSizeM: number;
}

export interface RingDefinition {
  readonly bodyId: string;
  readonly referenceRadiusKm: number;
  readonly innerRadiusKm: number;
  readonly outerRadiusKm: number;
  readonly innerRadiusRatio: number;
  readonly outerRadiusRatio: number;
  readonly exposure: number;
  readonly baseColor: string;
  readonly bands: readonly RingBand[];
  readonly arcs: readonly RingArc[];
  readonly particles: RingParticleDefinition | null;
  readonly sources: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value;
}

function textValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string.`);
  }
  return value;
}

function finite(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${path} must be a finite number >= ${String(minimum)}.`);
  }
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) throw new RangeError(`${path} must be positive.`);
  return result;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const result = finite(value, path, minimum);
  if (!Number.isInteger(result)) throw new RangeError(`${path} must be an integer.`);
  return result;
}

function color(value: unknown, path: string): string {
  const result = textValue(value, path);
  if (!/^#[0-9a-f]{6}$/iu.test(result)) throw new RangeError(`${path} must be #RRGGBB.`);
  return result.toLowerCase();
}

function parseBand(value: unknown, path: string, inner: number, outer: number): RingBand {
  const source = record(value, path);
  const bandInner = positive(source.innerRadiusKm, `${path}.innerRadiusKm`);
  const bandOuter = positive(source.outerRadiusKm, `${path}.outerRadiusKm`);
  if (bandInner < inner || bandOuter > outer || bandOuter <= bandInner) {
    throw new RangeError(`${path} must stay inside the ring annulus with increasing radii.`);
  }
  return Object.freeze({
    name: textValue(source.name, `${path}.name`),
    innerRadiusKm: bandInner,
    outerRadiusKm: bandOuter,
    opticalDepth: finite(source.opticalDepth, `${path}.opticalDepth`),
    color: color(source.color, `${path}.color`),
  });
}

function parseArc(value: unknown, path: string): RingArc {
  const source = record(value, path);
  const centerDeg = finite(source.centerDeg, `${path}.centerDeg`);
  const widthDeg = positive(source.widthDeg, `${path}.widthDeg`);
  const gain = finite(source.gain, `${path}.gain`, 1);
  if (centerDeg >= 360 || widthDeg > 360) throw new RangeError(`${path} has invalid degrees.`);
  return Object.freeze({ name: textValue(source.name, `${path}.name`), centerDeg, widthDeg, gain });
}

function parseParticles(value: unknown, path: string): RingParticleDefinition | null {
  if (value === null) return null;
  const source = record(value, path);
  const minSizeM = positive(source.minSizeM, `${path}.minSizeM`);
  const maxSizeM = positive(source.maxSizeM, `${path}.maxSizeM`);
  if (maxSizeM < minSizeM) throw new RangeError(`${path}.maxSizeM must be >= minSizeM.`);
  return Object.freeze({
    seed: integer(source.seed, `${path}.seed`),
    maxCount: integer(source.maxCount, `${path}.maxCount`, 1),
    patchRadiusKm: positive(source.patchRadiusKm, `${path}.patchRadiusKm`),
    verticalThicknessKm: positive(source.verticalThicknessKm, `${path}.verticalThicknessKm`),
    minSizeM,
    maxSizeM,
  });
}

function parseSystem(value: unknown, path: string): RingDefinition {
  const source = record(value, path);
  const referenceRadiusKm = positive(source.referenceRadiusKm, `${path}.referenceRadiusKm`);
  const innerRadiusKm = positive(source.innerRadiusKm, `${path}.innerRadiusKm`);
  const outerRadiusKm = positive(source.outerRadiusKm, `${path}.outerRadiusKm`);
  if (outerRadiusKm <= innerRadiusKm) throw new RangeError(`${path} has inverted annulus radii.`);
  const bands = array(source.bands, `${path}.bands`).map((band, index) =>
    parseBand(band, `${path}.bands[${String(index)}]`, innerRadiusKm, outerRadiusKm),
  );
  if (bands.length === 0) throw new RangeError(`${path}.bands must not be empty.`);
  const arcs = array(source.arcs, `${path}.arcs`).map((arc, index) =>
    parseArc(arc, `${path}.arcs[${String(index)}]`),
  );
  const sources = array(source.sources, `${path}.sources`).map((entry, index) =>
    textValue(entry, `${path}.sources[${String(index)}]`),
  );
  if (sources.length === 0) throw new RangeError(`${path}.sources must not be empty.`);
  return Object.freeze({
    bodyId: textValue(source.bodyId, `${path}.bodyId`),
    referenceRadiusKm,
    innerRadiusKm,
    outerRadiusKm,
    innerRadiusRatio: innerRadiusKm / referenceRadiusKm,
    outerRadiusRatio: outerRadiusKm / referenceRadiusKm,
    exposure: positive(source.exposure, `${path}.exposure`),
    baseColor: color(source.baseColor, `${path}.baseColor`),
    bands: Object.freeze(bands),
    arcs: Object.freeze(arcs),
    particles: parseParticles(source.particles, `${path}.particles`),
    sources: Object.freeze(sources),
  });
}

export function loadRingCatalog(value: unknown): readonly RingDefinition[] {
  const source = record(value, 'rings');
  if (source.schemaVersion !== 1) throw new RangeError('rings.schemaVersion must be 1.');
  const systems = array(source.systems, 'rings.systems').map((system, index) =>
    parseSystem(system, `systems[${String(index)}]`),
  );
  const seen = new Set<string>();
  for (const system of systems) {
    if (seen.has(system.bodyId)) throw new RangeError(`duplicate ring body id ${system.bodyId}.`);
    seen.add(system.bodyId);
  }
  systems.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
  return Object.freeze(systems);
}

export const RING_DEFINITIONS = loadRingCatalog(ringDocument);

export function ringDefinitionFor(bodyId: string): RingDefinition | null {
  for (const definition of RING_DEFINITIONS) if (definition.bodyId === bodyId) return definition;
  return null;
}

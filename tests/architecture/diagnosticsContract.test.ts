import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as ts from 'typescript';
import { beforeAll, describe, expect, test } from 'vitest';

import { StartupTracker } from '../../src/game/startupTracker.js';

/**
 * The frozen browser-diagnostic contract, locked in the fast lane.
 *
 * Seven `Object.defineProperty(canvas, 'solarVoyager*')` objects carry every
 * observation roughly 25 Playwright gates make about the running game. They are
 * read from `page.evaluate` callbacks by property name, so TypeScript never sees
 * those reads and a dropped or renamed field surfaces — if at all — as a failure
 * hundreds of lines from its cause. Most readers are strict subsets: they cannot
 * fail on a field they do not happen to read. `tools/tests/mainMenuRegression.mjs`
 * is the only one that pins a whole shape (`RuntimeResourceCounts`, twice, with
 * `deepEqual`).
 *
 * This test is the whole-shape gate for all seven, and it is deliberately
 * location-independent: it scans `src/` rather than naming the file that happens
 * to own the contract today, so moving the definitions (T0113 moves them out of
 * `main.ts`) does not require editing it. Extend it when a diagnostic gains a
 * field; never relax it to make a refactor pass.
 *
 * `solarVoyagerTelemetry` is intentionally absent: `src/render/telemetry.ts`
 * defines it behind `RENDER_TELEMETRY_PROPERTY` and `src/render/telemetry.test.ts`
 * owns its contract.
 */

const SOURCE_ROOT = join(process.cwd(), 'src');

/** Every canvas property the browser gates may rely on, and nothing else. */
const DIAGNOSTIC_PROPERTIES = [
  'solarVoyagerBurnLog',
  'solarVoyagerCamera',
  'solarVoyagerRuntimeResources',
  'solarVoyagerShip',
  'solarVoyagerStartup',
  'solarVoyagerSystemMap',
  'solarVoyagerTutorial',
] as const;

/**
 * Member name to `readonly? <declared type text>`.
 *
 * Declared text, not a checker-resolved type: it keeps the literal types that
 * are themselves contract (`'solarVoyagerBurnLog.v1'`, `1`) legible, and it lets
 * the scan run without module resolution.
 */
const EXPECTED_MEMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // canvas.solarVoyagerRuntimeResources
  RuntimeResourceCounts: {
    animationLoopStarts: 'number',
    cameraDirectors: 'number',
    cameraInputControllers: 'number',
    canvasBindings: 'number',
    epochWorldCreations: 'number',
    keyboardCommandMappers: 'number',
    pagehideListeners: 'number',
    rendererCreations: 'number',
    resizeListeners: 'number',
    scrollListeners: 'number',
    sessionSimulationCreations: 'number',
    sessionSimulationReplacements: 'number',
    shipVisualCreations: 'number',
    spacePhaseActivationRequests: 'number',
    spacePhaseActivations: 'number',
    stateVectorLayoutObservers: 'number',
    trajectoryWorkers: 'number',
  },
  // canvas.solarVoyagerStartup
  StartupDiagnostic: {
    encodedBodyBytes: 'readonly number',
    errorCount: 'readonly number',
    errorMessage: 'readonly string | null',
    failedStage: 'readonly string | null',
    firstPlayableMs: 'readonly number | null',
    probeMeanMs: 'readonly number | null',
    programCountAfterFirstFrame: 'readonly number | null',
    programCountAtReady: 'readonly number',
    programCountCurrent: 'readonly number',
    progress: 'readonly number',
    qualitySource: 'readonly StartupQualitySource | null',
    resourceCount: 'readonly number',
    selectedRung: 'readonly number',
    stage: 'readonly StartupStage',
    transferBytes: 'readonly number',
  },
  // canvas.solarVoyagerShip
  ShipRuntimeDiagnostics: {
    diameterPx: 'readonly number',
    focused: 'readonly boolean',
    loadState: 'readonly BodyModelLoadState',
    modelOpacity: 'readonly number',
    noseAlignment: 'readonly number',
    noseNodeAlignment: 'readonly number',
    pointOpacity: 'readonly number',
    resolved: 'readonly boolean',
  },
  // canvas.solarVoyagerCamera
  CameraRuntimeDiagnostics: {
    armDistanceKm: 'readonly number',
    distanceShipLengths: 'readonly number',
    focusId: 'readonly string',
    fovDeg: 'readonly number',
    fovOffsetDeg: 'readonly number',
    fovWideningEnabled: 'readonly boolean',
    mode: 'readonly CameraMode',
    positionXKm: 'readonly number',
    positionYKm: 'readonly number',
    positionZKm: 'readonly number',
    shakeAmplitudeDeg: 'readonly number',
    shakeEnabled: 'readonly boolean',
    shipDistanceKm: 'readonly number',
    transitioning: 'readonly boolean',
  },
  // canvas.solarVoyagerSystemMap
  SystemMapRuntimeDiagnostics: {
    focusBodyId: 'string',
    mapRenderCount: 'number',
    mapSceneCreations: 'readonly 1',
    mode: 'SystemMapMode',
    scene: "readonly EpochWorld['systemMap']['diagnostics']",
    simulationTimeSec: 'number',
    spaceRenderCount: 'number',
    spaceRenderCountAtModeChange: 'number',
    targetBodyId: 'string | null',
    trajectoryLineVisible: 'boolean',
    trajectoryMarkersVisible: 'boolean',
  },
  // canvas.solarVoyagerBurnLog
  BurnLogRuntimeDiagnostics: {
    active: 'readonly MutableBurnLogDiagnosticEntry',
    activeAvailable: 'boolean',
    completedCount: 'number',
    identity: "readonly 'solarVoyagerBurnLog.v1'",
    latest: 'readonly MutableBurnLogDiagnosticEntry',
    latestAvailable: 'boolean',
    publishCount: 'number',
    structuralRebuildCount: 'number',
  },
  // canvas.solarVoyagerBurnLog.active / .latest
  MutableBurnLogDiagnosticEntry: {
    dominantBodyId: 'string | null',
    endProperTimeSec: 'number',
    endTimeSec: 'number',
    energySpentJ: 'number',
    normalDeltaVMS: 'number',
    peakPowerW: 'number',
    progradeDeltaVMS: 'number',
    properDeltaVMS: 'number',
    radialDeltaVMS: 'number',
    startProperTimeSec: 'number',
    startTimeSec: 'number',
  },
  // canvas.solarVoyagerTutorial
  TutorialRuntimeDiagnostics: {
    observerActive: 'readonly boolean',
    snapshotObservationCount: 'readonly number',
    status: 'readonly string',
    stepId: 'readonly string',
    transitionCount: 'readonly number',
  },
};

/**
 * `solarVoyagerStartup` fully measured — ready, plus the first ordinary frame.
 *
 * This is the state `tools/tests/startupRegression.mjs` reads twice: once at
 * `stage: 'ready'` and again after New Game, where it asserts
 * `programCountAfterFirstFrame === programCountAtReady`.
 */
const READY_STARTUP_DIAGNOSTIC = {
  encodedBodyBytes: 'number',
  errorCount: 'number',
  errorMessage: 'object',
  failedStage: 'object',
  firstPlayableMs: 'number',
  probeMeanMs: 'number',
  programCountAfterFirstFrame: 'number',
  programCountAtReady: 'number',
  programCountCurrent: 'number',
  progress: 'number',
  qualitySource: 'string',
  resourceCount: 'number',
  selectedRung: 'number',
  stage: 'string',
  transferBytes: 'number',
} as const;

interface DefinitionSite {
  readonly descriptorKeys: readonly string[];
  readonly file: string;
  readonly property: string;
}

async function collectTypeScriptPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectTypeScriptPaths(path)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) paths.push(path);
  }
  return paths;
}

async function parseSourceTree(root: string): Promise<ts.SourceFile[]> {
  const paths = await collectTypeScriptPaths(root);
  return Promise.all(
    paths.map(async (path) =>
      ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.ES2022, true),
    ),
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

function describeMembers(
  declaration: ts.InterfaceDeclaration,
  source: ts.SourceFile,
): Record<string, string> {
  const members: Record<string, string> = {};
  for (const member of declaration.members) {
    if (!ts.isPropertySignature(member)) {
      members[`<${ts.SyntaxKind[member.kind]}>`] = '<not a property signature>';
      continue;
    }
    const isReadonly =
      member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ===
      true;
    const name = `${member.name.getText(source)}${member.questionToken === undefined ? '' : '?'}`;
    const type = member.type === undefined ? '<implicit>' : member.type.getText(source);
    members[name] = `${isReadonly ? 'readonly ' : ''}${type}`;
  }
  return members;
}

function findInterface(
  sources: readonly ts.SourceFile[],
  name: string,
): { count: number; members: Record<string, string> | null } {
  let members: Record<string, string> | null = null;
  let count = 0;
  for (const source of sources) {
    walk(source, (node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== name) return;
      count += 1;
      members ??= describeMembers(node, source);
    });
  }
  return { count, members };
}

function isObjectDefineProperty(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'Object' &&
    expression.name.text === 'defineProperty'
  );
}

function collectDefinitionSites(sources: readonly ts.SourceFile[]): DefinitionSite[] {
  const sites: DefinitionSite[] = [];
  for (const source of sources) {
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !isObjectDefineProperty(node.expression)) return;
      const [, nameArgument, descriptor] = node.arguments;
      if (nameArgument === undefined || !ts.isStringLiteralLike(nameArgument)) return;
      if (!nameArgument.text.startsWith('solarVoyager')) return;
      sites.push({
        descriptorKeys:
          descriptor !== undefined && ts.isObjectLiteralExpression(descriptor)
            ? descriptor.properties.map(
                (property) => property.name?.getText(source) ?? '<computed>',
              )
            : ['<not an object literal>'],
        file: source.fileName,
        property: nameArgument.text,
      });
    });
  }
  return sites;
}

function readyStartupTracker(): StartupTracker {
  const tracker = new StartupTracker(0);
  tracker.advance('context');
  tracker.advance('star-catalog');
  tracker.advance('asset-manifest');
  tracker.advance('hero-spheres');
  tracker.advance('flight-shaders');
  tracker.advance('map-shaders');
  tracker.recordQuality(7, 'auto', 1.25);
  tracker.advance('post-ready');
  tracker.recordReady(1_234, {
    encodedBodyBytes: 4_096,
    programCount: 21,
    resourceCount: 9,
    transferBytes: 8_192,
  });
  tracker.recordFirstFrameProgramCount(21);
  return tracker;
}

let sources: readonly ts.SourceFile[] = [];

beforeAll(async () => {
  sources = await parseSourceTree(SOURCE_ROOT);
}, 30_000);

describe('canvas diagnostic definition sites', () => {
  test('src defines exactly the seven contract properties, once each', () => {
    const sites = collectDefinitionSites(sources);
    const properties = sites
      .map((site) => site.property)
      .sort((left, right) => left.localeCompare(right));
    expect(properties).toEqual([...DIAGNOSTIC_PROPERTIES]);
  });

  test('every diagnostic is a value-only, non-writable, non-configurable property', () => {
    const descriptors = Object.fromEntries(
      collectDefinitionSites(sources).map((site) => [site.property, site.descriptorKeys]),
    );
    expect(descriptors).toEqual(
      Object.fromEntries(DIAGNOSTIC_PROPERTIES.map((property) => [property, ['value']])),
    );
  });
});

describe('diagnostic shapes', () => {
  for (const [name, expected] of Object.entries(EXPECTED_MEMBERS)) {
    test(`${name} declares exactly its contract members`, () => {
      const { count, members } = findInterface(sources, name);
      expect(count, `${name} must be declared exactly once under src/`).toBe(1);
      expect(members).toEqual(expected);
    });
  }
});

describe('solarVoyagerStartup runtime discipline', () => {
  test('is frozen, prototype-less, and read-only through getters', () => {
    const diagnostic = readyStartupTracker().createDiagnostic();
    expect(Object.getPrototypeOf(diagnostic)).toBeNull();
    expect(Object.isFrozen(diagnostic)).toBe(true);
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(diagnostic));
    expect(descriptors.length).toBe(Object.keys(EXPECTED_MEMBERS.StartupDiagnostic ?? {}).length);
    expect(
      descriptors.every(
        (descriptor) =>
          descriptor.configurable === false &&
          descriptor.get !== undefined &&
          descriptor.set === undefined,
      ),
    ).toBe(true);
  });

  test('exposes every contract field with the readers expected type', () => {
    const diagnostic = readyStartupTracker().createDiagnostic();
    const shape = Object.fromEntries(
      Object.getOwnPropertyNames(diagnostic).map((key) => [
        key,
        typeof (diagnostic as unknown as Record<string, unknown>)[key],
      ]),
    );
    expect(shape).toEqual(READY_STARTUP_DIAGNOSTIC);
  });

  test('the unmeasured fields are null rather than absent before startup completes', () => {
    const diagnostic = new StartupTracker(0).createDiagnostic();
    expect({
      errorMessage: diagnostic.errorMessage,
      failedStage: diagnostic.failedStage,
      firstPlayableMs: diagnostic.firstPlayableMs,
      probeMeanMs: diagnostic.probeMeanMs,
      programCountAfterFirstFrame: diagnostic.programCountAfterFirstFrame,
      qualitySource: diagnostic.qualitySource,
      selectedRung: diagnostic.selectedRung,
      stage: diagnostic.stage,
    }).toEqual({
      errorMessage: null,
      failedStage: null,
      firstPlayableMs: null,
      probeMeanMs: null,
      programCountAfterFirstFrame: null,
      qualitySource: null,
      selectedRung: -1,
      stage: 'boot',
    });
  });
});

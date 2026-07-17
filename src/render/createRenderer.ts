import { HalfFloatType, WebGLRenderer, type WebGLRendererParameters } from 'three';

const SOFTWARE_RENDERER_PATTERN = /SwiftShader|llvmpipe|Software|Basic Render/iu;

export type DepthStrategy = 'reversed' | 'logarithmic';
export type RequestedDepthStrategy = 'auto' | DepthStrategy;

export interface WebGL2ContextResult {
  readonly context: WebGL2RenderingContext;
  readonly usedPerformanceCaveatFallback: boolean;
}

export interface RendererContextReport {
  readonly contextFlavor: 'webgl2';
  readonly depthStrategy: DepthStrategy;
  readonly effectiveContextAttributes: Readonly<WebGLContextAttributes> | null;
  readonly gpuTimerQueryAvailable: boolean;
  readonly rendererName: string;
  readonly softwareRasterizer: boolean;
  readonly usedPerformanceCaveatFallback: boolean;
  readonly warningRequired: boolean;
}

export interface RendererBootstrap {
  readonly renderer: WebGLRenderer;
  readonly contextReport: RendererContextReport;
}

export interface CreateRendererOptions {
  readonly depthStrategy?: RequestedDepthStrategy;
  readonly pixelRatio?: number;
}

interface WebGLDebugRendererInfo {
  readonly UNMASKED_RENDERER_WEBGL: number;
}

/** Returns the requested immutable-at-creation WebGL2 context attributes. */
export function createContextAttributes(
  failIfMajorPerformanceCaveat: boolean,
): WebGLContextAttributes {
  return {
    alpha: false,
    antialias: false,
    depth: true,
    desynchronized: true,
    failIfMajorPerformanceCaveat,
    powerPreference: 'high-performance',
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false,
  };
}

/** Creates WebGL2 strict-first, retrying only to keep software rendering usable. */
export function createWebGL2Context(canvas: HTMLCanvasElement): WebGL2ContextResult {
  let strictContext: WebGL2RenderingContext | null = null;
  try {
    strictContext = canvas.getContext('webgl2', createContextAttributes(true));
  } catch {
    // Some browsers throw instead of returning null for a major performance caveat.
  }
  if (strictContext !== null) {
    return { context: strictContext, usedPerformanceCaveatFallback: false };
  }

  let fallbackContext: WebGL2RenderingContext | null;
  try {
    fallbackContext = canvas.getContext('webgl2', createContextAttributes(false));
  } catch (cause: unknown) {
    throw new Error('Solar Voyager requires an available WebGL2 context.', { cause });
  }
  if (fallbackContext === null) {
    throw new Error('Solar Voyager requires an available WebGL2 context.');
  }
  return { context: fallbackContext, usedPerformanceCaveatFallback: true };
}

/** Selects exactly one supported solar-system depth strategy. */
export function selectDepthStrategy(
  context: WebGL2RenderingContext,
  requested: RequestedDepthStrategy = 'auto',
): DepthStrategy {
  const clipControlAvailable = context.getExtension('EXT_clip_control') !== null;
  if (requested === 'reversed' && !clipControlAvailable) {
    throw new Error('Reversed depth requires EXT_clip_control.');
  }
  if (requested === 'logarithmic') return 'logarithmic';
  return clipControlAvailable ? 'reversed' : 'logarithmic';
}

/** Returns Three.js parameters for an already-created WebGL2 context. */
export function createRendererParameters(
  canvas: HTMLCanvasElement,
  context: WebGL2RenderingContext,
  depthStrategy: DepthStrategy,
): WebGLRendererParameters {
  return {
    alpha: false,
    antialias: false,
    canvas,
    context,
    depth: true,
    logarithmicDepthBuffer: depthStrategy === 'logarithmic',
    outputBufferType: HalfFloatType,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    reversedDepthBuffer: depthStrategy === 'reversed',
    stencil: false,
  };
}

/** Reads the most specific renderer identity exposed by the browser. */
export function readRendererName(context: WebGL2RenderingContext): string {
  const debugInfo = context.getExtension(
    'WEBGL_debug_renderer_info',
  ) as WebGLDebugRendererInfo | null;
  if (debugInfo !== null) {
    const unmaskedName: unknown = context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    if (typeof unmaskedName === 'string' && unmaskedName.length > 0) return unmaskedName;
  }
  const rendererName: unknown = context.getParameter(context.RENDERER);
  return typeof rendererName === 'string' && rendererName.length > 0 ? rendererName : 'Unavailable';
}

export function isSoftwareRendererName(rendererName: string): boolean {
  return SOFTWARE_RENDERER_PATTERN.test(rendererName);
}

function copyContextAttributes(
  attributes: WebGLContextAttributes | null,
): Readonly<WebGLContextAttributes> | null {
  if (attributes === null) return null;
  return Object.freeze({
    alpha: attributes.alpha,
    antialias: attributes.antialias,
    depth: attributes.depth,
    desynchronized: attributes.desynchronized,
    failIfMajorPerformanceCaveat: attributes.failIfMajorPerformanceCaveat,
    powerPreference: attributes.powerPreference,
    premultipliedAlpha: attributes.premultipliedAlpha,
    preserveDrawingBuffer: attributes.preserveDrawingBuffer,
    stencil: attributes.stencil,
  });
}

/** Creates the renderer and immutable context telemetry in one bootstrap. */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): RendererBootstrap {
  const contextResult = createWebGL2Context(canvas);
  const depthStrategy = selectDepthStrategy(contextResult.context, options.depthStrategy ?? 'auto');
  const renderer = new WebGLRenderer(
    createRendererParameters(canvas, contextResult.context, depthStrategy),
  );
  const reversedDepthActive = renderer.capabilities.reversedDepthBuffer;
  if (reversedDepthActive !== (depthStrategy === 'reversed')) {
    renderer.dispose();
    throw new Error(`Three.js failed to activate the requested ${depthStrategy} depth strategy.`);
  }
  const rendererName = readRendererName(contextResult.context);
  const softwareRasterizer = isSoftwareRendererName(rendererName);
  const contextReport: RendererContextReport = Object.freeze({
    contextFlavor: 'webgl2',
    depthStrategy,
    effectiveContextAttributes: copyContextAttributes(contextResult.context.getContextAttributes()),
    gpuTimerQueryAvailable:
      !softwareRasterizer &&
      contextResult.context.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    rendererName,
    softwareRasterizer,
    usedPerformanceCaveatFallback: contextResult.usedPerformanceCaveatFallback,
    warningRequired: contextResult.usedPerformanceCaveatFallback || softwareRasterizer,
  });

  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  return { renderer, contextReport };
}

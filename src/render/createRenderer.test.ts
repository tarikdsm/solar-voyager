import { HalfFloatType } from 'three';
import { describe, expect, it } from 'vitest';

import {
  createContextAttributes,
  createRendererContextReport,
  createRendererParameters,
  createWebGL2Context,
  isSoftwareRendererName,
  readRendererName,
  selectDepthStrategy,
} from './createRenderer.js';

interface FakeContextOptions {
  readonly clipControl?: boolean;
  readonly debugRenderer?: string;
  readonly renderer?: string;
  readonly timerQuery?: boolean;
}

function fakeContext(options: FakeContextOptions = {}): WebGL2RenderingContext {
  const debugInfo = { UNMASKED_RENDERER_WEBGL: 9_999 };
  return {
    RENDERER: 7_937,
    getContextAttributes: () => createContextAttributes(false),
    getExtension(name: string) {
      if (name === 'EXT_clip_control') return options.clipControl === true ? {} : null;
      if (name === 'EXT_disjoint_timer_query_webgl2') {
        return options.timerQuery === true ? {} : null;
      }
      if (name === 'WEBGL_debug_renderer_info') {
        return options.debugRenderer === undefined ? null : debugInfo;
      }
      return null;
    },
    getParameter(parameter: number) {
      if (parameter === debugInfo.UNMASKED_RENDERER_WEBGL) return options.debugRenderer;
      if (parameter === 7_937) return options.renderer ?? 'WebKit WebGL';
      return null;
    },
  } as unknown as WebGL2RenderingContext;
}

describe('GPU renderer bootstrap policy', () => {
  it('requests the complete strict hardware context attributes', () => {
    expect(createContextAttributes(true)).toEqual({
      alpha: false,
      antialias: false,
      depth: true,
      desynchronized: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
  });

  it('retries a rejected strict context with only the caveat flag relaxed', () => {
    const context = fakeContext();
    const attempts: WebGLContextAttributes[] = [];
    const canvas = {
      getContext(name: string, attributes?: WebGLContextAttributes) {
        expect(name).toBe('webgl2');
        if (attributes !== undefined) attempts.push(attributes);
        return attempts.length === 1 ? null : context;
      },
    } as unknown as HTMLCanvasElement;

    const result = createWebGL2Context(canvas);

    expect(result.context).toBe(context);
    expect(result.usedPerformanceCaveatFallback).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.failIfMajorPerformanceCaveat).toBe(true);
    expect(attempts[1]).toEqual({
      ...attempts[0],
      failIfMajorPerformanceCaveat: false,
    });
  });

  it('retries when the browser throws while rejecting the strict context', () => {
    const context = fakeContext();
    const attempts: WebGLContextAttributes[] = [];
    const canvas = {
      getContext(name: string, attributes?: WebGLContextAttributes) {
        expect(name).toBe('webgl2');
        if (attributes !== undefined) attempts.push(attributes);
        if (attempts.length === 1) throw new Error('Strict context rejected.');
        return context;
      },
    } as unknown as HTMLCanvasElement;

    expect(createWebGL2Context(canvas)).toEqual({
      context,
      usedPerformanceCaveatFallback: true,
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.failIfMajorPerformanceCaveat).toBe(true);
    expect(attempts[1]?.failIfMajorPerformanceCaveat).toBe(false);
  });

  it('does not retry a successful strict context and fails after two null attempts', () => {
    const context = fakeContext();
    let strictCalls = 0;
    const strictCanvas = {
      getContext() {
        strictCalls += 1;
        return context;
      },
    } as unknown as HTMLCanvasElement;
    expect(createWebGL2Context(strictCanvas)).toEqual({
      context,
      usedPerformanceCaveatFallback: false,
    });
    expect(strictCalls).toBe(1);

    const unavailableCanvas = {
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(() => createWebGL2Context(unavailableCanvas)).toThrow(/WebGL2/u);
  });

  it('selects reversed depth only with EXT_clip_control and supports forced regressions', () => {
    expect(selectDepthStrategy(fakeContext({ clipControl: true }), 'auto')).toBe('reversed');
    expect(selectDepthStrategy(fakeContext(), 'auto')).toBe('logarithmic');
    expect(selectDepthStrategy(fakeContext({ clipControl: true }), 'logarithmic')).toBe(
      'logarithmic',
    );
    expect(selectDepthStrategy(fakeContext({ clipControl: true }), 'reversed')).toBe('reversed');
    expect(() => selectDepthStrategy(fakeContext(), 'reversed')).toThrow(/EXT_clip_control/u);
  });

  it('passes one depth strategy and half-float output to Three.js', () => {
    const canvas = {} as HTMLCanvasElement;
    const context = fakeContext();

    const reversed = createRendererParameters(canvas, context, 'reversed');
    expect(reversed.canvas).toBe(canvas);
    expect(reversed.context).toBe(context);
    expect(reversed.reversedDepthBuffer).toBe(true);
    expect(reversed.logarithmicDepthBuffer).toBe(false);
    expect(reversed.outputBufferType).toBe(HalfFloatType);
    expect(reversed.powerPreference).toBe('high-performance');

    const logarithmic = createRendererParameters(canvas, context, 'logarithmic');
    expect(logarithmic.reversedDepthBuffer).toBe(false);
    expect(logarithmic.logarithmicDepthBuffer).toBe(true);
  });

  it('uses unmasked identity when available and classifies software renderers', () => {
    expect(readRendererName(fakeContext({ debugRenderer: 'ANGLE (NVIDIA RTX 4060)' }))).toBe(
      'ANGLE (NVIDIA RTX 4060)',
    );
    expect(readRendererName(fakeContext({ renderer: 'Fallback renderer' }))).toBe(
      'Fallback renderer',
    );

    for (const rendererName of [
      'ANGLE (Google, Vulkan 1.3 SwiftShader Device)',
      'llvmpipe (LLVM 17.0)',
      'Software Rasterizer',
      'Microsoft Basic Render Driver',
    ]) {
      expect(isSoftwareRendererName(rendererName)).toBe(true);
    }
    expect(isSoftwareRendererName('ANGLE (Intel Iris Xe Graphics)')).toBe(false);
    expect(isSoftwareRendererName('NVIDIA GeForce RTX 4060')).toBe(false);
  });

  it('keeps a strict hardware report warning-free and enables its GPU timer', () => {
    const report = createRendererContextReport(
      fakeContext({
        clipControl: true,
        debugRenderer: 'ANGLE (Intel Iris Xe Graphics)',
        timerQuery: true,
      }),
      'reversed',
      false,
    );

    expect(report).toMatchObject({
      depthStrategy: 'reversed',
      gpuTimerQueryAvailable: true,
      rendererName: 'ANGLE (Intel Iris Xe Graphics)',
      softwareRasterizer: false,
      usedPerformanceCaveatFallback: false,
      warningRequired: false,
    });
  });
});

import { Euler, PerspectiveCamera, Vector4, type Camera, type Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import { StateVectorWidget, type StateVectorRendererPort } from './stateVectorWidget.js';

class FakeRenderer implements StateVectorRendererPort {
  autoClear = true;
  readonly viewport = new Vector4(5, 6, 700, 500);
  readonly scissor = new Vector4(7, 8, 650, 450);
  scissorTest = false;
  clearDepthCalls = 0;
  renderCalls = 0;
  renderedScene: Scene | null = null;
  renderedCamera: Camera | null = null;

  getViewport(target: Vector4): Vector4 {
    return target.copy(this.viewport);
  }

  getScissor(target: Vector4): Vector4 {
    return target.copy(this.scissor);
  }

  getScissorTest(): boolean {
    return this.scissorTest;
  }

  setViewport(x: number | Vector4, y?: number, width?: number, height?: number): void {
    if (x instanceof Vector4) this.viewport.copy(x);
    else this.viewport.set(x, y as number, width as number, height as number);
  }

  setScissor(x: number | Vector4, y?: number, width?: number, height?: number): void {
    if (x instanceof Vector4) this.scissor.copy(x);
    else this.scissor.set(x, y as number, width as number, height as number);
  }

  setScissorTest(enabled: boolean): void {
    this.scissorTest = enabled;
  }

  clearDepth(): void {
    this.clearDepthCalls += 1;
  }

  render(scene: Scene, camera: Camera): void {
    this.renderCalls += 1;
    this.renderedScene = scene;
    this.renderedCamera = camera;
  }
}

function createSnapshot() {
  const snapshot = createSimulationSnapshotBuffer(['sun', 'earth']);
  snapshot.shipCmRelativeVelocityKmS.set([30, 40, 0]);
  snapshot.shipProperAccelerationKmS2.set([0, 0, 0.009_806_65]);
  snapshot.shipRelativisticMomentumKgKmS.set([-300_000, 0, 0]);
  snapshot.shipAngularMomentumKgKm2S.set([0, 5e16, 0]);
  return snapshot;
}

describe('StateVectorWidget', () => {
  it('creates resources once and mutates the same vector buffers across updates', () => {
    const widget = new StateVectorWidget();
    const camera = new PerspectiveCamera();
    const snapshot = createSnapshot();
    const lines = widget.vectorLines.slice();
    const geometries = lines.map((line) => line.geometry);
    const materials = lines.map((line) => line.material);

    widget.update(snapshot, camera);
    snapshot.shipCmRelativeVelocityKmS.set([0, 30, 40]);
    widget.update(snapshot, camera);

    expect(widget.vectorLines).toEqual(lines);
    expect(widget.vectorLines.map((line) => line.geometry)).toEqual(geometries);
    expect(widget.vectorLines.map((line) => line.material)).toEqual(materials);
    expect(widget.visibleMask).toBe(0b1111);
    expect(widget.endpointComponents[0]).toBe(0);
    expect(widget.endpointComponents[1]).toBeGreaterThan(0);
    expect(widget.endpointComponents[2]).toBeGreaterThan(0);
  });

  it('follows the inverse main-camera rotation and can pin fixed ecliptic axes', () => {
    const widget = new StateVectorWidget();
    const camera = new PerspectiveCamera();
    camera.quaternion.setFromEuler(new Euler(0.3, -0.6, 0.2));
    const expected = camera.quaternion.clone().invert();

    widget.update(createSnapshot(), camera);
    expect(widget.orientationRoot.quaternion.angleTo(expected)).toBeLessThan(1e-7);

    widget.setPinnedToEcliptic(true);
    widget.update(createSnapshot(), camera);
    const pinned = widget.orientationRoot.quaternion.clone();
    camera.quaternion.setFromEuler(new Euler(-0.7, 0.9, 0.4));
    widget.update(createSnapshot(), camera);
    expect(widget.orientationRoot.quaternion.angleTo(pinned)).toBeLessThan(1e-7);
  });

  it('renders inside the cached scissor and restores every renderer state', () => {
    const widget = new StateVectorWidget();
    const renderer = new FakeRenderer();
    widget.setViewportPixels(900, 24, 240, 240);

    widget.render(renderer);

    expect(renderer.renderCalls).toBe(1);
    expect(renderer.renderedScene).toBe(widget.scene);
    expect(renderer.renderedCamera).toBe(widget.camera);
    expect(renderer.clearDepthCalls).toBe(1);
    expect(renderer.viewport.toArray()).toEqual([5, 6, 700, 500]);
    expect(renderer.scissor.toArray()).toEqual([7, 8, 650, 450]);
    expect(renderer.scissorTest).toBe(false);
    expect(renderer.autoClear).toBe(true);
    expect(widget.lastRenderMs).toBeGreaterThanOrEqual(0);
  });

  it('skips an empty viewport and validates finite nonnegative pixel bounds', () => {
    const widget = new StateVectorWidget();
    const renderer = new FakeRenderer();

    widget.render(renderer);
    expect(renderer.renderCalls).toBe(0);
    expect(() => widget.setViewportPixels(Number.NaN, 0, 1, 1)).toThrow(RangeError);
    expect(() => widget.setViewportPixels(0, 0, -1, 1)).toThrow(RangeError);
  });

  it('disposes setup-time geometries and materials exactly once', () => {
    const widget = new StateVectorWidget();
    const geometrySpies = widget.disposableGeometries.map((geometry) =>
      vi.spyOn(geometry, 'dispose'),
    );
    const materialSpies = widget.disposableMaterials.map((material) =>
      vi.spyOn(material, 'dispose'),
    );

    widget.dispose();

    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of materialSpies) expect(spy).toHaveBeenCalledOnce();
  });
});

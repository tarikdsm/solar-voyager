import {
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  type IcosahedronGeometry,
  type Material,
  type Object3D,
  type ShaderMaterial,
} from 'three';

import type { RingDefinition } from './ringCatalog.js';
import { prepareRingMaterials, type PreparedRingMaterials } from './ringMaterial.js';
import { RingParticleField } from './ringParticleField.js';

export interface RingBodyDefinition {
  readonly axialTiltRad: number;
  readonly meanRadiusKm: number;
  readonly muKm3S2: number;
  readonly polarRadiusRatio: number;
}

export interface PreparedRingSystem {
  readonly blend: number;
  readonly particleMesh: InstancedMesh<IcosahedronGeometry, ShaderMaterial> | null;
  update(
    cameraBodyXKm: number,
    cameraBodyYKm: number,
    cameraBodyZKm: number,
    sunBodyXKm: number,
    sunBodyYKm: number,
    sunBodyZKm: number,
    simTimeSec: number,
  ): void;
  setParticleCount(count: number): void;
  dispose(): void;
}

function standardMaterials(materials: readonly Material[], name: string): MeshStandardMaterial[] {
  return materials.filter(
    (material): material is MeshStandardMaterial =>
      material instanceof MeshStandardMaterial && material.name === name,
  );
}

function meshUsesMaterial(root: Object3D, material: Material): Mesh | null {
  let match: Mesh | null = null;
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const usesMaterial = Array.isArray(object.material)
      ? object.material.includes(material)
      : object.material === material;
    if (!usesMaterial) return;
    if (match !== null)
      throw new Error(`Ring asset uses material "${material.name}" on multiple meshes.`);
    match = object;
  });
  return match;
}

function assertBody(body: RingBodyDefinition): void {
  if (
    !Number.isFinite(body.axialTiltRad) ||
    body.axialTiltRad < 0 ||
    body.axialTiltRad > Math.PI * 2
  ) {
    throw new RangeError('Ring body axial tilt must be finite and within one turn.');
  }
  if (!Number.isFinite(body.meanRadiusKm) || body.meanRadiusKm <= 0) {
    throw new RangeError('Ring body mean radius must be positive and finite.');
  }
  if (!Number.isFinite(body.muKm3S2) || body.muKm3S2 <= 0) {
    throw new RangeError('Ring body gravitational parameter must be positive and finite.');
  }
  if (
    !Number.isFinite(body.polarRadiusRatio) ||
    body.polarRadiusRatio <= 0 ||
    body.polarRadiusRatio > 1
  ) {
    throw new RangeError('Ring body polar-radius ratio must be finite and in the interval (0, 1].');
  }
}

class PreparedRingSystemImpl implements PreparedRingSystem {
  private readonly tiltCos: number;
  private readonly tiltSin: number;
  private disposed = false;

  constructor(
    private readonly root: Object3D,
    private readonly referenceRadiusKm: number,
    axialTiltRad: number,
    private readonly materials: PreparedRingMaterials,
    private readonly particles: RingParticleField | null,
  ) {
    this.tiltCos = Math.cos(axialTiltRad);
    this.tiltSin = Math.sin(axialTiltRad);
  }

  get blend(): number {
    return this.particles?.blend ?? 0;
  }

  get particleMesh(): InstancedMesh<IcosahedronGeometry, ShaderMaterial> | null {
    return this.particles?.mesh ?? null;
  }

  update(
    cameraBodyXKm: number,
    cameraBodyYKm: number,
    cameraBodyZKm: number,
    sunBodyXKm: number,
    sunBodyYKm: number,
    sunBodyZKm: number,
    simTimeSec: number,
  ): void {
    if (
      !Number.isFinite(cameraBodyXKm) ||
      !Number.isFinite(cameraBodyYKm) ||
      !Number.isFinite(cameraBodyZKm) ||
      !Number.isFinite(sunBodyXKm) ||
      !Number.isFinite(sunBodyYKm) ||
      !Number.isFinite(sunBodyZKm) ||
      !Number.isFinite(simTimeSec)
    ) {
      throw new RangeError('Ring-system camera, Sun, and simulation values must be finite.');
    }

    const localSunX = this.tiltCos * sunBodyXKm + this.tiltSin * sunBodyYKm;
    const localSunY = -this.tiltSin * sunBodyXKm + this.tiltCos * sunBodyYKm;
    this.materials.updateSunDirection(localSunX, localSunY, sunBodyZKm);

    let blend = 0;
    if (this.particles !== null) {
      const inverseRadius = 1 / this.referenceRadiusKm;
      const localCameraX =
        (this.tiltCos * cameraBodyXKm + this.tiltSin * cameraBodyYKm) * inverseRadius;
      const localCameraY =
        (-this.tiltSin * cameraBodyXKm + this.tiltCos * cameraBodyYKm) * inverseRadius;
      blend = this.particles.update(
        localCameraX,
        localCameraY,
        cameraBodyZKm * inverseRadius,
        simTimeSec,
      );
    }
    this.materials.setRepresentationBlend(blend);
  }

  setParticleCount(count: number): void {
    this.particles?.setCountCap(count);
    if (this.particles === null || count === 0) this.materials.setRepresentationBlend(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.particles !== null) {
      this.root.remove(this.particles.mesh);
      this.particles.dispose();
    }
    this.materials.dispose();
  }
}

export function prepareRingSystem(
  root: Object3D,
  materials: readonly Material[],
  definition: RingDefinition,
  body: RingBodyDefinition,
): PreparedRingSystem | null {
  assertBody(body);
  const surfaceMaterials = standardMaterials(materials, 'mat_surface');
  const ringMaterials = standardMaterials(materials, 'mat_rings');
  if (surfaceMaterials.length === 0 && ringMaterials.length === 0) return null;
  if (surfaceMaterials.length === 0 || ringMaterials.length === 0) {
    throw new Error(
      `Ring asset "${definition.bodyId}" is incomplete: surface and ring materials are required.`,
    );
  }
  if (surfaceMaterials.length !== 1 || ringMaterials.length !== 1) {
    throw new Error(
      `Ring asset "${definition.bodyId}" must contain exactly one surface and ring material.`,
    );
  }
  const surface = surfaceMaterials[0];
  const rings = ringMaterials[0];
  if (surface === undefined || rings === undefined)
    throw new Error('Ring material pairing failed.');
  const surfaceMesh = meshUsesMaterial(root, surface);
  const ringMesh = meshUsesMaterial(root, rings);
  if (surfaceMesh === null || ringMesh === null) {
    throw new Error(`Ring asset "${definition.bodyId}" is incomplete: paired meshes are required.`);
  }

  root.rotation.z = body.axialTiltRad;
  const preparedMaterials = prepareRingMaterials(surface, rings, definition, body.polarRadiusRatio);
  let particles: RingParticleField | null = null;
  try {
    if (definition.particles !== null) {
      particles = new RingParticleField(definition, body.muKm3S2, definition.referenceRadiusKm);
      root.add(particles.mesh);
    }
  } catch {
    particles = null;
  }
  return new PreparedRingSystemImpl(
    root,
    definition.referenceRadiusKm,
    body.axialTiltRad,
    preparedMaterials,
    particles,
  );
}

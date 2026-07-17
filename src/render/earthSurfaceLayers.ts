import {
  AdditiveBlending,
  BackSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from 'three';

const ATMOSPHERE_CACHE_KEY = 'solar-voyager-earth-atmosphere-v1';
const ATMOSPHERE_SCALE = 1.012;
const CLOUD_ROTATION_PERIOD_MS = 6 * 60 * 60 * 1_000;
const CLOUD_ANGULAR_SPEED_RAD_PER_MS = (Math.PI * 2) / CLOUD_ROTATION_PERIOD_MS;

export interface PreparedEarthSurfaceLayers {
  update(nowMs: number): void;
  dispose(): void;
}

function findCloudMesh(root: Object3D): Mesh<BufferGeometry, MeshStandardMaterial> | null {
  let result: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
  root.traverse((object) => {
    if (result !== null || !(object instanceof Mesh) || Array.isArray(object.material)) return;
    if (object.material instanceof MeshStandardMaterial && object.material.name === 'mat_clouds') {
      result = object as Mesh<BufferGeometry, MeshStandardMaterial>;
    }
  });
  return result;
}

function createAtmosphereMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: 0x4ea5ff,
    opacity: 0.22,
    transparent: true,
    blending: AdditiveBlending,
    side: BackSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: true,
  });
  material.name = 'mat_atmosphere';
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
    previousCompile.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vAtmosphereNormal;
varying vec3 vAtmosphereViewDirection;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAtmosphereNormal = normalize( normalMatrix * normal );
vec3 solarVoyagerAtmosphereViewPosition = ( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;
vAtmosphereViewDirection = normalize( -solarVoyagerAtmosphereViewPosition );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vAtmosphereNormal;
varying vec3 vAtmosphereViewDirection;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float atmosphereFresnel = pow(
  clamp( 1.0 - abs( dot( normalize( vAtmosphereNormal ), normalize( vAtmosphereViewDirection ) ) ), 0.0, 1.0 ),
  2.4
);
diffuseColor.a *= smoothstep( 0.05, 0.95, atmosphereFresnel );`,
      );
  };
  material.customProgramCacheKey = (): string => `${previousCacheKey()}|${ATMOSPHERE_CACHE_KEY}`;
  material.needsUpdate = true;
  return material;
}

class PreparedEarthSurfaceLayersImpl implements PreparedEarthSurfaceLayers {
  private disposed = false;

  constructor(
    private readonly cloudMesh: Mesh<BufferGeometry, MeshStandardMaterial>,
    private readonly atmosphereMesh: Mesh<BufferGeometry, MeshBasicMaterial>,
    private readonly initialCloudRotationY: number,
  ) {}

  update(nowMs: number): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('Earth cloud time must be finite.');
    this.cloudMesh.rotation.y = this.initialCloudRotationY + nowMs * CLOUD_ANGULAR_SPEED_RAD_PER_MS;
    this.cloudMesh.updateMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.atmosphereMesh.removeFromParent();
    this.atmosphereMesh.material.dispose();
  }
}

export function prepareEarthSurfaceLayers(
  root: Object3D,
  materials: Material[],
): PreparedEarthSurfaceLayers | null {
  const cloudMesh = findCloudMesh(root);
  if (cloudMesh === null || cloudMesh.parent === null) return null;

  const atmosphereMaterial = createAtmosphereMaterial();
  const atmosphereMesh = new Mesh(cloudMesh.geometry, atmosphereMaterial);
  atmosphereMesh.name = 'earth-atmosphere-rim';
  atmosphereMesh.position.copy(cloudMesh.position);
  atmosphereMesh.quaternion.copy(cloudMesh.quaternion);
  atmosphereMesh.scale.copy(cloudMesh.scale).multiplyScalar(ATMOSPHERE_SCALE);
  atmosphereMesh.matrixAutoUpdate = false;
  atmosphereMesh.updateMatrix();
  atmosphereMesh.renderOrder = cloudMesh.renderOrder + 1;
  cloudMesh.parent.add(atmosphereMesh);
  materials.push(atmosphereMaterial);

  return new PreparedEarthSurfaceLayersImpl(cloudMesh, atmosphereMesh, cloudMesh.rotation.y);
}

/** A read-only view of an IEEE-754 binary64 vector. Units follow physics-spec.md §1. */
export interface ReadonlyVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A mutable, caller-owned IEEE-754 binary64 vector. */
export interface Vec3 extends ReadonlyVec3 {
  x: number;
  y: number;
  z: number;
}

/** Creates a vector. Prefer the `*Into` operations inside hot paths. */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** Returns a newly allocated component-wise sum. */
export function add(left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  return addInto(vec3(), left, right);
}

/** Writes a component-wise sum into `output`, which may alias either input. */
export function addInto(output: Vec3, left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  output.x = left.x + right.x;
  output.y = left.y + right.y;
  output.z = left.z + right.z;
  return output;
}

/** Returns a newly allocated component-wise difference. */
export function sub(left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  return subInto(vec3(), left, right);
}

/** Writes a component-wise difference into `output`, which may alias either input. */
export function subInto(output: Vec3, left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  output.x = left.x - right.x;
  output.y = left.y - right.y;
  output.z = left.z - right.z;
  return output;
}

/** Returns a newly allocated vector multiplied by `scalar`. */
export function scale(vector: ReadonlyVec3, scalar: number): Vec3 {
  return scaleInto(vec3(), vector, scalar);
}

/** Writes a scalar product into `output`, which may alias `vector`. */
export function scaleInto(output: Vec3, vector: ReadonlyVec3, scalar: number): Vec3 {
  output.x = vector.x * scalar;
  output.y = vector.y * scalar;
  output.z = vector.z * scalar;
  return output;
}

/** Computes the scalar dot product without allocating. */
export function dot(left: ReadonlyVec3, right: ReadonlyVec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

/** Returns a newly allocated right-handed cross product. */
export function cross(left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  return crossInto(vec3(), left, right);
}

/** Writes a right-handed cross product and permits `output` to alias either input. */
export function crossInto(output: Vec3, left: ReadonlyVec3, right: ReadonlyVec3): Vec3 {
  const x = left.y * right.z - left.z * right.y;
  const y = left.z * right.x - left.x * right.z;
  const z = left.x * right.y - left.y * right.x;

  output.x = x;
  output.y = y;
  output.z = z;
  return output;
}

/** Computes the Euclidean norm without allocating. */
export function norm(vector: ReadonlyVec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

/** Returns a newly allocated unit vector, or finite zero for a zero input. */
export function normalize(vector: ReadonlyVec3): Vec3 {
  return normalizeInto(vec3(), vector);
}

/** Writes a unit vector, or the finite zero vector when the input norm is zero. */
export function normalizeInto(output: Vec3, vector: ReadonlyVec3): Vec3 {
  const length = norm(vector);

  if (length === 0) {
    output.x = 0;
    output.y = 0;
    output.z = 0;
    return output;
  }

  const inverseLength = 1 / length;
  return scaleInto(output, vector, inverseLength);
}

/** Computes Euclidean distance without allocating. */
export function distance(left: ReadonlyVec3, right: ReadonlyVec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

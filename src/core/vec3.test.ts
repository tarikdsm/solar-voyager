import { describe, expect, it } from 'vitest';

import {
  add,
  addInto,
  cross,
  crossInto,
  distance,
  dot,
  norm,
  normalize,
  normalizeInto,
  scale,
  scaleInto,
  sub,
  subInto,
  vec3,
} from './vec3.js';

describe('vec3 — physics-spec.md §1', () => {
  it('constructs a zero vector by default and accepts components', () => {
    expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3(1, -2, 3)).toEqual({ x: 1, y: -2, z: 3 });
  });

  it('adds without mutating either operand', () => {
    const left = vec3(1, 2, 3);
    const right = vec3(4, -5, 6);

    expect(add(left, right)).toEqual({ x: 5, y: -3, z: 9 });
    expect(left).toEqual({ x: 1, y: 2, z: 3 });
    expect(right).toEqual({ x: 4, y: -5, z: 6 });
  });

  it('subtracts and scales without mutating operands', () => {
    const vector = vec3(3, -4, 5);

    expect(sub(vector, vec3(1, 2, 3))).toEqual({ x: 2, y: -6, z: 2 });
    expect(scale(vector, -2)).toEqual({ x: -6, y: 8, z: -10 });
    expect(vector).toEqual({ x: 3, y: -4, z: 5 });
  });

  it('computes dot products, norms, and distances', () => {
    expect(dot(vec3(1, 2, 3), vec3(4, -5, 6))).toBe(12);
    expect(norm(vec3(2, -3, 6))).toBe(7);
    expect(distance(vec3(1, 2, 3), vec3(4, 6, 3))).toBe(5);
  });

  it('computes a right-handed cross product without mutating operands', () => {
    const xAxis = vec3(1, 0, 0);
    const yAxis = vec3(0, 1, 0);

    expect(cross(xAxis, yAxis)).toEqual({ x: 0, y: 0, z: 1 });
    expect(xAxis).toEqual({ x: 1, y: 0, z: 0 });
    expect(yAxis).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('normalizes vectors and maps the zero vector to zero', () => {
    const input = vec3(0, 3, 4);
    const normalized = normalize(input);

    expect(normalized.x).toBe(0);
    expect(norm(normalized)).toBe(1);
    expect(dot(normalized, input)).toBe(norm(input));
    expect(normalize(vec3())).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('writes allocation-free operations into caller-owned output', () => {
    const output = vec3();

    expect(addInto(output, vec3(1, 2, 3), vec3(4, 5, 6))).toBe(output);
    expect(output).toEqual({ x: 5, y: 7, z: 9 });
    expect(subInto(output, vec3(5, 7, 9), vec3(1, 2, 3))).toBe(output);
    expect(output).toEqual({ x: 4, y: 5, z: 6 });
    expect(scaleInto(output, vec3(4, 5, 6), 0.5)).toBe(output);
    expect(output).toEqual({ x: 2, y: 2.5, z: 3 });
    expect(normalizeInto(output, vec3(0, 0, 5))).toBe(output);
    expect(output).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('supports output aliasing either input', () => {
    const left = vec3(1, 2, 3);
    const right = vec3(4, 5, 6);

    addInto(left, left, right);
    expect(left).toEqual({ x: 5, y: 7, z: 9 });
    subInto(right, left, right);
    expect(right).toEqual({ x: 1, y: 2, z: 3 });
    scaleInto(right, right, 2);
    expect(right).toEqual({ x: 2, y: 4, z: 6 });
    normalizeInto(right, right);
    expect(norm(right)).toBe(1);
    expect(right.y).toBe(right.x * 2);
    expect(right.z).toBe(right.x * 3);
  });

  it('keeps crossInto alias-safe for either input', () => {
    const left = vec3(1, 2, 3);
    const right = vec3(4, 5, 6);

    expect(crossInto(left, left, right)).toBe(left);
    expect(left).toEqual({ x: -3, y: 6, z: -3 });

    const nextLeft = vec3(1, 2, 3);
    const nextRight = vec3(4, 5, 6);
    crossInto(nextRight, nextLeft, nextRight);
    expect(nextRight).toEqual({ x: -3, y: 6, z: -3 });
  });

  it('writes a finite zero when normalizing zero into aliased output', () => {
    const zero = vec3();

    normalizeInto(zero, zero);

    expect(zero).toEqual({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(zero.x)).toBe(true);
    expect(Number.isFinite(zero.y)).toBe(true);
    expect(Number.isFinite(zero.z)).toBe(true);
  });
});

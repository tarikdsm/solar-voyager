import { describe, expect, it } from 'vitest';

import bodiesDocument from '../../../data/bodies.json';
import { createAudioBodyClasses } from './audioBodyClasses.js';

const CLASSES = createAudioBodyClasses();

function classOf(id: string): string {
  const index = bodiesDocument.bodies.findIndex((body) => body.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return CLASSES[index] as string;
}

describe('createAudioBodyClasses', () => {
  it('covers the catalog exactly, in catalog order', () => {
    expect(CLASSES).toHaveLength(bodiesDocument.bodies.length);
    expect(Object.isFrozen(CLASSES)).toBe(true);
  });

  it('hears the Sun as a star', () => {
    expect(classOf('sun')).toBe('star');
  });

  it('hears all four gas giants as giants and nothing else', () => {
    const giants = bodiesDocument.bodies
      .filter((_body, index) => CLASSES[index] === 'giant')
      .map((body) => body.id);
    expect(giants).toEqual(['jupiter', 'saturn', 'uranus', 'neptune']);
  });

  it('hears planets and dwarf planets as worlds you orbit', () => {
    expect(classOf('earth')).toBe('terrestrial');
    expect(classOf('mercury')).toBe('terrestrial');
    expect(classOf('pluto')).toBe('terrestrial');
  });

  it('hears moons as moons', () => {
    expect(classOf('moon')).toBe('moon');
    expect(classOf('io')).toBe('moon');
  });

  it('hears asteroids and comets as small bodies', () => {
    expect(classOf('vesta')).toBe('small');
    expect(classOf('67p')).toBe('small');
  });

  it('never leaves a body unclassified', () => {
    expect(CLASSES.includes('none')).toBe(false);
  });
});

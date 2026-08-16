/**
 * Preallocated segment capacity of the runtime batch.
 *
 * Duplicated from `constellationLines.ts` rather than imported so this parser
 * stays free of three.js; the pair is locked together by a unit test.
 */
export const CONSTELLATION_SEGMENT_CAPACITY = 1_024;

/** Two star indices per drawn segment, little-endian uint16. */
export const CONSTELLATION_INDICES_PER_SEGMENT = 2;
export const CONSTELLATION_BYTES_PER_SEGMENT =
  CONSTELLATION_INDICES_PER_SEGMENT * Uint16Array.BYTES_PER_ELEMENT;

const endianProbe = new Uint16Array([0x00ff]);
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(endianProbe.buffer)[0] === 0xff;

/**
 * Validated view over `data/constellations.bin`.
 *
 * The payload carries only star indices into `data/stars.bin` — no coordinates,
 * no names. The figures are therefore drawn from the same catalog the starfield
 * draws, so a line can never miss its own star.
 */
export interface ConstellationLineCatalog {
  readonly segmentCount: number;
  readonly starIndices: Uint16Array;
}

/** Parses the packed segment payload, bounds-checking every index. */
export function parseConstellationLines(
  buffer: ArrayBuffer,
  starCount: number,
): ConstellationLineCatalog {
  if (!HOST_IS_LITTLE_ENDIAN) {
    throw new Error('constellation catalog requires a little-endian JavaScript host');
  }
  if (!Number.isInteger(starCount) || starCount <= 0) {
    throw new RangeError(`constellation catalog needs a positive star count: ${starCount}`);
  }
  if (buffer.byteLength === 0 || buffer.byteLength % CONSTELLATION_BYTES_PER_SEGMENT !== 0) {
    throw new RangeError(
      `constellation catalog byte length must be a positive multiple of ${CONSTELLATION_BYTES_PER_SEGMENT}`,
    );
  }
  const starIndices = new Uint16Array(buffer);
  for (let index = 0; index < starIndices.length; index += 1) {
    const starIndex = starIndices[index] as number;
    if (starIndex >= starCount) {
      throw new RangeError(
        `constellation catalog references star ${starIndex} outside the ${starCount}-star catalog`,
      );
    }
  }
  const segmentCount = buffer.byteLength / CONSTELLATION_BYTES_PER_SEGMENT;
  if (segmentCount > CONSTELLATION_SEGMENT_CAPACITY) {
    throw new RangeError(
      `constellation catalog has ${segmentCount} segments; the preallocated batch holds ${CONSTELLATION_SEGMENT_CAPACITY}`,
    );
  }
  for (let segment = 0; segment < segmentCount; segment += 1) {
    if (starIndices[segment * 2] === starIndices[segment * 2 + 1]) {
      throw new RangeError(`constellation catalog segment ${segment} joins a star to itself`);
    }
  }
  return Object.freeze({ segmentCount, starIndices });
}

export type ConstellationFetcher = (input: string | URL) => Promise<Response>;

/** Fetches and validates the constellation payload after the space phase starts. */
export async function loadConstellationLines(
  url: string | URL,
  starCount: number,
  fetcher: ConstellationFetcher = fetch,
): Promise<ConstellationLineCatalog> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`failed to load constellation lines: HTTP ${response.status}`);
  }
  return parseConstellationLines(await response.arrayBuffer(), starCount);
}

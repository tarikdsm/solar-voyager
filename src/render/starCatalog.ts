export const STAR_STRIDE_FLOATS = 7;
export const STAR_BYTES_PER_RECORD = STAR_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

const endianProbe = new Uint16Array([0x00ff]);
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(endianProbe.buffer)[0] === 0xff;

/** Validated startup-time view over the interleaved star catalog payload. */
export interface StarCatalog {
  readonly starCount: number;
  readonly strideFloats: typeof STAR_STRIDE_FLOATS;
  readonly data: Float32Array;
}

/** Parse the little-endian seven-float catalog without copying its payload. */
export function parseStarCatalog(buffer: ArrayBuffer): StarCatalog {
  if (!HOST_IS_LITTLE_ENDIAN) {
    throw new Error('star catalog requires a little-endian JavaScript host');
  }
  if (buffer.byteLength === 0 || buffer.byteLength % STAR_BYTES_PER_RECORD !== 0) {
    throw new RangeError(
      `star catalog byte length must be a positive multiple of ${STAR_BYTES_PER_RECORD}`,
    );
  }
  const data = new Float32Array(buffer);
  const starCount = buffer.byteLength / STAR_BYTES_PER_RECORD;
  for (let recordIndex = 0; recordIndex < starCount; recordIndex += 1) {
    const offset = recordIndex * STAR_STRIDE_FLOATS;
    for (let componentIndex = 0; componentIndex < STAR_STRIDE_FLOATS; componentIndex += 1) {
      if (!Number.isFinite(data[offset + componentIndex])) {
        throw new RangeError(
          `star catalog record ${recordIndex} contains a non-finite component at index ${componentIndex}`,
        );
      }
    }

    const x = data[offset] as number;
    const y = data[offset + 1] as number;
    const z = data[offset + 2] as number;
    const directionLengthSquared = x * x + y * y + z * z;
    if (Math.abs(directionLengthSquared - 1) > 1e-4) {
      throw new RangeError(
        `star catalog record ${recordIndex} direction is not unit length: ${directionLengthSquared}`,
      );
    }

    const visualMagnitude = data[offset + 3] as number;
    if (visualMagnitude < -2 || visualMagnitude > 8) {
      throw new RangeError(
        `star catalog record ${recordIndex} magnitude is outside [-2, 8]: ${visualMagnitude}`,
      );
    }

    const red = data[offset + 4] as number;
    const green = data[offset + 5] as number;
    const blue = data[offset + 6] as number;
    if (red < 0 || red > 1) {
      throw new RangeError(`star catalog record ${recordIndex} red is outside [0, 1]: ${red}`);
    }
    if (green < 0 || green > 1) {
      throw new RangeError(`star catalog record ${recordIndex} green is outside [0, 1]: ${green}`);
    }
    if (blue < 0 || blue > 1) {
      throw new RangeError(`star catalog record ${recordIndex} blue is outside [0, 1]: ${blue}`);
    }
  }
  return Object.freeze({
    starCount,
    strideFloats: STAR_STRIDE_FLOATS,
    data,
  });
}

export type StarCatalogFetcher = (input: string | URL) => Promise<Response>;

/** Fetch and validate a star catalog during scene startup. */
export async function loadStarCatalog(
  url: string | URL,
  fetcher: StarCatalogFetcher = fetch,
): Promise<StarCatalog> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`failed to load star catalog: HTTP ${response.status}`);
  }
  return parseStarCatalog(await response.arrayBuffer());
}

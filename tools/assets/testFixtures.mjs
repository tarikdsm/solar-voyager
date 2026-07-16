export function pad4(buffer, byte = 0) {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder, byte)]);
}

export function createGlb({ embeddedImage = false, materialName, nodeName, parentMatrix, radius = 1, rootMatrix } = {}) {
  const positions = new Float32Array([
    radius, 0, 0, -radius, 0, 0, 0, radius, 0,
    0, -radius, 0, 0, 0, radius, 0, 0, -radius,
  ]);
  const indices = new Uint16Array([
    0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0,
    0, 4, 3, 4, 1, 3, 1, 5, 3, 5, 0, 3,
  ]);
  const positionBytes = Buffer.from(positions.buffer);
  const indexBytes = Buffer.from(indices.buffer);
  const imageBytes = embeddedImage ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : Buffer.alloc(0);
  const binary = pad4(Buffer.concat([positionBytes, indexBytes, imageBytes]));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: parentMatrix === undefined
      ? [{ mesh: 0, ...(nodeName === undefined ? {} : { name: nodeName }), ...(rootMatrix === undefined ? {} : { matrix: rootMatrix }) }]
      : [{ children: [1], matrix: parentMatrix }, { mesh: 0, name: nodeName }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, ...(materialName === undefined ? {} : { material: 0 }) }] }],
    ...(materialName === undefined ? {} : { materials: [{ name: materialName }] }),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, max: [radius, radius, radius], min: [-radius, -radius, -radius], type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 24, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteLength: positionBytes.length, byteOffset: 0 },
      { buffer: 0, byteLength: indexBytes.length, byteOffset: positionBytes.length },
      ...(embeddedImage ? [{ buffer: 0, byteLength: imageBytes.length, byteOffset: positionBytes.length + indexBytes.length }] : []),
    ],
    buffers: [{ byteLength: binary.length }],
    ...(embeddedImage ? { images: [{ bufferView: 2, mimeType: 'image/png' }] } : {}),
  };
  const jsonBytes = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binaryHeader, binary]);
}

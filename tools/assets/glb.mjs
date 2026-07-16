import { readFile } from 'node:fs/promises';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

export function parseGlbJson(bytes, label = 'GLB') {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`${label} is not a glTF binary file`);
  }
  if (bytes.readUInt32LE(4) !== 2) {
    throw new Error(`${label} must use glTF 2.0`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${label} has an invalid declared byte length`);
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) {
      throw new Error(`${label} contains a truncated chunk`);
    }
    if (type === JSON_CHUNK) {
      try {
        return JSON.parse(bytes.subarray(offset + 8, end).toString('utf8').trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} contains invalid JSON: ${message}`);
      }
    }
    offset = end;
  }
  throw new Error(`${label} does not contain a JSON chunk`);
}

export function replaceGlbJson(bytes, json) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (type === JSON_CHUNK) {
      const source = Buffer.from(JSON.stringify(json));
      const padding = (4 - (source.length % 4)) % 4;
      const jsonBytes = Buffer.concat([source, Buffer.alloc(padding, 0x20)]);
      const header = Buffer.from(bytes.subarray(0, 12));
      const chunkHeader = Buffer.alloc(8);
      chunkHeader.writeUInt32LE(jsonBytes.length, 0);
      chunkHeader.writeUInt32LE(JSON_CHUNK, 4);
      const output = Buffer.concat([header, chunkHeader, jsonBytes, bytes.subarray(end)]);
      output.writeUInt32LE(output.length, 8);
      return output;
    }
    offset = end;
  }
  throw new Error('GLB does not contain a JSON chunk');
}

export async function readGlbJson(path) {
  return parseGlbJson(await readFile(path), path);
}

export async function readGlbDocument(path) {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path);
}

function transformPosition(position, matrix) {
  const x = position[0];
  const y = position[1];
  const z = position[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function measureNodes(nodes) {
  let radius = 0;
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const element = [0, 0, 0];

  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (position === null) continue;
      for (let index = 0; index < position.getCount(); index += 1) {
        position.getElement(index, element);
        const transformed = transformPosition(element, matrix);
        radius = Math.max(radius, Math.hypot(transformed[0], transformed[1], transformed[2]));
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], transformed[axis]);
          maximum[axis] = Math.max(maximum[axis], transformed[axis]);
        }
      }
    }
  }

  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  return { center, radius };
}

export function measureDocument(document, primaryNodeName) {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getIndices();
      if (position !== null) {
        triangles += Math.floor((indices?.getCount() ?? position.getCount()) / 3);
      }
    }
  }

  const allNodes = document.getRoot().listNodes();
  const primaryNodes = primaryNodeName === undefined
    ? allNodes
    : allNodes.filter((node) => node.getName() === primaryNodeName);
  const measuredNodes = primaryNodes.length > 0 ? primaryNodes : allNodes;
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const primaryTransformIdentity = measuredNodes.every((node) =>
    node.getWorldMatrix().every((value, index) => Math.abs(value - identityMatrix[index]) <= 1e-8));
  return { ...measureNodes(measuredNodes), primaryTransformIdentity, triangles };
}

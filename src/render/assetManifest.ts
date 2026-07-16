export type RuntimeAssetCategory =
  'asteroid' | 'comet' | 'dwarf' | 'moon' | 'planet' | 'rings' | 'ship' | 'sun';

export interface RuntimeAssetEntry {
  readonly id: string;
  readonly category: RuntimeAssetCategory;
  readonly triangles: number;
  readonly files: readonly string[];
}

export interface RuntimeAssetManifest {
  readonly schemaVersion: 1;
  readonly assets: readonly RuntimeAssetEntry[];
}

export type AssetManifestFetcher = (input: string | URL) => Promise<Response>;

const CATEGORIES = new Set<RuntimeAssetCategory>([
  'asteroid',
  'comet',
  'dwarf',
  'moon',
  'planet',
  'rings',
  'ship',
  'sun',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRuntimePath(path: string): boolean {
  return (
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    (path.startsWith('models/') || path.startsWith('textures/'))
  );
}

function parseEntry(value: unknown, index: number): RuntimeAssetEntry {
  if (!isRecord(value)) throw new Error(`asset manifest entry ${index} must be an object`);
  const { category, files, id, triangles } = value;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`asset manifest entry ${index} has invalid id`);
  }
  if (typeof category !== 'string' || !CATEGORIES.has(category as RuntimeAssetCategory)) {
    throw new Error(`asset manifest entry ${index} has invalid category`);
  }
  if (!Number.isInteger(triangles) || (triangles as number) < 0) {
    throw new Error(`asset manifest entry ${index} has invalid triangle count`);
  }
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => typeof file !== 'string')
  ) {
    throw new Error(`asset manifest entry ${index} has invalid files`);
  }
  const typedFiles = files as string[];
  if (typedFiles.some((file) => !isSafeRuntimePath(file))) {
    throw new Error(`asset manifest entry ${index} contains an unsafe runtime path`);
  }
  if (new Set(typedFiles).size !== typedFiles.length) {
    throw new Error(`asset manifest entry ${index} contains duplicate files`);
  }
  return {
    id,
    category: category as RuntimeAssetCategory,
    triangles: triangles as number,
    files: typedFiles,
  };
}

export function parseAssetManifest(value: unknown): RuntimeAssetManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets)) {
    throw new Error('asset manifest must use schema version 1 with an assets list');
  }
  const assets = value.assets.map((entry, index) => parseEntry(entry, index));
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`asset manifest contains duplicate id "${asset.id}"`);
    ids.add(asset.id);
  }
  return { schemaVersion: 1, assets };
}

export async function loadAssetManifest(
  url: string | URL,
  fetcher: AssetManifestFetcher = fetch,
): Promise<RuntimeAssetManifest> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`failed to load asset manifest: HTTP ${response.status}`);
  const source: unknown = await response.json();
  return parseAssetManifest(source);
}

import { describe, expect, it, vi } from 'vitest';

import { buildKtxArguments, encodeTexture } from './ktx.mjs';

describe('KTX2 encoding', () => {
  it('uses deterministic ETC1S color options with a full mip chain', () => {
    expect(buildKtxArguments('earth_albedo.jpg', 'earth_albedo.ktx2', { channels: 3 })).toEqual([
      'create', '--format', 'R8G8B8_SRGB', '--encode', 'basis-lz', '--generate-mipmap',
      '--assign-tf', 'srgb', '--assign-primaries', 'bt709',
      '--threads', '1', '--testrun', 'earth_albedo.jpg', 'earth_albedo.ktx2',
    ]);
  });

  it('uses deterministic UASTC normal options', () => {
    const args = buildKtxArguments('earth_normal.png', 'earth_normal.ktx2', { channels: 3 });
    expect(args).toContain('uastc');
    expect(args).toContain('--normal-mode');
    expect(args).toContain('--normalize');
    expect(args).toContain('linear');
    expect(args).toContain('none');
    expect(args).toContain('--uastc-rdo-m');
    expect(args).toContain('--generate-mipmap');
    expect(args).toContain('1');
  });

  it('downscales hero cloud and emissive layers to the documented 4k tier', () => {
    for (const name of ['earth_clouds.jpg', 'earth_emissive_night.jpg']) {
      const args = buildKtxArguments(name, `${name}.ktx2`, { channels: 3, width: 8192, height: 4096 });
      expect(args).toContain('--width');
      expect(args).toContain('4096');
      expect(args).toContain('--height');
      expect(args).toContain('2048');
    }
  });

  it('marks PBR data maps as linear rather than sRGB', () => {
    for (const name of ['earth_roughness.png', 'earth_orm.png', 'ship_metallic.jpg', 'rock_ao.png']) {
      const args = buildKtxArguments(name, `${name}.ktx2`, { channels: 3 });
      expect(args).toContain('linear');
      expect(args).toContain('none');
      expect(args).not.toContain('R8G8B8_SRGB');
    }
  });

  it('keeps cloud color maps in sRGB/BT.709', () => {
    const args = buildKtxArguments('earth_clouds.jpg', 'earth_clouds.ktx2', { channels: 3 });
    expect(args).toContain('R8G8B8_SRGB');
    expect(args).toContain('srgb');
    expect(args).toContain('bt709');
    expect(args).not.toContain('linear');
  });

  it('passes the executable and canonical arguments to the runner', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await encodeTexture('earth_albedo.jpg', 'earth_albedo.ktx2', {
      executable: 'ktx-test', metadata: { channels: 3 }, run,
    });
    expect(run).toHaveBeenCalledWith('ktx-test', buildKtxArguments(
      'earth_albedo.jpg', 'earth_albedo.ktx2', { channels: 3 },
    ));
  });
});

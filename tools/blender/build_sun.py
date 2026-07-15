"""Build the Sun model per assets/models/MODELING-GUIDE.md.

Run headless:
  blender --background --python tools/blender/build_sun.py

Contract (guide + ADR-010): radius exactly 1.0, pole +Y after glTF export,
UV sphere >= 128x64, material `mat_surface` (emissive — the in-game Sun is
procedurally shaded, task T0084; this emissive is the fallback), .glb with
no lights/cameras/animations, no Draco (ingest compresses), manifest printed.
"""

import bpy
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO, "assets", "models", "sun")
OUT_GLB = os.path.join(OUT_DIR, "sun.glb")

# Deterministic, idempotent start (guide workflow / asset-pipeline conventions)
bpy.ops.wm.read_factory_settings(use_empty=True)

# Geometry: UV sphere 128x64, radius 1.0 (normalized scale — engine applies real 696,000 km)
bpy.ops.mesh.primitive_uv_sphere_add(
    segments=128, ring_count=64, radius=1.0, calc_uvs=True, location=(0.0, 0.0, 0.0)
)
obj = bpy.context.active_object
obj.name = "sun"
bpy.ops.object.shade_smooth()

# Material: emissive PBR fallback (photosphere ~5778 K blackbody tint)
mat = bpy.data.materials.new("mat_surface")
mat.use_nodes = True
bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (0.02, 0.01, 0.0, 1.0)
bsdf.inputs["Roughness"].default_value = 1.0
# Blender 4/5 input names, with fallback for older API
try:
    bsdf.inputs["Emission Color"].default_value = (1.0, 0.83, 0.55, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 10.0
except KeyError:
    bsdf.inputs["Emission"].default_value = (1.0, 0.83, 0.55, 1.0)
obj.data.materials.append(mat)

# Export: .glb, +Y up (glTF default), apply modifiers, nothing but the mesh
os.makedirs(OUT_DIR, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format="GLB",
    export_apply=True,
    export_animations=False,
    export_cameras=False,
    export_lights=False,
)

# Manifest (asset-pipeline convention)
mesh = obj.data
mesh.calc_loop_triangles()
tris = len(mesh.loop_triangles)
size = os.path.getsize(OUT_GLB)
print("=== ASSET MANIFEST ===")
print(f"body: sun  category: sun")
print(f"tris: {tris} (budget: <=50000)")
print(f"textures: none (procedural in-game, ADR-010; emissive material fallback)")
print(f"glb bytes: {size} ({size/1024:.1f} KiB)")
print("======================")
assert tris <= 50000, "tri budget exceeded"

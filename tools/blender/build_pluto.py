"""Build the Pluto dwarf-planet model per assets/models/MODELING-GUIDE.md.

Run headless:
  blender --background --python tools/blender/build_pluto.py

Requires source textures in assets/textures-src/pluto/ (NASA New Horizons /
JPL Photojournal PIA11707 — public domain):
  2k_pluto.jpg  (deliverable albedo; 2048×1024 equirectangular)
  4k_pluto.jpg  (optional higher-res working copy for interactive preview)

Contract: radius 1.0 normalized (engine scales to ~1188 km), pole +Y after
export, UV sphere 64×32 (dwarf tier), material mat_surface, glb WITHOUT
embedded images (ingest wires KTX2), no Draco. Category: dwarfs/.

Also writes assets/blender/pluto.blend for interactive MCP review.
"""

import bpy
import os
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEX = os.path.join(REPO, "assets", "textures-src", "pluto")
OUT_DIR = os.path.join(REPO, "assets", "models", "dwarfs", "pluto")
BLEND_DIR = os.path.join(REPO, "assets", "blender")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(BLEND_DIR, exist_ok=True)

ALBEDO_SRC = "2k_pluto.jpg"
# Prefer 4k for viewport preview when available; export still ships 2k albedo.
PREVIEW_SRC = "4k_pluto.jpg" if os.path.exists(os.path.join(TEX, "4k_pluto.jpg")) else ALBEDO_SRC

# Idempotent empty scene (do NOT call from MCP sessions — it unregisters addons)
bpy.ops.wm.read_factory_settings(use_empty=True)


def load_image(name, noncolor=False):
    path = os.path.join(TEX, name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing texture: {path}")
    im = bpy.data.images.load(path)
    if noncolor:
        im.colorspace_settings.name = "Non-Color"
    return im


# --- Body: dwarf-tier UV sphere, radius exactly 1.0 ---
# Guide §4: dwarfs / small moons → UV sphere 64×32, ≤15k tris
bpy.ops.mesh.primitive_uv_sphere_add(
    segments=64, ring_count=32, radius=1.0, calc_uvs=True, location=(0.0, 0.0, 0.0)
)
pluto = bpy.context.active_object
pluto.name = "pluto"
bpy.ops.object.shade_smooth()

# Material: PBR mat_surface (ice + tholin mix → fairly rough, non-metal)
m = bpy.data.materials.new("mat_surface")
m.use_nodes = True
m.use_backface_culling = True
nt = m.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.78
bsdf.inputs["Metallic"].default_value = 0.0
t_alb = nt.nodes.new("ShaderNodeTexImage")
t_alb.image = load_image(PREVIEW_SRC)
nt.links.new(t_alb.outputs["Color"], bsdf.inputs["Base Color"])
pluto.data.materials.append(m)

# Preview sun light (not exported — selection-only export; kept for MCP review)
light_data = bpy.data.lights.new(name="sun_preview", type="SUN")
light_data.energy = 3.0
light_obj = bpy.data.objects.new("sun_preview", light_data)
bpy.context.collection.objects.link(light_obj)
light_obj.rotation_euler = (0.785, 0.3, 0.5)

# Dark world background for space-like viewport review
world = bpy.data.worlds.new("world_space")
bpy.context.scene.world = world
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = (0.01, 0.01, 0.02, 1.0)
bg.inputs["Strength"].default_value = 0.3

# --- Export (active scene, selection only, images NOT embedded) ---
bpy.ops.object.select_all(action="DESELECT")
pluto.select_set(True)
bpy.context.view_layer.objects.active = pluto
glb = os.path.join(OUT_DIR, "pluto.glb")
bpy.ops.export_scene.gltf(
    filepath=glb,
    export_format="GLB",
    use_selection=True,
    use_active_scene=True,
    export_apply=True,
    export_animations=False,
    export_image_format="NONE",
)

# Deliver albedo with guide naming (2k dwarf tier)
shutil.copy(
    os.path.join(TEX, ALBEDO_SRC),
    os.path.join(OUT_DIR, "pluto_albedo.jpg"),
)

# Interactive review blend (textures external, never packed)
blend_path = os.path.join(BLEND_DIR, "pluto.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=True, copy=True)

# --- Manifest ---
dg = bpy.context.evaluated_depsgraph_get()
me = pluto.evaluated_get(dg).to_mesh()
me.calc_loop_triangles()
tris = len(me.loop_triangles)
print("=== ASSET MANIFEST ===")
print("body: pluto  category: dwarfs")
print(f"tris: {tris} (budget <=15000)")
print(f"radius: 1.0 (normalized); pole +Y after glTF export")
print(f"material: mat_surface; albedo: pluto_albedo.jpg (2k equirect)")
print(f"blend: {blend_path}")
for f in sorted(os.listdir(OUT_DIR)):
    print(f"  {f}: {os.path.getsize(os.path.join(OUT_DIR, f)) / 1024:.0f} KiB")
print("======================")
assert tris <= 15000, f"tri budget exceeded: {tris}"

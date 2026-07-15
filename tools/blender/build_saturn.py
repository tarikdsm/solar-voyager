"""Build the Saturn model (body + rings) per assets/models/MODELING-GUIDE.md.

Run headless:
  blender --background --python tools/blender/build_saturn.py

Requires source textures in assets/textures-src/saturn/ (Solar System Scope,
CC BY 4.0): 8k_saturn.jpg, 8k_saturn_ring_alpha.png (8192x500 radial strip).

Contract: equatorial radius 1.0 normalized (engine scales to 60,268 km),
true oblateness 0.902, pole +Y after export; rings at real Cassini radii
(D inner 1.110 R -> F outer 2.327 R), radial-strip UVs, alpha = optical
depth, double-sided; materials mat_surface / mat_rings; glb without
embedded images; no Draco. Axial tilt applied by the engine.
"""

import bpy
import bmesh
import math
import os
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEX = os.path.join(REPO, "assets", "textures-src", "saturn")
OUT_DIR = os.path.join(REPO, "assets", "models", "planets", "saturn")
os.makedirs(OUT_DIR, exist_ok=True)

R_IN, R_OUT = 1.110, 2.327   # D-ring inner / F-ring outer, in Saturn equatorial radii
SEG, RAD = 256, 24

bpy.ops.wm.read_factory_settings(use_empty=True)

# --- Body: oblate hero-res sphere ---
bpy.ops.mesh.primitive_uv_sphere_add(segments=160, ring_count=80, radius=1.0, calc_uvs=True)
sat = bpy.context.active_object
sat.name = "saturn"
sat.scale = (1.0, 1.0, 0.902)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.shade_smooth()

m = bpy.data.materials.new("mat_surface")
m.use_nodes = True
m.use_backface_culling = True
nt = m.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.9
bsdf.inputs["Metallic"].default_value = 0.0
t = nt.nodes.new("ShaderNodeTexImage")
t.image = bpy.data.images.load(os.path.join(TEX, "8k_saturn.jpg"))
nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
sat.data.materials.append(m)

# --- Rings: annulus with radial-strip UVs (u = radius, v = angle) ---
mesh = bpy.data.meshes.new("saturn_rings")
bm = bmesh.new()
grid = []
for i in range(RAD + 1):
    r = R_IN + (R_OUT - R_IN) * i / RAD
    grid.append([bm.verts.new((r * math.cos(2 * math.pi * j / SEG),
                               r * math.sin(2 * math.pi * j / SEG), 0.0))
                 for j in range(SEG)])
bm.verts.index_update()
uv_layer = bm.loops.layers.uv.new("UVMap")
for i in range(RAD):
    for j in range(SEG):
        j2 = (j + 1) % SEG
        f = bm.faces.new((grid[i][j], grid[i][j2], grid[i + 1][j2], grid[i + 1][j]))
        us = (i / RAD, i / RAD, (i + 1) / RAD, (i + 1) / RAD)
        vs = (j / SEG, (j + 1) / SEG, (j + 1) / SEG, j / SEG)
        for loop, u, v in zip(f.loops, us, vs):
            loop[uv_layer].uv = (u, v)
bm.to_mesh(mesh)
bm.free()
rings = bpy.data.objects.new("saturn_rings", mesh)
bpy.context.scene.collection.objects.link(rings)

mr = bpy.data.materials.new("mat_rings")
mr.use_nodes = True
mr.blend_method = 'BLEND'
mr.use_backface_culling = False   # rings visible from both sides
nt = mr.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 1.0
t = nt.nodes.new("ShaderNodeTexImage")
t.image = bpy.data.images.load(os.path.join(TEX, "8k_saturn_ring_alpha.png"))
nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
rings.data.materials.append(mr)

# --- Export ---
bpy.ops.object.select_all(action='DESELECT')
sat.select_set(True)
rings.select_set(True)
bpy.context.view_layer.objects.active = sat
glb = os.path.join(OUT_DIR, "saturn.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True,
                          use_active_scene=True, export_apply=True,
                          export_animations=False, export_image_format='NONE')

shutil.copy(os.path.join(TEX, "8k_saturn.jpg"), os.path.join(OUT_DIR, "saturn_albedo.jpg"))
shutil.copy(os.path.join(TEX, "8k_saturn_ring_alpha.png"), os.path.join(OUT_DIR, "saturn_rings.png"))

# --- Manifest ---
dg = bpy.context.evaluated_depsgraph_get()
tris = 0
for o in (sat, rings):
    me = o.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
print("=== ASSET MANIFEST ===")
print("body: saturn  category: planets (hero, ringed)")
print(f"tris: {tris} (budget <=50000 + ring allowance 5000)")
for f in sorted(os.listdir(OUT_DIR)):
    print(f"  {f}: {os.path.getsize(os.path.join(OUT_DIR, f))/1024:.0f} KiB")
print("======================")
assert tris <= 55000

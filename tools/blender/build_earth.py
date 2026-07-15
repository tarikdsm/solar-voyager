"""Build the Earth model per assets/models/MODELING-GUIDE.md (hero planet).

Run headless:
  blender --background --python tools/blender/build_earth.py

Requires source textures in assets/textures-src/earth/ (Solar System Scope,
CC BY 4.0 — see assets/models/planets/earth/SOURCES.md):
  8k_earth_daymap.jpg, 8k_earth_nightmap.jpg, 8k_earth_clouds.jpg,
  8k_earth_normal_map.tif

Contract: radius 1.0 normalized (engine scales to 6378 km), pole +Y after
export, UV sphere 128x64 + cloud shell at 1.004, materials mat_surface /
mat_clouds, glb WITHOUT embedded images (ingest wires KTX2), no Draco.
"""

import bpy
import os
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEX = os.path.join(REPO, "assets", "textures-src", "earth")
OUT_DIR = os.path.join(REPO, "assets", "models", "planets", "earth")
os.makedirs(OUT_DIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

def img(name, noncolor=False):
    im = bpy.data.images.get(name) or bpy.data.images.load(os.path.join(TEX, name))
    if noncolor:
        im.colorspace_settings.name = "Non-Color"
    return im

# --- Surface ---
bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=1.0, calc_uvs=True)
earth = bpy.context.active_object
earth.name = "earth"
bpy.ops.object.shade_smooth()

m = bpy.data.materials.new("mat_surface")
m.use_nodes = True
nt = m.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.85
bsdf.inputs["Metallic"].default_value = 0.0
t_alb = nt.nodes.new("ShaderNodeTexImage"); t_alb.image = img("8k_earth_daymap.jpg")
nt.links.new(t_alb.outputs["Color"], bsdf.inputs["Base Color"])
t_nrm = nt.nodes.new("ShaderNodeTexImage"); t_nrm.image = img("8k_earth_normal_map.tif", noncolor=True)
nmap = nt.nodes.new("ShaderNodeNormalMap"); nmap.inputs["Strength"].default_value = 0.6
nt.links.new(t_nrm.outputs["Color"], nmap.inputs["Color"])
nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
t_night = nt.nodes.new("ShaderNodeTexImage"); t_night.image = img("8k_earth_nightmap.jpg")
nt.links.new(t_night.outputs["Color"], bsdf.inputs["Emission Color"])
bsdf.inputs["Emission Strength"].default_value = 1.0
earth.data.materials.append(m)

# --- Cloud shell ---
bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=1.004, calc_uvs=True)
clouds = bpy.context.active_object
clouds.name = "earth_clouds"
bpy.ops.object.shade_smooth()
mc = bpy.data.materials.new("mat_clouds")
mc.use_nodes = True
nt = mc.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 1.0
bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
t_cld = nt.nodes.new("ShaderNodeTexImage"); t_cld.image = img("8k_earth_clouds.jpg")
nt.links.new(t_cld.outputs["Color"], bsdf.inputs["Alpha"])
mc.blend_method = 'BLEND'
clouds.data.materials.append(mc)

# --- Export (active scene only, selection only, images NOT embedded) ---
bpy.ops.object.select_all(action='DESELECT')
earth.select_set(True)
clouds.select_set(True)
bpy.context.view_layer.objects.active = earth
glb = os.path.join(OUT_DIR, "earth.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True,
                          use_active_scene=True, export_apply=True,
                          export_animations=False, export_image_format='NONE')

# --- Deliver textures with guide names ---
nrm_png = os.path.join(OUT_DIR, "earth_normal.png")
if not os.path.exists(nrm_png):
    im = img("8k_earth_normal_map.tif", noncolor=True)
    im.scale(4096, 2048)
    im.file_format = 'PNG'
    im.filepath_raw = nrm_png
    im.save()
shutil.copy(os.path.join(TEX, "8k_earth_daymap.jpg"),   os.path.join(OUT_DIR, "earth_albedo.jpg"))
shutil.copy(os.path.join(TEX, "8k_earth_nightmap.jpg"), os.path.join(OUT_DIR, "earth_emissive_night.jpg"))
shutil.copy(os.path.join(TEX, "8k_earth_clouds.jpg"),   os.path.join(OUT_DIR, "earth_clouds.jpg"))

# --- Manifest ---
dg = bpy.context.evaluated_depsgraph_get()
tris = 0
for o in (earth, clouds):
    me = o.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
print("=== ASSET MANIFEST ===")
print("body: earth  category: planets (hero)")
print(f"tris: {tris} (budget <=50000)")
for f in sorted(os.listdir(OUT_DIR)):
    print(f"  {f}: {os.path.getsize(os.path.join(OUT_DIR, f))/1024:.0f} KiB")
print("======================")
assert tris <= 50000

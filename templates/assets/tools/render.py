"""blender -b --factory-startup --python tools/render.py -- <file.glb> <out_dir> : renders the critique views.

Views: front, side, three-quarter, top, back-three-quarter, and scale (beside a 1.75 m human silhouette)."""
import bpy, math, sys, pathlib
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
path, out = args[0], pathlib.Path(args[1])
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center, size = (lo + hi) / 2, max((hi - lo).length, 0.01)

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_cavity = True
scene.display.shading.show_object_outline = True
scene.display.shading.show_shadows = True
scene.render.resolution_x = scene.render.resolution_y = 768
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("bg"); scene.world.color = (0.82, 0.83, 0.85)
scene.display_settings.display_device = "sRGB"

# ground plane for contact
bpy.ops.mesh.primitive_plane_add(size=size * 8, location=(center.x, center.y, lo.z - 0.0005))
ground = bpy.context.active_object
gm = bpy.data.materials.new("ground"); gm.diffuse_color = (0.62, 0.63, 0.66, 1); ground.data.materials.append(gm)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam); scene.camera = cam
cam.data.lens = 50


def shoot(name, direction, target=center, dist=None):
    d = Vector(direction).normalized()
    cam.location = target + d * (dist or size * 2.1)
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(out / f"{name}.png")
    bpy.ops.render.render(write_still=True)


shoot("front", (0, -1, 0.15))
shoot("side", (1, 0, 0.15))
shoot("three-quarter", (1, -1, 0.7))
shoot("back-three-quarter", (-1, 1, 0.5))
shoot("top", (0, -0.001, 1))

# scale: a 1.75 m human silhouette (capsule) standing beside the asset
hm = bpy.data.materials.new("human"); hm.diffuse_color = (0.25, 0.45, 0.85, 1)
x = hi.x + 0.45
bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=1.45, location=(x, center.y, lo.z + 0.725)); bpy.context.active_object.data.materials.append(hm)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.13, location=(x, center.y, lo.z + 1.62)); bpy.context.active_object.data.materials.append(hm)
both_hi = max(hi.z, lo.z + 1.75)
mid = Vector(((lo.x + x + 0.2) / 2, center.y, (lo.z + both_hi) / 2))
shoot("scale", (0.25, -1, 0.15), target=mid, dist=max(both_hi - lo.z, x + 0.2 - lo.x) * 2.0)
print(f"rendered {out}")

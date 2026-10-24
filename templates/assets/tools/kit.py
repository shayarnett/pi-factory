"""Helpers every asset's build.py uses. Blender is Z-up, meters; glTF export converts to Y-up.

    import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "tools"))
    import kit
    kit.reset()
    body = kit.box("body", size=(0.6, 0.6, 0.6), location=(0, 0, 0.3))
    kit.paint(body, kit.material("wood", "#8b5a2b", roughness=0.8))
    kit.finish(__file__)   # joins, grounds, centers, UVs, exports <slug>.glb + <slug>.blend next to build.py
"""
import bpy, bmesh, pathlib


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"


def material(name, hex_color, roughness=0.7, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    h = hex_color.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    bsdf.inputs["Base Color"].default_value = (*lin, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    m.diffuse_color = (*lin, 1)  # what the Workbench preview shows
    return m


def paint(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def _add(op, name, **kw):
    op(**kw)
    o = bpy.context.active_object
    o.name = o.data.name = name
    return o


def box(name, size=(1, 1, 1), location=(0, 0, 0), rotation=(0, 0, 0)):
    o = _add(bpy.ops.mesh.primitive_cube_add, name, size=1, location=location, rotation=rotation)
    o.scale = size
    return o


def cylinder(name, radius=0.5, depth=1, vertices=12, location=(0, 0, 0), rotation=(0, 0, 0)):
    return _add(bpy.ops.mesh.primitive_cylinder_add, name, radius=radius, depth=depth, vertices=vertices, location=location, rotation=rotation)


def cone(name, radius1=0.5, radius2=0.0, depth=1, vertices=12, location=(0, 0, 0), rotation=(0, 0, 0)):
    return _add(bpy.ops.mesh.primitive_cone_add, name, radius1=radius1, radius2=radius2, depth=depth, vertices=vertices, location=location, rotation=rotation)


def sphere(name, radius=0.5, segments=12, rings=6, location=(0, 0, 0)):
    return _add(bpy.ops.mesh.primitive_uv_sphere_add, name, radius=radius, segments=segments, ring_count=rings, location=location)


def torus(name, major=0.5, minor=0.1, major_segments=16, minor_segments=6, location=(0, 0, 0), rotation=(0, 0, 0)):
    return _add(bpy.ops.mesh.primitive_torus_add, name, major_radius=major, minor_radius=minor, major_segments=major_segments, minor_segments=minor_segments, location=location, rotation=rotation)


def finish(build_file):
    """Applies transforms, joins all meshes into one object named after the asset, puts the origin at the bottom
    center, sets the bottom at z=0, flat-shades, adds UVs if missing, and exports <slug>.glb and <slug>.blend."""
    out = pathlib.Path(build_file).resolve().parent
    slug = out.name
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = obj.data.name = slug
    # merge doubles from joined primitives; recalc normals outward
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    xs = [v.co.x for v in bm.verts]; ys = [v.co.y for v in bm.verts]; zs = [v.co.z for v in bm.verts]
    shift = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs))
    for v in bm.verts:
        v.co.x -= shift[0]; v.co.y -= shift[1]; v.co.z -= shift[2]
    bm.to_mesh(obj.data); bm.free()
    obj.location = (0, 0, 0)
    for p in obj.data.polygons:
        p.use_smooth = False
    if not obj.data.uv_layers:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.export_scene.gltf(filepath=str(out / f"{slug}.glb"), export_format="GLB", use_selection=False, export_apply=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / f"{slug}.blend"))
    print(f"exported {out / (slug + '.glb')}")

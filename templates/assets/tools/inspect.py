"""blender -b --factory-startup --python tools/inspect.py -- <file.glb> : prints one JSON line of measurements."""
import bpy, bmesh, json, sys

path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
tris = nonmanifold = 0
xs, ys, zs = [], [], []
uv = all(m.data.uv_layers for m in meshes)
mats = sorted({s.material.name for m in meshes for s in m.material_slots if s.material})
for o in meshes:
    bm = bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)  # glTF splits verts at hard edges/UV seams; weld for topology
    tris += sum(len(f.verts) - 2 for f in bm.faces)
    nonmanifold += sum(1 for e in bm.edges if len(e.link_faces) != 2)
    for v in bm.verts:
        xs.append(v.co.x); ys.append(v.co.y); zs.append(v.co.z)
    bm.free()
# Floating parts: split into connected islands; every island's box must touch another island's (within 2 mm).
islands = []
for o in meshes:
    bm = bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    seen = set()
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, part = [v], []
        seen.add(v.index)
        while stack:
            x = stack.pop(); part.append(x.co.copy())
            for e in x.link_edges:
                y = e.other_vert(x)
                if y.index not in seen:
                    seen.add(y.index); stack.append(y)
        islands.append(([min(p[i] for p in part) for i in range(3)], [max(p[i] for p in part) for i in range(3)]))
    bm.free()
touch = lambda a, b, eps=0.002: all(a[0][i] - eps <= b[1][i] and b[0][i] - eps <= a[1][i] for i in range(3))
floating = [i for i, a in enumerate(islands) if len(islands) > 1 and not any(touch(a, b) for j, b in enumerate(islands) if j != i)]
r = lambda v: round(v, 4)
print("INSPECT " + json.dumps({
    "objects": len(meshes), "tris": tris, "parts": len(islands),
    "floating_parts": [{"min": [r(c) for c in islands[i][0]], "max": [r(c) for c in islands[i][1]]} for i in floating], "nonmanifold_edges": nonmanifold, "uvs": uv, "materials": mats,
    "size_m": [r(max(xs) - min(xs)), r(max(ys) - min(ys)), r(max(zs) - min(zs))] if xs else [0, 0, 0],  # width (x), depth (y), height (z)
    "bottom_z": r(min(zs)) if zs else 0, "center_xy": [r((min(xs) + max(xs)) / 2), r((min(ys) + max(ys)) / 2)] if xs else [0, 0],
}))

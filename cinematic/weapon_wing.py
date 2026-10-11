"""Builds one Mark 50 back-wing blade in Blender from its traced panels (weapon_wing.json, traced by hand on the Hot Toys figure photo): a dark core in
the blade's outline with every panel a solid piece with rounded edges on it, the core showing between them as the
seams; the chamfer band along the straight edge sloped down to the edge; the same panels on the back (mirrored
through the blade's thickness), so the blade reads from both sides.
  python weapon_wing.py weapon_wing.json out.png      renders out.png (front, orthographic) and out_34.png (three-quarter)
Blade length 1 along +Y from the root (y=0) to the tip, x centred across its width, facing +Z."""
import bpy, bmesh, json, math, os, sys
from mathutils import Vector, Matrix

CORE = 0.006      # (half the core's thickness)
UNIT = 0.012      # (a panel's height above the core, per unit of its 'h')
SINK = 0.003      # (how far the panels sit into the core)
DROP = 0.015      # (how far the chamfer band's top falls to the outer edge: the straight edge thins to a blade)
CORE_DROP = 0.0048  # (and the core's, under it)
SPLIT = 0.012     # (longest edge left unsplit on sloped pieces)
COLOURS = {  # (linear base colour, metallic, roughness, coat)
    0: ((0.20, 0.006, 0.009), 0.9, 0.3, 1.0),    # red
    1: ((0.58, 0.38, 0.15), 1.0, 0.3, 0.0),       # gold
    4: ((0.26, 0.16, 0.055), 1.0, 0.42, 0.0),     # dark gold panel
    5: ((0.035, 0.004, 0.004), 0.6, 0.5, 0.0),    # core (the seams)
}
BEVEL = {0: 0.0028, 1: 0.0011, 4: 0.0015, 5: 0.0025}


def material(cls):
    m = bpy.data.materials.new(f'wing_{cls}')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    if cls == 2:  # pale glass
        b.inputs['Base Color'].default_value = (0.2, 0.4, 0.72, 1)
        b.inputs['Roughness'].default_value = 0.38
        b.inputs['Emission Color'].default_value = (0.45, 0.66, 0.92, 1)
        b.inputs['Emission Strength'].default_value = 0.04
        return m
    if cls == 3:  # glowing blue
        b.inputs['Emission Color'].default_value = (0.08, 0.5, 1.0, 1)
        b.inputs['Emission Strength'].default_value = 18
        return m
    col, met, rough, coat = COLOURS[cls]
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = met
    b.inputs['Roughness'].default_value = rough
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.06
    return m


def seg_dist(px, py, pts):
    """Distance from (px, py) to a polyline."""
    best = 1e9
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx - px, ay + t * dy - py
        best = min(best, qx * qx + qy * qy)
    return math.sqrt(best)


def inside(px, py, poly):
    c = False
    for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]):
        if (ay > py) != (by > py) and px < ax + (py - ay) * (bx - ax) / (by - ay):
            c = not c
    return c


def slope(x, y, zones):
    """How far down the chamfer (0 at the band's inner boundary, 1 at its outer line and on the rim beyond)."""
    for z in zones:
        if not inside(x, y, z['zone']):
            continue
        if z['rim'] and inside(x, y, z['rim']):
            return 1.0
        do, di = seg_dist(x, y, z['outer']), seg_dist(x, y, z['inner'])
        return di / (di + do + 1e-9)
    return 0.0


def piece(name, rings, top, bottom, bev, zones=None, squeeze=False):
    """A flat piece in the outline `rings` (outer, then holes) from z=bottom to z=top, its edges rounded by bev;
    with chamfer `zones` its top falls by DROP*slope() (and its bottom by CORE_DROP*slope(), with the core under it);
    with squeeze (the core) it is thinned about z=0 instead.
    Returns a bmesh, welded into one closed shell."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '2D'
    cu.fill_mode = 'BOTH'
    for ring in rings:
        pts = ring[:-1] if ring[0] == ring[-1] else ring
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for p, (x, y) in zip(sp.points, pts):
            p.co = (x, y, 0, 1)
        sp.use_cyclic_u = True
    e = max(0.0005, (top - bottom - 2 * bev) / 2)
    cu.extrude = e
    cu.bevel_depth = bev
    cu.bevel_resolution = 3
    cu.offset = -bev  # (the rounding inside the outline, so the seams keep their width)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for z in zones or []:
        if z.get('rim_x') is not None:  # (an edge along the rim's fold, so it is crisp)
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7,
                                   plane_co=(z['rim_x'], 0, 0), plane_no=(1, 0, 0))
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    if zones:
        for _ in range(8):  # (long edges split so the slope is smooth)
            long = [ed for ed in bm.edges if ed.calc_length() > SPLIT]
            if not long:
                break
            bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=False)
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    lift = bottom + e + bev
    for v in bm.verts:
        z = v.co.z + lift
        f = slope(v.co.x, v.co.y, zones) if zones else 0.0
        if f > 0:
            if squeeze:  # (the core: thinned about z=0)
                z *= 1 - f * CORE_DROP / top
            else:  # (the top falls by DROP, the bottom with the core's top under it)
                s = (v.co.z + e + bev) / (2 * (e + bev))
                z -= f * (DROP * s + CORE_DROP * (1 - s))
        v.co.z = z
    if zones and not squeeze:  # (the folds on the sloped top kept crisp: no smoothing across them)
        bm.normal_update()
        for ed in bm.edges:
            fs = ed.link_faces
            if len(fs) == 2 and min(f.normal.z for f in fs) > 0.75 and ed.calc_face_angle(0) > math.radians(9):
                ed.smooth = False
    return bm


def add(bm, pb, mat_index, back=False):
    """Copies piece pb into bm (mirrored through z=0 for the back)."""
    vs = [bm.verts.new((v.co.x, v.co.y, -v.co.z if back else v.co.z)) for v in pb.verts]
    for f in pb.faces:
        idx = [v.index for v in f.verts]
        if back:
            idx.reverse()
        try:
            nf = bm.faces.new([vs[i] for i in idx])
        except ValueError:
            continue
        nf.material_index = mat_index
        nf.smooth = True
    for ed in pb.edges:
        if not ed.smooth:
            ne = bm.edges.get([vs[ed.verts[0].index], vs[ed.verts[1].index]])
            if ne:
                ne.smooth = False


def build(path):
    D = json.load(open(path))
    slots = [0, 1, 2, 3, 4, 5]
    mats = [material(c) for c in slots]
    bm = bpy.data.meshes.new('wing_blade')
    B = bmesh.new()
    zones = D['chamfer']
    for z in zones:
        z['zone'] = [tuple(p) for p in z['zone'][:-1]]
        if z['rim']:
            z['rim'] = [tuple(p) for p in z['rim'][:-1]]
    core = piece('core', [D['silhouette']], CORE, -CORE, BEVEL[5], zones, squeeze=True)
    core.verts.index_update()
    add(B, core, slots.index(5))
    core.free()
    for p in D['panels']:
        top = CORE + p['h'] * UNIT
        pb = piece(p['name'], [p['outer']] + p['holes'], top, CORE - SINK, BEVEL[p['cls']],
                   zones if p.get('slope') else None)
        pb.verts.index_update()
        add(B, pb, slots.index(p['cls']))
        add(B, pb, slots.index(p['cls']), back=True)
        pb.free()
    B.normal_update()
    for ed in B.edges:  # (smooth over the rounded edges, sharp at the corners)
        if len(ed.link_faces) == 2 and ed.calc_face_angle(0) > math.radians(40):
            ed.smooth = False
    B.to_mesh(bm)
    B.free()
    ob = bpy.data.objects.new('mk50_wing_blade', bm)
    for m in mats:
        bm.materials.append(m)
    bpy.context.scene.collection.objects.link(ob)
    return ob, D


def stage(ob, D, out):
    sc = bpy.context.scene
    up = Matrix.Rotation(math.radians(90), 3, 'X')  # (stood up: facing -Y, tip up)
    ob.rotation_euler = (math.radians(90), 0, 0)
    ob.location = (0, 0, -0.5)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 1.08
    cam.data.sensor_fit = 'VERTICAL'
    cam.location = (0, -5, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam
    for loc, e, sz in (((-2.0, 2.5, 4.0), 420, 2.0), ((2.8, 0.5, 3.0), 140, 2.0), ((0, -3, 2.0), 60, 2.5),
                       ((0.5, 4.0, -0.5), 160, 1.5)):
        l = bpy.data.objects.new('l', bpy.data.lights.new('l', 'AREA'))
        l.data.energy, l.data.size = e, sz
        sc.collection.objects.link(l)
        l.location = loc = up @ Vector(loc)
        l.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.07, 0.05, 0.045, 1)
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('WING_SAMPLES', 32))
    sc.cycles.use_denoising = True
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = int(os.environ.get('WING_THREADS', 2))
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.render.film_transparent = True
    H = int(os.environ.get('WING_RES', 900))
    sc.render.resolution_y = H
    sc.render.resolution_x = int(H * (D['width'] + 0.12) / 1.08)
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    cam.data.type = 'PERSP'
    cam.data.lens = 60
    cam.location = Vector((-0.78, -0.6, 0.22)).normalized() * 2.85
    cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.resolution_x = int(H * 0.62)
    sc.render.filepath = out.replace('.png', '_34.png')
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ob, D = build(sys.argv[-2])
    stage(ob, D, os.path.abspath(sys.argv[-1]))

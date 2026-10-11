"""Builds the Mark 50 forearm cannon in Blender from weapon_cannon.json (made by shapes.py from outlines traced on the
Monkey Depot photo of the Hot Toys piece): a hull lofted from superellipse sections along the traced side profile,
split into the closed rear, the upper jaw (a hood) and the hinged lower jaw (a scoop); every panel a solid piece with
rounded edges laid on the hull over a dark backing that shows between them as the seams (the shield's method, the
flat outlines wrapped round the hull by P(u, v) + w N(u, v)); teeth on the upper jaw's rims, chrome ribs lining the
lower jaw, the hexagonal emitter in the throat.

  python weapon_cannon.py weapon_cannon.json out.png   renders out.png (side view from +X, orthographic: root left, tip
                                               right) and out_34.png (the Monkey Depot photo's view)
Model frame: long axis +Y, y=0 the root (at the elbow) to y=1 the upper jaw's tip; X across; +Z the top. Length 1.
Env CANNON_SAMPLES (default 32), CANNON_RES (default 900: the side view's width)."""
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cannon_geom as geom

RED, GOLD, GLASS, PANEL, BACKING, SILVER, GLOW = 0, 1, 2, 4, 5, 6, 7
COLOURS = {  # (linear base colour, metallic, roughness, coat)
    RED: ((0.20, 0.006, 0.009), 0.9, 0.3, 1.0),
    GOLD: ((0.58, 0.38, 0.15), 1.0, 0.3, 0.0),
    PANEL: ((0.26, 0.16, 0.055), 1.0, 0.42, 0.0),
    BACKING: ((0.035, 0.004, 0.004), 0.6, 0.5, 0.0),
    SILVER: ((0.62, 0.62, 0.64), 1.0, 0.25, 0.0),   # (chrome trim: the photo's band, ribs, teeth)
}
BEVEL = {RED: 0.0026, GOLD: 0.0014, GLASS: 0.001, PANEL: 0.0012, SILVER: 0.001, GLOW: 0.001, BACKING: 0.001}
MID = Vector((0.0, 0.55, 0.02))   # (the cannon's middle: lights and views aim here)
UNIT = 0.006     # (a panel's height above the backing per unit of its 'h')
SHELL = 0.012    # (thickness of the jaws' shells)
SPLIT = 0.012    # (longest edge left unsplit, so pieces follow the hull)


def material(cls):
    m = bpy.data.materials.new(f'cannon_{cls}')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    if cls == GLASS:
        b.inputs['Base Color'].default_value = (0.2, 0.4, 0.72, 1)
        b.inputs['Roughness'].default_value = 0.38
        b.inputs['Emission Color'].default_value = (0.45, 0.66, 0.92, 1)
        b.inputs['Emission Strength'].default_value = 0.04
        return m
    if cls == GLOW:
        b.inputs['Base Color'].default_value = (0.08, 0.5, 1.0, 1)
        b.inputs['Emission Color'].default_value = (0.08, 0.5, 1.0, 1)
        b.inputs['Emission Strength'].default_value = 18.0
        return m
    col, met, rough, coat = COLOURS[cls]
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = met
    b.inputs['Roughness'].default_value = rough
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.06
    return m


# ---------- helpers ----------

def mesh_object(name, verts, faces, mat, smooth=True, recalc=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.smooth = smooth
    bm.to_mesh(me)
    bm.free()
    finish(me)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    return o


def finish(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    for ed in bm.edges:  # (smooth over the rounded edges, sharp at the corners)
        if len(ed.link_faces) == 2 and ed.calc_face_angle(0) > math.radians(40):
            ed.smooth = False
    bm.to_mesh(me)
    bm.free()


def wrap(H, part, uvw):
    """(u, v, w) -> the point w above the hull at (u, v) (w along the outward normal)."""
    uvw = np.asarray(uvw, float)
    u, v, w = uvw[:, 0], uvw[:, 1], uvw[:, 2]
    return H.P(u, v, part) + w[:, None] * H.N(u, v, part)


def curve_solid(H, name, rings, top, bottom, bev, part, mat, split=SPLIT):
    """A flat piece in the (u, v) outline `rings` (outer, then holes), from w=bottom to w=top, edges rounded by
    bev (inside the outline, so seams keep their width), laid on the hull."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '2D'
    cu.fill_mode = 'BOTH'
    for ring in rings:
        pts = ring[:-1] if tuple(ring[0]) == tuple(ring[-1]) else ring
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for p, (x, y) in zip(sp.points, pts):
            p.co = (x, y, 0, 1)
        sp.use_cyclic_u = True
    e = max(0.0003, (top - bottom - 2 * bev) / 2)
    cu.extrude = e
    cu.bevel_depth = bev
    cu.bevel_resolution = 2
    cu.offset = -bev
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-7)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for _ in range(10):
        long = [ed for ed in bm.edges if ed.calc_length() > split]
        if not long:
            break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=False)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    lift = bottom + e + bev
    bm.verts.index_update()
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    uvw = np.array([(v.co.x, v.co.y, v.co.z + lift) for v in bm.verts])
    if len(uvw) == 0:
        bm.free()
        return None
    P = wrap(H, part, uvw)
    for v, p in zip(bm.verts, P):
        v.co = Vector(p)
    orient(bm)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    finish(me)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    return o


def orient(bm):
    """Faces turned outward: a closed piece's signed volume must come out positive (wrapping (u, v, w) round the
    hull mirrors it, and recalc_face_normals can guess wrong on long curved shells)."""
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    vol = 0.0
    for f in bm.faces:
        a, b, c = (v.co for v in f.verts)
        vol += a.dot(b.cross(c))
    if vol < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.normal_update()


def grid_faces(nr, nc, wrap_c=False, off=0):
    f = []
    cc = nc if wrap_c else nc - 1
    for i in range(nr - 1):
        for j in range(cc):
            j1 = (j + 1) % nc
            f.append((off + i * nc + j, off + (i + 1) * nc + j, off + (i + 1) * nc + j1, off + i * nc + j1))
    return f


def shell(H, name, part, U, V, w_out, w_in, mat, close=(True, True, True, True)):
    """A shell over the (u, v) grid (rows along u, columns across), outer at w_out, inner at w_in, its four edges
    closed by rims (first row, last row, first column, last column)."""
    nr, nc = U.shape
    uvw_o = np.c_[U.ravel(), V.ravel(), np.full(U.size, w_out)]
    uvw_i = np.c_[U.ravel(), V.ravel(), np.full(U.size, w_in)]
    verts = np.vstack([wrap(H, part, uvw_o), wrap(H, part, uvw_i)])
    n = nr * nc
    faces = grid_faces(nr, nc) + [tuple(reversed(f)) for f in grid_faces(nr, nc, off=n)]
    idx = lambda i, j: i * nc + j
    if close[0]:
        faces += [(idx(0, j), idx(0, j + 1), n + idx(0, j + 1), n + idx(0, j)) for j in range(nc - 1)]
    if close[1]:
        faces += [(idx(nr - 1, j), idx(nr - 1, j + 1), n + idx(nr - 1, j + 1), n + idx(nr - 1, j)) for j in range(nc - 1)]
    if close[2]:
        faces += [(idx(i, 0), idx(i + 1, 0), n + idx(i + 1, 0), n + idx(i, 0)) for i in range(nr - 1)]
    if close[3]:
        faces += [(idx(i, nc - 1), idx(i + 1, nc - 1), n + idx(i + 1, nc - 1), n + idx(i, nc - 1)) for i in range(nr - 1)]
    return mesh_object(name, verts, faces, mat)


def jaw_grid(H, nr=90, nc=61):
    """The lower jaw's (u, v) grid: rows from the throat to the tip, columns from the -X rim round the bottom to the
    +X rim, the band narrowing to the bottom centre over the nose (a scoop rounded in plan)."""
    nose = H.D['lower'].get('nose', 0.06)
    us = np.linspace(H.throat, H.ltip, nr)
    vr = H.lrim_v(us)
    vb = H.S(us)
    k = np.clip((us - (H.ltip - nose)) / nose, 0, 1)
    vr = vr + (vb - vr) * (1 - np.sqrt(1 - k ** 2))
    c = np.linspace(-1, 1, nc)
    U = np.repeat(us[:, None], nc, 1)
    V = np.sign(c)[None] * (vb[:, None] - (vb - vr)[:, None] * np.abs(c)[None])
    V[:, nc // 2] = vb   # (the bottom centre)
    return U, V


# ---------- the cannon ----------

def build(path):
    D = json.load(open(path))
    H = geom.Hull(D['hull'])
    mats = {c: material(c) for c in (RED, GOLD, GLASS, PANEL, BACKING, SILVER, GLOW)}
    parts = []
    # (backing: the closed rear as a tube from the root's apex to the throat; the hood; the jaw; the throat wall)
    nr, nc = 140, 160
    us = np.linspace(0.0015, H.throat, nr)
    t = np.linspace(-1, 1, nc + 1)[:-1]
    U = np.repeat(us[:, None], nc, 1)
    V = H.S(us)[:, None] * t[None]
    uvw = np.c_[U.ravel(), V.ravel(), np.zeros(U.size)]
    verts = list(wrap(H, 'upper', uvw))
    faces = grid_faces(nr, nc, wrap_c=True)
    apex = len(verts)
    verts.append(H.P(np.array([0.0]), np.array([0.0]))[0])
    faces += [(apex, (j + 1) % nc, j) for j in range(nc)]
    # (the throat wall: a fan closing the tube's front ring)
    ctr = len(verts)
    zc = (np.interp(H.throat, H.u, H.zt) + np.interp(H.throat, H.u, H.zb)) / 2
    verts.append(np.array([0.0, H.throat, zc]))
    faces += [(ctr, (nr - 1) * nc + j, (nr - 1) * nc + (j + 1) % nc) for j in range(nc)]
    parts.append(mesh_object('backing_rear', verts, faces, mats[BACKING]))
    uj = np.linspace(H.throat, 1.0, 70)
    vr = H.rim_v(uj)
    c = np.linspace(-1, 1, 81)
    parts.append(shell(H, 'backing_hood', 'upper', np.repeat(uj[:, None], 81, 1), vr[:, None] * c[None],
                       0.0, -SHELL, mats[BACKING]))
    U, V = jaw_grid(H)
    parts.append(shell(H, 'backing_jaw', 'lower', U, V, 0.0, -SHELL, mats[BACKING]))
    # (panels)
    for p in D['panels']:
        cls = p['cls']
        top = p.get('h', 1.0) * UNIT
        bottom = p.get('bottom', -0.003)
        o = curve_solid(H, p['name'], [p['outer']] + p.get('holes', []), top, bottom, BEVEL[cls],
                        p.get('part', 'upper'), mats[cls])
        if o:
            parts.append(o)
    # (inside the lower jaw: chrome ribs standing off its inner face)
    for i, r in enumerate(D.get('ribs', [])):
        o = curve_solid(H, f'rib{i}', [r['outer']], -SHELL, -SHELL - r.get('depth', 0.012), 0.0012, 'lower',
                        mats[SILVER])
        if o:
            parts.append(o)
    parts += teeth(H, D, mats)
    parts += emitter(H, D, mats)
    root = bpy.data.objects.new('mk50_cannon', None)
    bpy.context.scene.collection.objects.link(root)
    for o in parts:
        o.parent = root
    return root, H, D


def teeth(H, D, mats):
    """Small chrome teeth along the upper jaw's rims, pointing into the mouth."""
    T = D.get('teeth', {})
    if not T:
        return []
    verts, faces = [], []
    for u in T['u']:
        for s in (1, -1):
            v = s * float(H.rim_v(np.array([u]))[0])
            base = wrap(H, 'upper', np.array([[u, v, -SHELL / 2]]))[0]
            # (down the surface, past the rim)
            ahead = wrap(H, 'upper', np.array([[u, v + s * 0.004, -SHELL / 2]]))[0]
            d = ahead - base
            d /= np.linalg.norm(d)
            along = np.array([0.0, 1.0, 0.0])
            nrm = np.cross(along, d)
            nrm /= np.linalg.norm(nrm)
            L, b, th = T.get('len', 0.016), T.get('base', 0.011), SHELL * 0.7
            k = len(verts)
            tip = base + d * L
            for sa in (-1, 1):
                for sn in (-1, 1):
                    verts.append(base + along * sa * b / 2 + nrm * sn * th / 2 - d * 0.004)
            verts.append(tip + nrm * th * 0.2)
            verts.append(tip - nrm * th * 0.2)
            faces += [(k, k + 2, k + 3, k + 1), (k, k + 1, k + 5), (k + 2, k + 4, k + 3),
                      (k, k + 5, k + 4, k + 2), (k + 1, k + 3, k + 4, k + 5)]
    return [mesh_object('teeth', verts, faces, mats[SILVER], smooth=False)]


def hex_block(H, name, part, uc, hl, hw, z0, z1, mat, hole=None):
    """A hexagon lying flat (pointed ends along +-Y) from z=z0 to z=z1, centred on x=0, y=uc, carried with `part`
    (the lower jaw swings); with hole (an inner hexagon's scale) a frame."""
    ang = np.radians([0, 60, 120, 180, 240, 300])
    ring = [(hw * math.sin(a) / math.sin(math.radians(60)) * (1 if a < math.pi else 1), uc + hl * math.cos(a))
            for a in ang]
    ring = [(x, y) for x, y in ring]
    verts, faces = [], []
    if hole is None:
        verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
        faces = [tuple(range(6, 12)), tuple(reversed(range(6)))]
        faces += [(i, (i + 1) % 6, 6 + (i + 1) % 6, 6 + i) for i in range(6)]
    else:
        inner = [(x * hole, uc + (y - uc) * hole) for x, y in ring]
        for z in (z0, z1):
            verts += [(x, y, z) for x, y in ring] + [(x, y, z) for x, y in inner]
        o0, i0, o1, i1 = 0, 6, 12, 18
        for i in range(6):
            j = (i + 1) % 6
            faces += [(o1 + i, o1 + j, i1 + j, i1 + i), (o0 + j, o0 + i, i0 + i, i0 + j),
                      (o0 + i, o0 + j, o1 + j, o1 + i), (i0 + j, i0 + i, i1 + i, i1 + j)]
    verts = np.array(verts, float)
    if part == 'lower' and H.open:
        verts = H.swing(verts)
    return mesh_object(name, verts, faces, mat, smooth=False)


def emitter(H, D, mats):
    """The hexagonal emitter lying in the rear of the lower jaw (where the photo shows it, behind the first ribs):
    a glowing block standing off the jaw's floor, a chrome frame round its top face."""
    E = D.get('emitter')
    if not E:
        return []
    uc = E['u']
    floor = float(np.interp(uc, H.u, H.zb)) + SHELL * 0.5
    z1 = floor + E['height']
    return [hex_block(H, 'emitter_core', 'lower', uc, E['half_l'] * 0.84, E['half_w'] * 0.84, floor + 0.004, z1 - 0.003,
                      mats[GLOW]),
            hex_block(H, 'emitter_frame', 'lower', uc, E['half_l'], E['half_w'], z1 - 0.014, z1 + 0.003, mats[SILVER],
                      hole=0.8)]


# ---------- views ----------

def stage(root, H, D, out):
    sc = bpy.context.scene
    for loc, e, sz in (((-2.0, 2.5, 4.0), 420, 2.0), ((2.8, 0.5, 3.0), 140, 2.0), ((0, -3, 2.0), 60, 2.5),
                       ((0.5, 4.0, -0.5), 160, 1.5)):
        l = bpy.data.objects.new('l', bpy.data.lights.new('l', 'AREA'))
        l.data.energy, l.data.size = e, sz
        sc.collection.objects.link(l)
        l['base'] = loc
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.07, 0.05, 0.045, 1)
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('CANNON_SAMPLES', 32))
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.render.film_transparent = True
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'
    res = int(os.environ.get('CANNON_RES', 900))

    def place_lights(Rcam):
        """The shield's key/fill/rim lights, fixed relative to the camera (its frame: x right, y up, z back)."""
        for l in [o for o in sc.objects if o.type == 'LIGHT']:
            p = Rcam @ Vector(l['base'])
            l.location = p + MID
            l.rotation_euler = (-p).to_track_quat('-Z', 'Y').to_euler()
    # (side: from +X, root left, tip right; the view's centre at the hull's middle)
    V = D.get('views', {})
    sv = V.get('side', {'centre': [0.56, 0.02], 'width': 1.36, 'aspect': 0.5})
    Rside = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0)))  # (camera x -> +Y, camera y -> +Z, camera z (back) -> +X)
    cam.rotation_euler = Rside.to_euler()
    cy, cz = sv['centre']
    cam.location = Vector((5.0, cy, cz))
    cam.data.ortho_scale = sv['width']
    sc.render.resolution_x = res
    sc.render.resolution_y = int(res * sv['aspect'])
    place_lights(Rside)
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    # (three-quarter: the Monkey Depot photo's camera, orthographic)
    m = V.get('md')
    if m:
        b, a, roll, s, tx, ty = m['cam']
        R = np.array(R_of(b, a, roll))           # (model -> camera)
        Rc = Matrix(R.T.tolist())                 # (camera axes in the model frame)
        W_, H_ = m['size']
        cx, cyy = (W_ / 2 - tx) / s, (ty - H_ / 2) / s
        centre = Rc @ Vector((cx, cyy, 0))
        cam.rotation_euler = Rc.to_euler()
        cam.location = centre + Rc @ Vector((0, 0, 5.0))
        cam.data.ortho_scale = W_ / s
        k = m.get('scale', 2)
        sc.render.resolution_x = int(W_ * k)
        sc.render.resolution_y = int(H_ * k)
        place_lights(Rc)
        sc.render.filepath = out.replace('.png', '_34.png')
        bpy.ops.render.render(write_still=True)


def R_of(b, a, roll):
    cb, sb = math.cos(math.radians(b)), math.sin(math.radians(b))
    ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    cr, sr = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    Ry = np.array([[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]])
    Rx = np.array([[1, 0, 0], [0, ca, -sa], [0, sa, ca]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Rz @ Rx @ Ry


if __name__ == '__main__':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root, H, D = build(sys.argv[-2])
    stage(root, H, D, os.path.abspath(sys.argv[-1]))

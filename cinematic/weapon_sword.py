"""Builds the Mark 50 nano sword in Blender from the traced lines (weapon_sword.json, traced by hand on the threezero figure photo).
  python weapon_sword.py weapon_sword.json out.png      renders out.png (front, orthographic) and out_34.png (three-quarter)
The model: long axis +Y from the root (y=0, where it comes out of the wrist; the blade runs on to y=-0.043 inside the
gauntlet) to the tip (y=1), the cutting edge towards +X, facing +Z (the side seen in the photo), length 1.
One lofted piece, `sword_core`, one cross-section ring per station along the traced lines. Across, from the back:
  the rounded back; the red body (s 36..184 photo px): a flat bar standing proud of the face, its outer part flat
  and dark, a low crest two-thirds across that catches the key light, then a drop into a fine dark groove (G1);
  below s=36 that zone is instead the pale pink-silver facet, tilted towards the key light, bounded by the groove
  that runs on diagonally to the edge side; the pink-mauve strip (or, past the red's end, the darker pink-grey bare
  spine) sloping down to a second faint groove (G2); the neutral silver face (a slight convex grind, mottled pink /
  blue, a faint pale glow rising only towards the ridge); the narrow chamfer of the ridge, which carries the blue
  glow; the dark bevel to the sharp cutting edge (convex: steel-grey at its shoulder to navy at the edge; it fades to
  steel and then silver towards the root). Face 1.6% of the length thick, the red body 2.6%.
  `sword_halo`, a soft pale-blue glow just outside the cutting edge (a fin in the blade's plane, fading outwards,
  invisible to light rays): set SWORD_HALO=0 to leave it out.
Materials: Principled BSDF. Red, backing and the glowing blue as the suit's; silver, steel, facet and mauve as below.
"""
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Vector, Matrix

T_FACE = 0.008      # (half-thickness of the flat silver face)
DR = 0.0026         # (the red body stands this far proud of the face, each side)
CREST = 0.0007      # (the crest two-thirds across the red body)
T_EDGE = 0.0003     # (half-thickness at the cutting edge: sharp)
TAPER = 0.13        # (the blade thins to the point over this last part of its length)
CROWN = 0.0009      # (convex grind across the silver face)
GW1, GD1 = 0.5, 0.0009    # (groove at the red's inner edge: width in photo px, depth)
GW2, GD2 = 0.35, 0.0004   # (faint groove where the silver begins)
RIDGE_DROP = 0.0006       # (the ridge chamfer drops this much towards the bevel)
FACET_LO, FACET_HI = -0.0024, 0.0009   # (pale facet at the root: height at the back, at the groove, over the face)
MIN_BEV = 1.0       # (photo px: the bevel is never narrower than this; where the photo has none it is silver)
RED_C, FACE_C, BEVEL_C, FACET_C, MAUVE_C, RIDGE_C, HALO_C = 0, 6, 7, 8, 9, 10, 11
RED = ((0.20, 0.006, 0.009), 0.9, 0.3, 1.0)
GLOW = (0.08, 0.5, 1.0)


def _env(name, default):
    v = os.environ.get(name)
    return tuple(float(x) for x in v.split(',')) if v and ',' in v else (float(v) if v else default)


def smooth01(x, a, b):
    u = min(1.0, max(0.0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)


# ---------------------------------------------------------------- materials
def _nodes(m):
    m.use_nodes = True
    nt = m.node_tree
    return nt, nt.nodes['Principled BSDF']


def _attr(nt, name):
    a = nt.nodes.new('ShaderNodeAttribute')
    a.attribute_name = name
    return a.outputs['Fac']


def _math(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _mix(nt, fac, a, b):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    for sock, v in ((n.inputs['Factor'], fac), (n.inputs['A'], a), (n.inputs['B'], b)):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, tuple):
            sock.default_value = (*v, 1) if len(v) == 3 else v
        else:
            nt.links.new(v, sock)
    return n.outputs['Result']


def _noise(nt, scale, detail=3.0):
    tc = nt.nodes.new('ShaderNodeTexCoord')
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = 0.55
    nt.links.new(tc.outputs['Object'], n.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')  # (contrast: most of the face neutral, the tints in patches)
    ramp.color_ramp.elements[0].position = 0.38
    ramp.color_ramp.elements[1].position = 0.62
    nt.links.new(n.outputs['Fac'], ramp.inputs['Fac'])
    return ramp.outputs['Color']


SILVER = _env('FACE_BASE', (0.44, 0.46, 0.52))
SILVER_PINK = _env('FACE_PINK', (0.50, 0.42, 0.47))
SILVER_BLUE = _env('FACE_BLUE', (0.40, 0.46, 0.58))


def material(cls):
    m = bpy.data.materials.new(f'sword_{cls}')
    nt, b = _nodes(m)
    if cls == RED_C:  # (the suit's red)
        col, met, rough, coat = RED
        b.inputs['Base Color'].default_value = (*col, 1)
        b.inputs['Metallic'].default_value = met
        b.inputs['Roughness'].default_value = rough
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.06
    elif cls == FACE_C:  # (neutral silver, mottled pink / blue; a faint pale glow that rises only towards the ridge)
        nz = _noise(nt, 38.0)
        tint = _mix(nt, nz, SILVER_PINK, SILVER_BLUE)
        nt.links.new(_mix(nt, 0.55, SILVER, tint), b.inputs['Base Color'])
        b.inputs['Metallic'].default_value = _env('FACE_MET', 0.85)
        b.inputs['Roughness'].default_value = _env('FACE_ROUGH', 0.42)
        b.inputs['Emission Color'].default_value = (*_env('FACE_EMC', (0.85, 0.92, 1.0)), 1)
        ramp = _math(nt, 'POWER', _attr(nt, 'u'), _env('FACE_EMP', 3.0))
        nt.links.new(_math(nt, 'MULTIPLY', ramp, _env('FACE_EM', 0.6)), b.inputs['Emission Strength'])
    elif cls == RIDGE_C:  # (the glowing ridge: the glowing blue at a low strength; none where the bevel fades out)
        b.inputs['Base Color'].default_value = (0.62, 0.68, 0.78, 1)
        b.inputs['Metallic'].default_value = 1.0
        b.inputs['Roughness'].default_value = 0.25
        b.inputs['Emission Color'].default_value = (*GLOW, 1)
        on = _math(nt, 'SUBTRACT', 1.0, _attr(nt, 'fade'), clamp=True)
        nt.links.new(_math(nt, 'MULTIPLY', on, _env('RIDGE_EM', 4.0)), b.inputs['Emission Strength'])
    elif cls == BEVEL_C:  # (steel-grey at the shoulder to navy at the edge; to steel then silver towards the root)
        bv = _math(nt, 'POWER', _attr(nt, 'bv'), 0.8)
        col = _mix(nt, bv, _env('BEV_IN', (0.20, 0.23, 0.30)), _env('BEV_OUT', (0.035, 0.05, 0.08)))
        nt.links.new(_mix(nt, _attr(nt, 'fade'), col, SILVER), b.inputs['Base Color'])
        b.inputs['Metallic'].default_value = 1.0
        b.inputs['Roughness'].default_value = _env('BEV_ROUGH', 0.36)
    elif cls == FACET_C:  # (pale pink-white chrome)
        b.inputs['Base Color'].default_value = (*_env('FACET_BASE', (0.80, 0.64, 0.68)), 1)
        b.inputs['Metallic'].default_value = 1.0
        b.inputs['Roughness'].default_value = _env('FACET_ROUGH', 0.32)
    elif cls == MAUVE_C:  # (pink-mauve strip beside the red; past the red's end the bare spine, greyer)
        nt.links.new(_mix(nt, _attr(nt, 'pink'), _env('SPINE_BASE', (0.30, 0.27, 0.31)),
                          _env('MAUVE_BASE', (0.40, 0.22, 0.27))), b.inputs['Base Color'])
        b.inputs['Metallic'].default_value = 1.0
        b.inputs['Roughness'].default_value = _env('MAUVE_ROUGH', 0.4)
    elif cls == HALO_C:  # (pale-blue glow fading outwards: emission over transparency)
        out = nt.nodes['Material Output']
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (0.19, 0.58, 1.0, 1)
        em.inputs['Strength'].default_value = _env('HALO_EM', 1.5)
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        a = _math(nt, 'POWER', _math(nt, 'SUBTRACT', 1.0, _attr(nt, 'h'), clamp=True), 2.0)
        nt.links.new(_math(nt, 'MULTIPLY', a, _env('HALO_ALPHA', 0.22)), mx.inputs['Fac'])
        nt.links.new(tr.outputs[0], mx.inputs[1])
        nt.links.new(em.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], out.inputs['Surface'])
    return m


# ---------------------------------------------------------------- the traced lines
class Lines:
    """The traced lines (normalised: x across, y along) and the cross-section's anchor points at any y, as in
    shapes.lines_at."""

    def __init__(self, D):
        self.L = D['photo_px']
        ln = D['lines']
        self.l = {k: np.array(ln[k]) for k in ('back', 'g1', 'g2', 'bev', 'edge')}
        self.tip = tuple(ln['tip'])
        self.root = D['root_y']
        self.red = D['red_range']
        self.ridge_w = D['ridge_w']

    def f(self, k, y):
        a = self.l[k]
        return float(np.interp(y, a[:, 1], a[:, 0]))

    def at(self, y):
        px = 1.0 / self.L
        s = y * self.L
        tb, te = self.f('back', y), self.f('edge', y)
        tv = min(self.f('bev', y), te - 0.12 * px)
        g1 = max(tb, self.f('g1', y)) if s <= self.red[1] * self.L else tb
        if s < self.red[0] * self.L - 1:
            g2 = g1
        else:
            g2 = max(g1, self.f('g2', y)) if s < 203 else tb
        g1, g2 = min(g1, tv - 0.6 * px), min(g2, tv - 0.6 * px)
        tr = max(g2 + 0.3 * px, tv - self.ridge_w) if tv - g2 > 0.9 * px else tv
        return tb, g1, g2, tr, tv, te

    def knots(self):
        return np.concatenate([self.l[k][:, 1] for k in self.l])


# ---------------------------------------------------------------- the cross-section
def section(Ln, y):
    """Top half of the cross-section at y: [(x, z, cls_of_segment_to_next, attrs)], from the back to the edge."""
    px = 1.0 / Ln.L
    s = y * Ln.L
    tb, g1, g2, tr, tv, te = Ln.at(y)
    k = min(1.0, (Ln.tip[1] - y) / TAPER) ** 0.7               # (thinning to the point)
    k *= 1.0 - 0.55 * smooth01(-s, 5.0, 10.0)                  # (and at the buried root end)
    T = T_FACE * k
    red = Ln.red[0] * Ln.L <= s <= Ln.red[1] * Ln.L and g1 - tb > 0.05 * px
    facet = s < Ln.red[0] * Ln.L
    mauve = (g2 - g1) > 0.2 * px and not facet
    fade = smooth01(-s, -42.0, -25.0)                          # (bevel: 0 dark, 1 silver; towards the root)
    pink = 1.0 - smooth01(s, 176.0, 190.0)
    # (geometry of the bevel: never narrower than MIN_BEV; the ridge goes with it)
    if te - tv < MIN_BEV * px:
        tv = te - MIN_BEV * px
        tr = tv
    tr = min(tr, tv)
    g1, g2 = min(g1, tr - 0.4 * px), min(g2, tr - 0.4 * px)
    wid = (g1 - tb) / px
    zr = T + DR * k * smooth01(wid, 0.0, 2.2)                   # (the red bar: lower as it tapers out)
    if red:
        zA0, zA1, cA = zr, zr - 0.0004 * k, RED_C
    elif facet:
        zA0, zA1, cA = T + FACET_LO * k, T + FACET_HI * k, FACET_C
    else:
        zA0 = zA1 = T + 0.0006 * k
        cA = MAUVE_C
    face0 = T + 0.0002 * k
    zM0 = (zr - 0.0010 * k) if red else (T + 0.0006 * k if not facet else face0)
    zM1 = T + 0.0003 * k
    cM = MAUVE_C if mauve or not facet else FACE_C
    if facet:
        zM1 = face0
    gw1 = GW1 * px
    gw2 = GW2 * px if mauve else 0.02 * px
    r = max(0.05 * px, min(zA0, 0.35 * max(g2 - tb, 2.0 * px), 1.6 * px))
    pts = []

    def add(x, z, c, **a):
        if pts and x < pts[-1][0] + 1e-6:
            x = pts[-1][0] + 1e-6
        pts.append((x, z, c, a))

    add(tb, 0.0, cA)
    for a in (30, 60, 90):
        add(tb + r * (1 - math.cos(math.radians(a))), zA0 * math.sin(math.radians(a)), cA)
    a0, a1 = tb + r, g1 - gw1 / 2
    if red:
        for fr, z in ((0.55, zr), (0.8, zr + CREST * k)):
            add(a0 + fr * (a1 - a0), z, cA)
    else:
        for fr in (0.4, 0.75):
            add(a0 + fr * (a1 - a0), zA0 + fr * (zA1 - zA0), cA)
    add(a1, zA1, cA)
    gd1 = GD1 * k if (red or facet) else 0.0
    add(g1, min(zA1, zM0) - gd1, cM)
    m0, m1 = g1 + gw1 / 2, g2 - gw2 / 2
    add(m0, zM0, cM)
    add(m0 + 0.5 * (m1 - m0), 0.5 * (zM0 + zM1), cM)
    add(m1, zM1, cM if mauve or not facet else FACE_C)
    add(g2, zM1 - (GD2 * k if mauve else 0.0), FACE_C)
    f0, f1 = g2 + gw2 / 2, tr
    nface = 7
    for i in range(nface):
        u = i / (nface - 1)
        add(f0 + u * (f1 - f0), T + 4 * CROWN * k * u * (1 - u) + (0.0002 * k) * (1 - u),
            FACE_C if i < nface - 1 else RIDGE_C, u=u ** 1.0)
    zb0 = T - RIDGE_DROP * k
    vs = (0.0, 0.2, 0.45, 0.72, 1.0)
    for v in vs:
        w = 0.5 * v + 0.5 * v * v
        add(tv + v * (te - tv), zb0 - (zb0 - min(T_EDGE, zb0)) * w, BEVEL_C, bv=v)
    for p in pts:  # (attributes shared along the ring)
        p[3].setdefault('u', 0.0)
        p[3].setdefault('bv', 0.0)
        p[3]['fade'] = fade
        p[3]['pink'] = pink
    return pts


def core(D, mats):
    Ln = Lines(D)
    tip_y = Ln.tip[1]
    kn = Ln.knots()
    ys = np.unique(np.concatenate([np.arange(Ln.root, tip_y, 0.0025), kn[(kn > Ln.root) & (kn < tip_y - 0.004)]]))
    ys = ys[(ys >= Ln.root) & (ys <= tip_y - 0.004)]
    bm = bmesh.new()
    lay = {n: bm.verts.layers.float.new(n) for n in ('u', 'bv', 'fade', 'pink')}
    rings, segc = [], []
    for y in ys:
        top = section(Ln, y)
        n = len(top)
        prof = top + [(x, -z, c, a) for x, z, c, a in reversed(top[1:])]
        ring = []
        for x, z, c, a in prof:
            v = bm.verts.new((x, y, z))
            for nm, L in lay.items():
                v[L] = a[nm]
            ring.append(v)
        rings.append(ring)
        # (segment classes round the ring: top side k -> k+1, then the bottom side mirrored)
        ct = [top[i][2] for i in range(n - 1)]
        segc.append(ct + [top[n - 1][2]] + ct[::-1][:-1] + [ct[0]])
    nring = len(rings[0])
    ntop = len(section(Ln, ys[0]))
    sharp_idx = set()
    # longitudinal edges at the grooves' bottoms and shoulders, the ridge, the bevel's start and the edge
    for i in (6, 7, 8, 10, 11, 12, ntop - 6, ntop - 5, ntop - 1):
        sharp_idx.add(i)
        sharp_idx.add(nring - i if i else 0)
    cls_index = {c: i for i, c in enumerate((FACE_C, BEVEL_C, RED_C, FACET_C, MAUVE_C, RIDGE_C))}
    for j, (a, b) in enumerate(zip(rings[:-1], rings[1:])):
        sm = (ys[j] + ys[j + 1]) / 2 * Ln.L
        c_lo, c_hi = segc[j], segc[j + 1]
        for k in range(nring):
            f = bm.faces.new((a[k], a[(k + 1) % nring], b[(k + 1) % nring], b[k]))
            c = c_hi[k] if sm >= Ln.red[0] * Ln.L and (c_lo[k] == FACET_C) else c_lo[k]
            f.material_index = cls_index[c]
    cap = bm.faces.new(rings[0][::-1])
    cap.material_index = cls_index[FACE_C]
    tip = bm.verts.new((Ln.tip[0], Ln.tip[1], 0))
    for nm, L in lay.items():
        tip[L] = rings[-1][0][L]
    last = rings[-1]
    for k in range(nring):
        f = bm.faces.new((last[k], last[(k + 1) % nring], tip))
        f.material_index = cls_index[segc[-1][k]]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.smooth = True
    ring_of = {}
    for ri, ring in enumerate(rings):
        for k, v in enumerate(ring):
            ring_of[v] = (ri, k)
    for ed in bm.edges:
        a, b = ed.verts
        ka, kb = ring_of.get(a), ring_of.get(b)
        if ka and kb and ka[1] == kb[1] and ka[1] in sharp_idx:
            ed.smooth = False
        elif len(ed.link_faces) == 2 and ed.calc_face_angle(0) > math.radians(40):
            ed.smooth = False
    me = bpy.data.meshes.new('sword_core')
    bm.to_mesh(me)
    bm.free()
    for c in (FACE_C, BEVEL_C, RED_C, FACET_C, MAUVE_C, RIDGE_C):
        me.materials.append(mats[c])
    o = bpy.data.objects.new('sword_core', me)
    bpy.context.scene.collection.objects.link(o)
    return o, Ln, ys


def halo(Ln, ys, mat, width=0.010):
    """A fin in the blade's plane along the cutting edge and round the point, from the edge outwards by `width`,
    attribute h 0 at the edge -> 1 outside (the material fades it out)."""
    bm = bmesh.new()
    h = bm.verts.layers.float.new('h')
    inner, outer = [], []
    pts = [(Ln.at(y)[5], y) for y in ys if y > 0.12] + [Ln.tip]
    pts = np.array(pts)
    for i, (x, y) in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        d = b - a
        nrm = np.array([d[1], -d[0]]) / (np.hypot(*d) + 1e-12)  # (outwards: towards +x)
        fade_in = smooth01(y, 0.12, 0.2)
        vi = bm.verts.new((x, y, 0))
        vo = bm.verts.new((x + nrm[0] * width * fade_in, y + nrm[1] * width * fade_in, 0))
        vi[h], vo[h] = 0.0, 1.0
        inner.append(vi)
        outer.append(vo)
    for i in range(len(pts) - 1):
        bm.faces.new((inner[i], inner[i + 1], outer[i + 1], outer[i]))
    me = bpy.data.meshes.new('sword_halo')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new('sword_halo', me)
    bpy.context.scene.collection.objects.link(o)
    o.visible_shadow = False
    o.visible_diffuse = False
    o.visible_glossy = False
    o.visible_transmission = False
    o.visible_volume_scatter = False
    return o


def build(path):
    D = json.load(open(path))
    mats = {c: material(c) for c in (RED_C, FACE_C, BEVEL_C, FACET_C, MAUVE_C, RIDGE_C, HALO_C)}
    root = bpy.data.objects.new('mk50_sword', None)
    bpy.context.scene.collection.objects.link(root)
    o, Ln, ys = core(D, mats)
    parts = [o]
    if _env('SWORD_HALO', 1.0) > 0:
        parts.append(halo(Ln, ys, mats[HALO_C]))
    for p in parts:
        p.parent = root
    return root, D


def stage(root, D, out, samples=32):
    sc = bpy.context.scene
    sil = np.array(D['silhouette'])
    xc = (sil[:, 0].min() + sil[:, 0].max()) / 2
    up = Matrix.Rotation(math.radians(90), 3, 'X')  # (stood up: facing -Y, tip up)
    root.rotation_euler = (math.radians(90), 0, 0)
    root.location = (-xc, 0, -0.5)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 1.06
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
    sc.cycles.samples = int(_env('SAMPLES', samples))
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.render.film_transparent = True
    sc.render.resolution_y = 1000
    sc.render.resolution_x = 200
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    if _env('ONLY_FRONT', 0.0) > 0:
        return
    cam.data.type = 'PERSP'
    cam.data.lens = 60
    cam.data.sensor_fit = 'VERTICAL'
    cam.data.sensor_height = 36
    d = 0.6 / math.tan(math.atan(18 / 60))
    yaw, pitch = math.radians(34), math.radians(8)
    cam.location = (d * math.sin(yaw) * math.cos(pitch), -d * math.cos(yaw) * math.cos(pitch), d * math.sin(pitch))
    cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.resolution_x = 300
    sc.render.filepath = out.replace('.png', '_34.png')
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root, D = build(sys.argv[-2])
    stage(root, D, os.path.abspath(sys.argv[-1]))

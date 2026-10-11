"""The arena: a fractured slab of dark rock floating in deep space (Titan-debris style), the drifting rocks
around it, dust in the air, the star backdrop, and the light (a hard key from a nearby star, a cool rim, a dim fill).

Conventions: Z up, 1 unit ~ 0.5 m. The slab's top is the walking surface: z = 0 (within +-0.05) over
x in [-6, 6], y in [-3, 3]. Everything is deterministic (fixed seeds). Works in Blender 4.2+ (tested 4.2 and 5.2).

Public:
    build_arena(scene, key_azimuth=KEY_AZ, key_elevation=KEY_EL, seed=7) -> dict of objects
    arena_lights(scene, key_azimuth=KEY_AZ, key_elevation=KEY_EL, key_strength=..., haze=0.0) -> dict
    set_key(scene, azimuth, elevation, frame=None)   # cheat the key per shot (optionally keyed at a frame)
    ground_z(x, y)                                   # height of the walking surface at (x, y)
    space_backdrop(scene, key_dir, seed=3)           # the world (stars, clusters, nebula) on its own
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

KEY_AZ = 162.0   # degrees; where the key star sits around the arena (0 = +x, 90 = +y)
KEY_EL = 24.0     # degrees above the horizon
RIM_AZ = 38.0
RIM_EL = 16.0
SAFE = (6.0, 3.0)         # the flat walking zone (half extents)
ARENA = 'Arena'
_BVH = {}


# ----------------------------------------------------------------------------------------------------------
# small helpers

def _collection(scene, name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    if col.name not in [c.name for c in scene.collection.children]:
        scene.collection.children.link(col)
    return col


def _obj(name, data, col):
    o = bpy.data.objects.new(name, data)
    col.objects.link(o)
    return o


def _dir(az, el):
    a, e = math.radians(az), math.radians(el)
    return Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))


def _smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def _fbm(p, octaves=5, lac=2.0, gain=0.5, basis='PERLIN_ORIGINAL'):
    s, amp, tot = 0.0, 1.0, 0.0
    q = Vector(p)
    for _ in range(octaves):
        s += amp * noise.noise(q, noise_basis=basis)
        tot += amp
        amp *= gain
        q = q * lac
    return s / tot


def _ridged(p, octaves=4):
    """Sharp creases (0..1, peaks at the creases): fracture-like detail."""
    s, amp, tot = 0.0, 1.0, 0.0
    q = Vector(p)
    for _ in range(octaves):
        n = 1.0 - abs(noise.noise(q))
        s += amp * n * n
        tot += amp
        amp *= 0.5
        q = q * 2.03
    return s / tot


def _facets(p, freq=1.0, depth=1.0, seed=0.0):
    """Piecewise-planar chips (like conchoidal fractures): each Voronoi cell is a tilted plane, so the surface
    breaks into flat facets with sharp steps between them. Returns a displacement (about -depth..depth)."""
    q = p * freq + Vector((seed, seed * 0.7, seed * 1.3))
    d, pts = noise.voronoi(q, distance_metric='DISTANCE', exponent=2.5)
    f = pts[0]
    r = noise.noise_vector(f * 3.71 + Vector((11.0, 7.0, 3.0)))
    lift = noise.noise(f * 5.13 + Vector((2.0, 9.0, 4.0)))
    return depth * (0.6 * lift + 0.9 * (q - f).dot(r))


def _nodes(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    return nt, nt.nodes, nt.links


def _n(nodes, kind, loc=(0, 0), **inputs):
    n = nodes.new(kind)
    n.location = loc
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def _ramp(nodes, loc, stops):
    r = nodes.new('ShaderNodeValToRGB')
    r.location = loc
    el = r.color_ramp.elements
    while len(el) < len(stops):
        el.new(0.5)
    for e, (pos, col) in zip(el, stops):
        e.position = pos
        e.color = col if len(col) == 4 else (*col, 1.0)
    return r


def _mixrgb(nodes, links, blend, fac, a, b, loc=(0, 0)):
    """A colour Mix node (ShaderNodeMix, RGBA) fed by sockets or constants."""
    m = nodes.new('ShaderNodeMix')
    m.data_type = 'RGBA'
    m.blend_type = blend
    m.location = loc
    for sock, v in ((m.inputs[0], fac), (m.inputs[6], a), (m.inputs[7], b)):
        if isinstance(v, bpy.types.NodeSocket):
            links.new(v, sock)
        else:
            sock.default_value = v if not isinstance(v, tuple) or len(v) != 3 else (*v, 1.0)
    return m.outputs[2]


def _math(nodes, links, op, a, b=None, loc=(0, 0), clamp=False):
    m = nodes.new('ShaderNodeMath')
    m.operation = op
    m.use_clamp = clamp
    m.location = loc
    for sock, v in ((m.inputs[0], a), (m.inputs[1], b)):
        if v is None:
            continue
        if isinstance(v, bpy.types.NodeSocket):
            links.new(v, sock)
        else:
            sock.default_value = v
    return m.outputs[0]


# ----------------------------------------------------------------------------------------------------------
# materials

def rock_material(name='Arena_Rock', tint=(1.0, 1.0, 1.0), dust=1.0, scale=1.0):
    """Dark basalt-like rock: mottled grey-brown, cracks, pale dust settled on up-facing surfaces,
    worn convex edges, sparkling mineral flecks, and fine grit in the bump."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, N, L = _nodes(m)
    out = _n(N, 'ShaderNodeOutputMaterial', (1400, 0))
    b = _n(N, 'ShaderNodeBsdfPrincipled', (1100, 0))
    L.new(b.outputs[0], out.inputs['Surface'])
    tc = _n(N, 'ShaderNodeTexCoord', (-1600, 0))
    mp = _n(N, 'ShaderNodeMapping', (-1400, 0))
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    co = mp.outputs['Vector']
    # Domain warp so the patterns are not grid-like.
    w = _n(N, 'ShaderNodeTexNoise', (-1200, 300), Scale=0.35, Detail=3.0)
    warped = _n(N, 'ShaderNodeVectorMath', (-1000, 200))
    warped.operation = 'MULTIPLY_ADD'
    L.new(w.outputs['Color'], warped.inputs[0])
    warped.inputs[1].default_value = (0.9, 0.9, 0.9)
    L.new(co, warped.inputs[2])
    wco = warped.outputs[0]
    # Base mottling.
    n1 = _n(N, 'ShaderNodeTexNoise', (-800, 500), Scale=0.55, Detail=8.0, Roughness=0.62)
    L.new(wco, n1.inputs['Vector'])
    r1 = _ramp(N, (-600, 500), [(0.30, (0.012 * tint[0], 0.0115 * tint[1], 0.0115 * tint[2])),
                                (0.55, (0.026 * tint[0], 0.023 * tint[1], 0.021 * tint[2])),
                                (0.78, (0.050 * tint[0], 0.042 * tint[1], 0.035 * tint[2]))])
    L.new(n1.outputs['Fac'], r1.inputs['Fac'])
    # Fine speckle in the colour (the grain of the stone).
    n2 = _n(N, 'ShaderNodeTexNoise', (-800, 250), Scale=38.0, Detail=4.0, Roughness=0.7)
    L.new(co, n2.inputs['Vector'])
    sp = _ramp(N, (-600, 250), [(0.35, (0.6, 0.6, 0.6)), (0.65, (1.25, 1.2, 1.15))])
    L.new(n2.outputs['Fac'], sp.inputs['Fac'])
    col = _mixrgb(N, L, 'MULTIPLY', 1.0, r1.outputs['Color'], sp.outputs['Color'], (-350, 400))
    # Strata on the faces of the rock (bands in z, distorted).
    wave = _n(N, 'ShaderNodeTexWave', (-800, 0), Scale=0.9, Distortion=6.0, Detail=4.0)
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Z'
    L.new(wco, wave.inputs['Vector'])
    str_r = _ramp(N, (-600, 0), [(0.2, (0.78, 0.78, 0.8)), (0.8, (1.18, 1.1, 1.0))])
    L.new(wave.outputs['Fac'], str_r.inputs['Fac'])
    col = _mixrgb(N, L, 'MULTIPLY', 0.7, col, str_r.outputs['Color'], (-200, 300))
    # Fractured plates: each cell a slab of stone, a shade lighter or darker, a hair higher or lower.
    pl = _n(N, 'ShaderNodeTexVoronoi', (-800, 800), Scale=1.6, Randomness=0.85)
    L.new(wco, pl.inputs['Vector'])
    pls = _n(N, 'ShaderNodeSeparateColor', (-650, 800))
    L.new(pl.outputs['Color'], pls.inputs[0])
    plr = _ramp(N, (-500, 800), [(0.0, (0.5, 0.5, 0.5)), (0.5, (0.9, 0.88, 0.86)), (1.0, (1.5, 1.42, 1.32))])
    L.new(pls.outputs[0], plr.inputs['Fac'])
    col = _mixrgb(N, L, 'MULTIPLY', 1.0, col, plr.outputs['Color'], (-150, 500))
    # Large stains: darker, wetter-looking rock where the dust has blown off.
    stn = _n(N, 'ShaderNodeTexNoise', (-800, 1050), Scale=0.25, Detail=5.0, Roughness=0.55)
    L.new(co, stn.inputs['Vector'])
    stnr = _ramp(N, (-600, 1050), [(0.4, (0.55, 0.55, 0.58)), (0.62, (1, 1, 1))])
    L.new(stn.outputs['Fac'], stnr.inputs['Fac'])
    col = _mixrgb(N, L, 'MULTIPLY', 1.0, col, stnr.outputs['Color'], (-100, 600))
    # Cracks: two scales of cell edges.
    v1 = _n(N, 'ShaderNodeTexVoronoi', (-800, -250), Scale=0.9, Randomness=1.0)
    v1.feature = 'DISTANCE_TO_EDGE'
    L.new(wco, v1.inputs['Vector'])
    c1 = _ramp(N, (-600, -250), [(0.0, (0.05, 0.05, 0.05)), (0.018, (1, 1, 1))])
    L.new(v1.outputs['Distance'], c1.inputs['Fac'])
    v2 = _n(N, 'ShaderNodeTexVoronoi', (-800, -500), Scale=3.4, Randomness=1.0)
    v2.feature = 'DISTANCE_TO_EDGE'
    L.new(wco, v2.inputs['Vector'])
    c2 = _ramp(N, (-600, -500), [(0.0, (0.45, 0.45, 0.45)), (0.03, (1, 1, 1))])
    L.new(v2.outputs['Distance'], c2.inputs['Fac'])
    cm = _n(N, 'ShaderNodeTexNoise', (-800, -700), Scale=0.8, Detail=3.0)
    L.new(co, cm.inputs['Vector'])
    cmr = _ramp(N, (-600, -700), [(0.48, (1, 1, 1)), (0.6, (0, 0, 0))])
    L.new(cm.outputs['Fac'], cmr.inputs['Fac'])
    c1o = _mixrgb(N, L, 'ADD', 1.0, c1.outputs['Color'], cmr.outputs['Color'], (-450, -300))
    crack = _mixrgb(N, L, 'MULTIPLY', 1.0, c1o, c2.outputs['Color'], (-350, -350))
    sat = _n(N, 'ShaderNodeClamp', (-250, -350))
    L.new(crack, sat.inputs['Value'])
    crack = sat.outputs[0]
    # Settled dust: on up-facing surfaces, patchy.
    geo = _n(N, 'ShaderNodeNewGeometry', (-800, -800))
    sep = _n(N, 'ShaderNodeSeparateXYZ', (-600, -800))
    L.new(geo.outputs['Normal'], sep.inputs[0])
    up = _math(N, L, 'MULTIPLY', sep.outputs['Z'], 1.0, (-450, -800))
    upr = _ramp(N, (-300, -800), [(0.7, (0, 0, 0)), (0.95, (1, 1, 1))])
    L.new(up, upr.inputs['Fac'])
    dn = _n(N, 'ShaderNodeTexNoise', (-600, -1050), Scale=1.6, Detail=6.0, Roughness=0.6)
    L.new(wco, dn.inputs['Vector'])
    dnr = _ramp(N, (-400, -1050), [(0.45, (0.0, 0.0, 0.0)), (0.7, (1, 1, 1))])
    L.new(dn.outputs['Fac'], dnr.inputs['Fac'])
    dmask = _mixrgb(N, L, 'MULTIPLY', 1.0, upr.outputs['Color'], dnr.outputs['Color'], (-150, -900))
    dmask = _math(N, L, 'MULTIPLY', dmask, 0.7 * dust, (0, -900), clamp=True)
    col = _mixrgb(N, L, 'MIX', dmask, col, (0.05, 0.041, 0.033), (0, 300))
    # Worn convex edges lighter, cavities darker (pointiness on the dense mesh).
    pt = _n(N, 'ShaderNodeNewGeometry', (-300, 700))
    ptr = _ramp(N, (-100, 700), [(0.46, (0.5, 0.5, 0.5)), (0.5, (1, 1, 1)), (0.56, (1.3, 1.27, 1.22))])
    L.new(pt.outputs['Pointiness'], ptr.inputs['Fac'])
    col = _mixrgb(N, L, 'MULTIPLY', 1.0, col, ptr.outputs['Color'], (200, 400))
    col = _mixrgb(N, L, 'MULTIPLY', 1.0, col, crack, (400, 300))
    L.new(col, b.inputs['Base Color'])
    # Roughness, with sparkling mineral flecks.
    fl = _n(N, 'ShaderNodeTexVoronoi', (-200, 0), Scale=140.0)
    L.new(co, fl.inputs['Vector'])
    flr = _ramp(N, (0, 0), [(0.95, (0.93, 0.93, 0.93)), (0.975, (0.3, 0.3, 0.3))])
    sepc = _n(N, 'ShaderNodeSeparateColor', (-60, -100))
    L.new(fl.outputs['Color'], sepc.inputs[0])
    L.new(sepc.outputs[0], flr.inputs['Fac'])
    L.new(flr.outputs['Color'], b.inputs['Roughness'])
    # Bump: broad form + grit + cracks.
    g1 = _n(N, 'ShaderNodeTexNoise', (300, -300), Scale=7.0, Detail=10.0, Roughness=0.62)
    L.new(wco, g1.inputs['Vector'])
    g2 = _n(N, 'ShaderNodeTexNoise', (300, -500), Scale=70.0, Detail=3.0, Roughness=0.5)
    L.new(co, g2.inputs['Vector'])
    h = _math(N, L, 'MULTIPLY_ADD', g1.outputs['Fac'], 0.7, (500, -350))
    _math_in = h.node
    L.new(g2.outputs['Fac'], _math_in.inputs[2])
    sepk = _n(N, 'ShaderNodeSeparateColor', (300, -700))
    L.new(crack, sepk.inputs[0])
    h2 = _math(N, L, 'MULTIPLY_ADD', sepk.outputs[0], 0.5, (650, -450))
    L.new(h, h2.node.inputs[2])
    h3 = _math(N, L, 'MULTIPLY_ADD', pls.outputs[0], 0.35, (700, -550))
    L.new(h2, h3.node.inputs[2])
    h2 = h3
    bump = _n(N, 'ShaderNodeBump', (850, -300), Strength=0.55, Distance=0.035)
    L.new(h2, bump.inputs['Height'])
    L.new(bump.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Specular IOR Level'].default_value = 0.09
    return m


def mote_material():
    """Dust motes: pale, translucent specks that light up in the key (and glow when back-lit)."""
    m = bpy.data.materials.get('Arena_Mote')
    if m:
        return m
    m = bpy.data.materials.new('Arena_Mote')
    nt, N, L = _nodes(m)
    out = _n(N, 'ShaderNodeOutputMaterial', (600, 0))
    d = _n(N, 'ShaderNodeBsdfDiffuse', (0, 100), Color=(0.5, 0.46, 0.4, 1))
    t = _n(N, 'ShaderNodeBsdfTranslucent', (0, -100), Color=(0.8, 0.72, 0.62, 1))
    mx = _n(N, 'ShaderNodeMixShader', (300, 0), Fac=0.6)
    L.new(d.outputs[0], mx.inputs[1])
    L.new(t.outputs[0], mx.inputs[2])
    L.new(mx.outputs[0], out.inputs['Surface'])
    return m


# ----------------------------------------------------------------------------------------------------------
# geometry

def _convex_chunk(bm, center, half, z_top, z_bot, rng, n_side=14, tilt=(0.05, 0.55), chip=0, protect=None,
                  bottom_cuts=3, yaw=0.0):
    """Add a fractured convex block to bm: a box cut by planes around its sides (tilting in toward the
    bottom), a few chips off the top rim, and oblique cuts under it. protect: (hx, hy) top area kept whole."""
    tmp = bmesh.new()
    bmesh.ops.create_cube(tmp, size=1.0)
    hx, hy = half
    S = Matrix.Diagonal((2 * hx * 1.25, 2 * hy * 1.25, z_top - z_bot, 1.0))
    bmesh.ops.transform(tmp, matrix=S, verts=tmp.verts)
    bmesh.ops.translate(tmp, vec=Vector((0, 0, (z_top + z_bot) / 2)), verts=tmp.verts)

    def cut(co, no):
        res = bmesh.ops.bisect_plane(tmp, geom=tmp.verts[:] + tmp.edges[:] + tmp.faces[:], plane_co=co,
                                     plane_no=no, clear_outer=True)
        edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(tmp, edges=[e for e in tmp.edges if e.is_boundary], sides=0)

    def safe(co, no):
        if not protect:
            return True
        px, py = protect
        for cx, cy in ((-px, -py), (px, -py), (px, py), (-px, py)):
            p = Vector((cx, cy, 0.0)) - center
            p.z = 0.0
            if (p - co).dot(no) > -0.05:
                return False
        return True

    k0 = rng.random() * 2 * math.pi
    for i in range(n_side):
        a = k0 + 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / n_side
        r = rng.uniform(0.8, 1.0)
        co = Vector((hx * r * math.cos(a), hy * r * math.sin(a), z_top))
        no = Vector((math.cos(a) / hx * hy, math.sin(a), -rng.uniform(*tilt)))
        no.xy = no.xy.normalized()
        no.normalize()
        if safe(co, no):
            cut(co, no)
    for i in range(chip):
        a = rng.random() * 2 * math.pi
        r = rng.uniform(0.75, 0.95)
        co = Vector((hx * r * math.cos(a), hy * r * math.sin(a), z_top - rng.uniform(0.05, 0.3)))
        no = Vector((math.cos(a), math.sin(a), rng.uniform(0.5, 1.4))).normalized()
        if safe(co, no):
            cut(co, no)
    for i in range(bottom_cuts):
        a = rng.random() * 2 * math.pi
        co = Vector((hx * 0.4 * math.cos(a), hy * 0.4 * math.sin(a), z_bot + rng.uniform(0.1, 0.5) * (z_top - z_bot)))
        no = Vector((math.cos(a) * rng.uniform(0.4, 1.2), math.sin(a) * rng.uniform(0.4, 1.2), -1.0)).normalized()
        cut(co, no)
    R = Matrix.Rotation(yaw, 4, 'Z')
    bmesh.ops.transform(tmp, matrix=R, verts=tmp.verts)
    bmesh.ops.translate(tmp, vec=Vector((center.x, center.y, 0)), verts=tmp.verts)
    me = bpy.data.meshes.new('_chunk')
    tmp.to_mesh(me)
    tmp.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def _remesh(me, voxel, scene):
    """Fuse overlapping chunks into one watertight surface (voxel remesh) and return the new mesh."""
    tmp = bpy.data.objects.new('_remesh', me)
    scene.collection.objects.link(tmp)
    mod = tmp.modifiers.new('r', 'REMESH')
    mod.mode = 'VOXEL'
    mod.voxel_size = voxel
    mod.adaptivity = 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(me)
    return out


def _displace(me, fn):
    """Move every vertex along its normal by fn(position, normal)."""
    co = [v.co.copy() for v in me.vertices]
    nos = [v.normal.copy() for v in me.vertices]
    for v, p, n in zip(me.vertices, co, nos):
        v.co = p + n * fn(p, n)
    me.update()


def _shade_smooth(me):
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.update()


def slab_mesh(scene, seed=7, voxel=0.075):
    """The arena slab (about 16 x 11 x 2-4 units): several fractured blocks fused into one rock, the main one
    with its top at z = 0, lower ledges and raised outcrops around the rim, a keel underneath."""
    rng = random.Random(seed)
    bm = bmesh.new()
    P = (SAFE[0] + 0.4, SAFE[1] + 0.4)
    # The core (top at z=0, protected over the walking zone) and four overlapping lobes at the same level:
    # their union gives a ragged outline with bays and points instead of one convex plate.
    _convex_chunk(bm, Vector((0, 0, 0)), (6.7, 3.9), 0.0, -2.7, rng, n_side=18, chip=4, protect=P, tilt=(0.15, 0.7))
    for cx, cy, hx, hy, bot, yaw in ((4.4, 2.3, 3.3, 2.3, -2.2, 0.4), (-4.6, 2.1, 3.1, 2.5, -2.5, -0.3),
                                     (4.3, -2.3, 3.4, 2.1, -2.0, -0.2), (-4.4, -2.5, 3.1, 2.1, -2.9, 0.25)):
        _convex_chunk(bm, Vector((cx, cy, 0)), (hx, hy), 0.0, bot, rng, n_side=11, chip=3, protect=P,
                      tilt=(0.1, 0.8), bottom_cuts=2, yaw=yaw)
    # Ledges stepping down and outcrops rising at the rim (outside the walking zone).
    for cx, cy, hx, hy, top, bot, yaw in ((7.0, -0.9, 1.6, 2.2, -0.38, -2.1, 0.3), (-7.2, 0.5, 1.5, 1.9, -0.55, -2.3, -0.4),
                                          (0.6, 4.9, 2.6, 1.0, -0.26, -2.0, 0.1), (-1.2, -4.9, 2.3, 0.95, -0.62, -2.2, -0.15),
                                          (8.0, 2.6, 1.1, 1.3, 0.6, -1.8, 0.7), (-7.0, -4.4, 1.0, 0.8, 0.85, -1.6, 1.1),
                                          (-1.7, 4.9, 0.9, 0.6, 0.45, -1.4, 0.4), (3.3, -4.6, 0.7, 0.5, 0.35, -1.2, -0.5)):
        _convex_chunk(bm, Vector((cx, cy, 0)), (hx, hy), top, bot, rng, n_side=9, chip=2, tilt=(0.1, 0.7),
                      bottom_cuts=2, yaw=yaw)
    # The keel: deeper wedges under the middle (the rock is 2-4+ units thick).
    _convex_chunk(bm, Vector((0.6, -0.3, 0)), (4.6, 3.0), -1.5, -4.4, rng, n_side=9, tilt=(0.6, 1.2), bottom_cuts=3, yaw=0.3)
    _convex_chunk(bm, Vector((1.4, 0.4, 0)), (2.4, 1.7), -3.0, -5.6, rng, n_side=8, tilt=(0.8, 1.6), bottom_cuts=2, yaw=0.9)
    _convex_chunk(bm, Vector((-3.6, 1.0, 0)), (2.6, 2.0), -1.6, -3.7, rng, n_side=8, tilt=(0.5, 1.1), bottom_cuts=2, yaw=-0.5)
    me = bpy.data.meshes.new('Arena_Slab')
    bm.to_mesh(me)
    bm.free()
    me = _remesh(me, voxel, scene)
    me.name = 'Arena_Slab'
    o1 = Vector((13.1, 7.7, 3.3))
    o2 = Vector((-4.2, 21.5, 9.9))

    def disp(p, n):
        # Walking zone: barely undulating; it roughens toward the rim.
        dx = max(0.0, abs(p.x) - SAFE[0])
        dy = max(0.0, abs(p.y) - SAFE[1])
        edge = _smooth(0.0, 1.3, math.hypot(dx, dy))
        top = _smooth(0.55, 0.95, n.z) * _smooth(-0.6, -0.05, p.z)
        t_amp = 0.022 + 0.16 * edge
        t = t_amp * _fbm(p * 0.33 + o1, 4) + 0.012 * (1 - edge) * _fbm(p * 1.7 + o2, 3)
        t += 0.008 * _facets(p, 2.2, 1.0, 13.0) + 0.006 * _fbm(p * 4.0 + o1, 2)
        # Faces of the rock: chipped flat facets at two scales, broad relief, strata ledges.
        s = 0.16 * _facets(p, 0.55, 1.0, 3.0) + 0.06 * _facets(p, 1.7, 1.0, 8.0)
        s += 0.16 * _fbm(p * 0.35 + o2, 4) + 0.05 * (_ridged(p * 1.3 + o1, 3) - 0.5)
        band = p.z * 1.6 + 0.9 * _fbm(p * 0.25, 2)
        s += 0.06 * _smooth(0.55, 0.95, band - math.floor(band))
        # The top's rim breaks the same way (the walking zone stays smooth).
        t += edge * (0.14 * _facets(p, 0.8, 1.0, 5.0) + 0.05 * _fbm(p * 1.4 + o2, 3))
        return top * t + (1 - top) * s

    _displace(me, disp)
    _shade_smooth(me)
    return me


def rock_mesh(name, seed, size=1.0, voxel=None):
    """A free-floating broken rock about 2*size across (fractured block, fused, with relief)."""
    rng = random.Random(seed)
    bm = bmesh.new()
    hx, hy = size * rng.uniform(0.8, 1.1), size * rng.uniform(0.55, 0.9)
    zt, zb = size * rng.uniform(0.3, 0.6), -size * rng.uniform(0.5, 0.9)
    _convex_chunk(bm, Vector((0, 0, 0)), (hx, hy), zt, zb, rng, n_side=9, chip=3, tilt=(0.2, 0.9), bottom_cuts=3,
                  yaw=rng.random() * 3)
    if rng.random() < 0.7:
        _convex_chunk(bm, Vector((hx * 0.5, -hy * 0.3, 0)), (hx * 0.55, hy * 0.6), zt * 1.35, zb * 0.5, rng, n_side=7,
                      chip=1, tilt=(0.3, 1.0), bottom_cuts=1, yaw=rng.random() * 3)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me = _remesh(me, voxel or size * 0.06, bpy.context.scene)
    me.name = name
    off = Vector((rng.uniform(-50, 50), rng.uniform(-50, 50), rng.uniform(-50, 50)))

    def disp(p, n):
        q = p / size
        return size * (0.07 * _facets(q, 1.1, 1.0, off.x) + 0.03 * _facets(q, 3.0, 1.0, off.y)
                       + 0.08 * _fbm(q * 0.9 + off, 4) + 0.03 * (_ridged(q * 2.2 + off, 3) - 0.5))

    _displace(me, disp)
    _shade_smooth(me)
    return me


def _pebble_verts(rng, variants):
    v, f = variants[rng.randrange(len(variants))]
    return v, f


def _pebble_variants(seed, count=6):
    """Angular stones: a lumpy sphere broken by a few flat cuts (unit size, flattened in z)."""
    out = []
    for k in range(count):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
        r = random.Random(seed + k)
        off = Vector((r.uniform(-9, 9), r.uniform(-9, 9), r.uniform(-9, 9)))
        sq = (1.0, r.uniform(0.55, 0.9), r.uniform(0.35, 0.6))
        for vert in bm.verts:
            p = vert.co
            d = 1.0 + 0.25 * noise.noise(p * 1.3 + off) + 0.08 * noise.noise(p * 3.1 + off)
            vert.co = Vector((p.x * d * sq[0], p.y * d * sq[1], p.z * d * sq[2]))
        for c in range(r.randint(3, 6)):
            no = Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-0.6, 1))).normalized()
            co = no * r.uniform(0.25, 0.55)
            res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co,
                                         plane_no=no, clear_outer=True)
            bnd = [e for e in bm.edges if e.is_boundary]
            if bnd:
                bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        verts = [vv.co.copy() for vv in bm.verts]
        faces = [[vv.index for vv in fc.verts] for fc in bm.faces]
        bm.free()
        out.append((verts, faces))
    return out


def ground_z(x, y, default=0.0):
    """Height of the walking surface at (x, y) (ray cast onto the slab); default if off the rock."""
    bvh = _BVH.get('slab')
    if bvh is None:
        return default
    hit = bvh.ray_cast(Vector((x, y, 8.0)), Vector((0, 0, -1)), 30.0)
    return hit[0].z if hit[0] is not None else default


def _build_bvh(obj):
    me = obj.data
    mw = obj.matrix_world
    _BVH['slab'] = BVHTree.FromPolygons([mw @ v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])


def scatter_pebbles(scene, col, mat, seed=11, n_pebbles=700, n_grit=6000):
    """Loose stones and grit on the slab's top: tiny in the fighting area, rubble toward the rim."""
    rng = random.Random(seed)
    variants = _pebble_variants(seed)
    verts, faces = [], []

    def put(x, y, s, sink=0.45):
        z = ground_z(x, y, None)
        if z is None:
            return
        v, f = variants[rng.randrange(len(variants))]
        R = Matrix.Rotation(rng.random() * 6.283, 3, 'Z') @ Matrix.Rotation(rng.uniform(-0.3, 0.3), 3, 'X')
        base = len(verts)
        k = s * rng.uniform(0.8, 1.2)
        for p in v:
            q = R @ (p * k)
            verts.append((x + q.x, y + q.y, z + q.z + k * (0.5 - sink)))
        faces.extend([[base + i for i in fc] for fc in f])

    for _ in range(n_pebbles):
        x, y = rng.uniform(-8.2, 8.2), rng.uniform(-5.8, 5.8)
        dx, dy = max(0.0, abs(x) - SAFE[0] + 1.0), max(0.0, abs(y) - SAFE[1] + 0.8)
        edge = _smooth(0.0, 2.5, math.hypot(dx, dy))
        u = rng.random()
        s = 0.012 + (0.035 + 0.2 * edge) * u ** 4
        put(x, y, s)
    # Rubble heaps at the foot of the outcrops.
    for cx, cy, n in ((6.9, 1.2, 40), (-5.6, -2.7, 35), (-1.5, 4.2, 20), (5.0, -4.0, 18)):
        for _ in range(n):
            a, r = rng.random() * 6.283, abs(rng.gauss(0, 1.0))
            put(cx + r * math.cos(a), cy + r * math.sin(a), 0.03 + 0.2 * rng.random() ** 3)
    me = bpy.data.meshes.new('Arena_Pebbles')
    me.from_pydata(verts, [], faces)
    _shade_smooth(me)
    me.materials.append(mat)
    ob = _obj('Arena_Pebbles', me, col)
    # Grit: a dense sprinkle of tiny flat stones (one mesh).
    verts, faces = [], []
    tet = [(0.0, 0.0, 0.55), (1.0, 0.0, 0.0), (-0.5, 0.87, 0.0), (-0.5, -0.87, 0.0), (0.0, 0.0, -0.3)]
    tf = [(0, 1, 2), (0, 2, 3), (0, 3, 1), (4, 2, 1), (4, 3, 2), (4, 1, 3)]
    for _ in range(n_grit):
        x, y = rng.uniform(-7.8, 7.8), rng.uniform(-5.2, 5.2)
        z = ground_z(x, y, None)
        if z is None:
            continue
        s = 0.006 + 0.016 * rng.random() ** 2
        R = Matrix.Rotation(rng.random() * 6.283, 3, 'Z')
        base = len(verts)
        for p in tet:
            q = R @ Vector((p[0] * s * rng.uniform(0.7, 1.3), p[1] * s, p[2] * s))
            verts.append((x + q.x, y + q.y, z + q.z + 0.002))
        faces.extend([[base + i for i in fc] for fc in tf])
    me = bpy.data.meshes.new('Arena_Grit')
    me.from_pydata(verts, [], faces)
    me.materials.append(mat)
    og = _obj('Arena_Grit', me, col)
    return ob, og


# The drifting rocks: (location, scale, base mesh index, spin rad/s), composed for the main camera axes
# (looking +y across the arena, and the reverse) with some near, some far, many below.
DEBRIS = [
    ((-14.0, 9.0, -6.0), 1.6, 0, 0.05), ((12.5, 13.0, -3.5), 2.2, 1, -0.04), ((22.0, 32.0, 7.0), 4.5, 2, 0.02),
    ((-31.0, 44.0, 12.0), 6.5, 3, -0.015), ((6.0, 48.0, -19.0), 8.0, 0, 0.01), ((-10.0, -17.0, -9.0), 1.3, 1, 0.06),
    ((17.0, -11.0, -12.0), 2.4, 2, -0.03), ((-25.0, 13.0, -17.0), 3.8, 3, 0.02), ((42.0, 24.0, -30.0), 10.0, 1, -0.008),
    ((-60.0, 75.0, 4.0), 13.0, 2, 0.006), ((10.0, 85.0, 28.0), 11.0, 3, -0.006), ((-4.0, 26.0, -26.0), 5.0, 0, 0.012),
    ((11.0, -42.0, 6.0), 6.0, 2, 0.01), ((-22.0, -33.0, -11.0), 4.2, 3, -0.02), ((-7.0, -64.0, 21.0), 10.0, 0, 0.008),
    ((30.0, -5.0, 9.0), 3.0, 1, 0.025), ((-38.0, -6.0, 3.0), 4.0, 0, -0.02),
    # Small debris hanging just off the edges.
    ((9.6, 6.2, -1.8), 0.35, 1, 0.12), ((-10.3, 2.4, 1.7), 0.28, 2, -0.15), ((4.0, 8.4, 2.6), 0.22, 3, 0.18),
    ((-6.5, -7.6, -0.8), 0.4, 0, 0.1), ((10.8, -3.0, 3.6), 0.18, 2, -0.2), ((-2.0, 9.5, -3.2), 0.5, 1, 0.08),
]


def _drive(obj, path, index, expr):
    fc = obj.driver_add(path, index)
    fc.driver.type = 'SCRIPTED'
    fc.driver.expression = expr
    return fc


def debris(scene, col, mat, seed=21):
    """Rocks drifting around and below the slab at many distances (parallax), each slowly turning."""
    rng = random.Random(seed)
    bases = [rock_mesh('Arena_RockMesh%d' % i, seed + 31 * i, 1.0) for i in range(4)]
    for me in bases:
        me.materials.append(mat)
    out = []
    fps = scene.render.fps / max(1e-6, scene.render.fps_base)
    for i, (loc, s, k, spin) in enumerate(DEBRIS):
        o = _obj('Arena_Debris%02d' % i, bases[k], col)
        o.location = loc
        o.scale = (s, s * rng.uniform(0.8, 1.15), s * rng.uniform(0.8, 1.1))
        r0 = (rng.random() * 6.28, rng.random() * 6.28, rng.random() * 6.28)
        o.rotation_euler = r0
        ax = rng.randrange(3)
        w = spin / fps
        _drive(o, 'rotation_euler', ax, '%.4f + frame * %.6f' % (r0[ax], w))
        # A slow bob.
        _drive(o, 'location', 2, '%.3f + %.3f * sin(frame * %.5f + %.2f)' % (loc[2], 0.04 * s ** 0.5, 0.6 / fps, rng.random() * 6.28))
        out.append(o)
    return out


def dust_motes(scene, col, seed=5, counts=(420, 140, 30)):
    """Fine dust hanging in the air around the fighters (three sizes), slowly circling. Lit by the key."""
    rng = random.Random(seed)
    mat = mote_material()
    fps = scene.render.fps / max(1e-6, scene.render.fps_base)
    out = []
    for i, (n, size) in enumerate(zip(counts, (0.0035, 0.006, 0.010))):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=size)
        sm = bpy.data.meshes.new('Arena_MoteMesh%d' % i)
        bm.to_mesh(sm)
        bm.free()
        _shade_smooth(sm)
        sm.materials.append(mat)
        pts = []
        for _ in range(n):
            x, y = rng.gauss(0, 3.2), rng.gauss(0, 2.0)
            z = 0.05 + 6.0 * rng.random() ** 1.8
            pts.append((x, y, z))
        cm = bpy.data.meshes.new('Arena_Motes%d' % i)
        cm.from_pydata(pts, [], [])
        cloud = _obj('Arena_Motes%d' % i, cm, col)
        cloud.instance_type = 'VERTS'
        sphere = _obj('Arena_Mote%d' % i, sm, col)
        sphere.parent = cloud
        _drive(cloud, 'rotation_euler', 2, 'frame * %.6f' % ((0.012 + 0.006 * i) * (1 if i % 2 == 0 else -1) / fps))
        _drive(cloud, 'location', 2, '%.3f * sin(frame * %.5f)' % (0.08 + 0.04 * i, 0.35 / fps))
        out.append(cloud)
    return out


# ----------------------------------------------------------------------------------------------------------
# the backdrop

CLUSTERS = [
    # direction (az, el), core colour, core strength, halo radius (deg), star-swarm radius (deg)
    ((84.0, 13.0), (1.0, 0.8, 0.6), 4.0, 5.0, 2.2),
    ((27.0, 21.0), (0.6, 0.75, 1.0), 3.0, 6.0, 2.6),
    ((-95.0, 16.0), (0.85, 0.65, 1.0), 2.5, 6.0, 2.5),
]


def space_backdrop(scene, key_dir=None, seed=3, nebula=1.0, stars=1.0):
    """The world: a dense field of small stars (colour and brightness varied), glowing star clusters with
    soft cores fading into haze, a faint teal/violet nebula, and the key star itself at key_dir.
    The camera sees all of it; reflections see the glow but not the pin-point stars; diffuse light sees a
    dim cool ambient."""
    w = bpy.data.worlds.get('Arena_Space') or bpy.data.worlds.new('Arena_Space')
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    N, L = nt.nodes, nt.links
    N.clear()
    out = _n(N, 'ShaderNodeOutputWorld', (2200, 0))
    tc = _n(N, 'ShaderNodeTexCoord', (-1800, 0))
    nrm = _n(N, 'ShaderNodeVectorMath', (-1600, 0))
    nrm.operation = 'NORMALIZE'
    L.new(tc.outputs['Generated'], nrm.inputs[0])
    D = nrm.outputs[0]
    off = _n(N, 'ShaderNodeVectorMath', (-1400, -200))
    off.operation = 'ADD'
    L.new(D, off.inputs[0])
    off.inputs[1].default_value = (seed * 1.37, seed * 2.11, seed * 0.53)
    Dn = off.outputs[0]

    def star_layer(scale, radius, keep, gain, y):
        v = _n(N, 'ShaderNodeTexVoronoi', (-1200, y), Scale=scale, Randomness=0.9)
        L.new(Dn, v.inputs['Vector'])
        # A soft dot per cell.
        r = _ramp(N, (-1000, y), [(0.0, (1, 1, 1)), (radius, (0, 0, 0))])
        r.color_ramp.interpolation = 'EASE'
        L.new(v.outputs['Distance'], r.inputs['Fac'])
        # Which cells have a star, and how bright (most faint, a few bright).
        sp = _n(N, 'ShaderNodeSeparateColor', (-1000, y - 150))
        L.new(v.outputs['Color'], sp.inputs[0])
        k = _math(N, L, 'SUBTRACT', sp.outputs[0], 1.0 - keep, (-850, y - 150))
        k = _math(N, L, 'MULTIPLY', k, 1.0 / keep, (-700, y - 150), clamp=True)
        k = _math(N, L, 'POWER', k, 4.0, (-550, y - 150))
        bri = _math(N, L, 'MULTIPLY', k, gain, (-400, y - 150))
        # Colour temperature per star: from blue-white to warm.
        tint = _ramp(N, (-850, y - 350), [(0.0, (0.7, 0.8, 1.0)), (0.5, (1.0, 0.97, 0.92)), (1.0, (1.0, 0.78, 0.55))])
        L.new(sp.outputs[1], tint.inputs['Fac'])
        c = _mixrgb(N, L, 'MULTIPLY', 1.0, r.outputs['Color'], tint.outputs['Color'], (-400, y))
        return _mixrgb(N, L, 'MULTIPLY', 1.0, c, (1, 1, 1), (-250, y)) if False else _scale(c, bri, (-250, y))

    def _scale(col, s, loc):
        m = _n(N, 'ShaderNodeVectorMath', loc)
        m.operation = 'SCALE'
        L.new(col, m.inputs[0])
        if isinstance(s, bpy.types.NodeSocket):
            L.new(s, m.inputs['Scale'])
        else:
            m.inputs['Scale'].default_value = s
        return m.outputs[0]

    def add(a, b, loc):
        m = _n(N, 'ShaderNodeVectorMath', loc)
        m.operation = 'ADD'
        L.new(a, m.inputs[0])
        L.new(b, m.inputs[1])
        return m.outputs[0]

    # A warped copy of the view direction: glows become irregular, clumpy shapes rather than discs.
    wn = _n(N, 'ShaderNodeTexNoise', (-1600, -300), Scale=9.0, Detail=4.0)
    L.new(Dn, wn.inputs['Vector'])
    wsub = _n(N, 'ShaderNodeVectorMath', (-1400, -350))
    wsub.operation = 'SUBTRACT'
    L.new(wn.outputs['Color'], wsub.inputs[0])
    wsub.inputs[1].default_value = (0.5, 0.5, 0.5)
    wad = _n(N, 'ShaderNodeVectorMath', (-1300, -350))
    wad.operation = 'MULTIPLY_ADD'
    L.new(wsub.outputs[0], wad.inputs[0])
    wad.inputs[1].default_value = (0.035, 0.035, 0.035)
    L.new(D, wad.inputs[2])
    wnm = _n(N, 'ShaderNodeVectorMath', (-1150, -350))
    wnm.operation = 'NORMALIZE'
    L.new(wad.outputs[0], wnm.inputs[0])
    Dw = wnm.outputs[0]

    def glow(d, radius_deg, loc, warp=False):
        """exp(-(angle/radius)^2) around direction d (unit vector)."""
        dot = _n(N, 'ShaderNodeVectorMath', loc)
        dot.operation = 'DOT_PRODUCT'
        L.new(Dw if warp else D, dot.inputs[0])
        dot.inputs[1].default_value = d
        one_m = _math(N, L, 'SUBTRACT', 1.0, dot.outputs['Value'], (loc[0] + 150, loc[1]))
        one_m = _math(N, L, 'MAXIMUM', one_m, 0.0, (loc[0] + 220, loc[1]))
        k = 1.0 / (0.5 * math.radians(radius_deg) ** 2)
        e = _math(N, L, 'MULTIPLY', one_m, -k, (loc[0] + 300, loc[1]))
        return _math(N, L, 'EXPONENT', e, None, (loc[0] + 450, loc[1]))

    stars_all = star_layer(420.0, 0.16, 0.5, 1.0 * stars, 900)
    stars_all = add(stars_all, star_layer(110.0, 0.06, 0.1, 10.0 * stars, 500), (-100, 700))
    swarm = star_layer(750.0, 0.22, 0.35, 9.0 * stars, 100)
    # Clusters: bright soft core + wide halo + a swarm of tiny stars.
    camera_extra = None
    glowc = None
    y = -400
    for (az, el), colr, core, halo, swr in CLUSTERS:
        d = tuple(_dir(az, el))
        # A small hot nucleus, a coloured inner glow, a faint wide halo, and a swarm of tiny stars.
        g_core = glow(d, halo * 0.05, (-1200, y))
        g_mid = glow(d, halo * 0.3, (-1200, y - 120), warp=True)
        g_halo = glow(d, halo, (-1200, y - 240), warp=True)
        g_sw = glow(d, swr, (-1200, y - 360), warp=True)
        lum = _math(N, L, 'MULTIPLY_ADD', g_mid, core * 0.05, (-350, y))
        L.new(_math(N, L, 'MULTIPLY', g_core, core * 0.4, (-650, y - 60)), lum.node.inputs[2])
        lum2 = _math(N, L, 'MULTIPLY_ADD', g_halo, core * 0.006, (-200, y))
        L.new(lum, lum2.node.inputs[2])
        cg = _scale(_n(N, 'ShaderNodeRGB', (-350, y - 200)).outputs[0], lum2, (-50, y))
        cg.node.inputs[0].links[0].from_node.outputs[0].default_value = (*colr, 1.0)
        glowc = cg if glowc is None else add(glowc, cg, (100, y))
        sw = _scale(swarm, g_sw, (-50, y - 300))
        camera_extra = sw if camera_extra is None else add(camera_extra, sw, (100, y - 300))
        y -= 600
    # The key star (the arena's sun) where the key light comes from.
    if key_dir is not None:
        kd = tuple(Vector(key_dir).normalized())
        ks = _math(N, L, 'MULTIPLY', glow(kd, 0.35, (-1200, y)), 60.0, (-500, y))
        ks2 = _math(N, L, 'MULTIPLY_ADD', glow(kd, 3.0, (-1200, y - 150)), 0.6, (-350, y))
        L.new(ks, ks2.node.inputs[2])
        ks3 = _math(N, L, 'MULTIPLY_ADD', glow(kd, 14.0, (-1200, y - 300)), 0.035, (-200, y))
        L.new(ks2, ks3.node.inputs[2])
        rgb = _n(N, 'ShaderNodeRGB', (-350, y - 300))
        rgb.outputs[0].default_value = (1.0, 0.9, 0.76, 1.0)
        kc = _scale(rgb.outputs[0], ks3, (-50, y))
        glowc = add(glowc, kc, (100, y))
        y -= 600
    # Nebula: wispy noise in two hues, masked into a few broad clouds.
    nb = _n(N, 'ShaderNodeTexNoise', (-1200, y), Scale=1.7, Detail=12.0, Roughness=0.62, Distortion=0.6)
    L.new(Dn, nb.inputs['Vector'])
    nbr = _ramp(N, (-1000, y), [(0.42, (0, 0, 0)), (0.56, (0.10, 0.22, 0.42)), (0.66, (0.30, 0.12, 0.45)),
                                (0.78, (0.65, 0.35, 0.7))])
    L.new(nb.outputs['Fac'], nbr.inputs['Fac'])
    nm = _n(N, 'ShaderNodeTexNoise', (-1200, y - 250), Scale=0.6, Detail=2.0)
    L.new(Dn, nm.inputs['Vector'])
    nmr = _ramp(N, (-1000, y - 250), [(0.32, (0.08, 0.08, 0.08)), (0.68, (1, 1, 1))])
    L.new(nm.outputs['Fac'], nmr.inputs['Fac'])
    neb = _mixrgb(N, L, 'MULTIPLY', 1.0, nbr.outputs['Color'], nmr.outputs['Color'], (-800, y))
    neb = _scale(neb, 0.09 * nebula, (-650, y))
    # A very faint colour field over the whole sky (deep blue to violet), so even a tight close-up has a
    # soft, coloured backdrop rather than flat black.
    bf = _n(N, 'ShaderNodeTexNoise', (-1200, y - 750), Scale=0.9, Detail=3.0, Roughness=0.5)
    L.new(Dn, bf.inputs['Vector'])
    bfr = _ramp(N, (-1000, y - 750), [(0.3, (0.0006, 0.001, 0.0025)), (0.55, (0.002, 0.0035, 0.008)),
                                      (0.75, (0.006, 0.003, 0.01))])
    L.new(bf.outputs['Fac'], bfr.inputs['Fac'])
    neb = add(neb, _scale(bfr.outputs['Color'], nebula, (-650, y - 750)), (-500, y - 300))
    # Dark dust lanes over the nebula and clusters (absorption, by multiplying).
    ln = _n(N, 'ShaderNodeTexNoise', (-1200, y - 500), Scale=3.0, Detail=8.0, Roughness=0.6)
    L.new(Dn, ln.inputs['Vector'])
    lnr = _ramp(N, (-1000, y - 500), [(0.38, (0.25, 0.25, 0.25)), (0.6, (1, 1, 1))])
    L.new(ln.outputs['Fac'], lnr.inputs['Fac'])
    diffuse_glow = add(neb, glowc, (300, y))
    lane = _mixrgb(N, L, 'MULTIPLY', 1.0, diffuse_glow, lnr.outputs['Color'], (450, y))
    stars_cam = add(stars_all, camera_extra, (300, 600))
    stars_cam = _mixrgb(N, L, 'MULTIPLY', 1.0, stars_cam, lnr.outputs['Color'], (450, 600))
    cam_col = add(lane, stars_cam, (700, 300))
    # Ray split: camera sees everything; glossy sees the glows; diffuse sees a dim cool ambient.
    lp = _n(N, 'ShaderNodeLightPath', (700, -200))
    amb = _n(N, 'ShaderNodeRGB', (700, -500))
    amb.outputs[0].default_value = (0.010, 0.013, 0.022, 1.0)
    g_or_d = _mixrgb(N, L, 'MIX', lp.outputs['Is Glossy Ray'], amb.outputs[0], lane, (1000, -300))
    final = _mixrgb(N, L, 'MIX', lp.outputs['Is Camera Ray'], g_or_d, cam_col, (1300, 0))
    bg = _n(N, 'ShaderNodeBackground', (1700, 0), Strength=1.0)
    L.new(final, bg.inputs['Color'])
    L.new(bg.outputs[0], out.inputs['Surface'])
    return w


# ----------------------------------------------------------------------------------------------------------
# public

def build_arena(scene, key_azimuth=KEY_AZ, key_elevation=KEY_EL, seed=7, debris_on=True, motes=True,
                pebbles=True):
    """Build the whole setting in a collection 'Arena': the slab (top at z=0), pebbles and grit, drifting
    rocks, dust motes, and the space backdrop (world). Returns a dict of the main objects."""
    col = _collection(scene, ARENA)
    mat = rock_material()
    me = slab_mesh(scene, seed)
    me.materials.append(mat)
    slab = _obj('Arena_Slab', me, col)
    _build_bvh(slab)
    out = {'slab': slab, 'collection': col}
    if pebbles:
        out['pebbles'], out['grit'] = scatter_pebbles(scene, col, mat, seed + 4)
    if debris_on:
        out['debris'] = debris(scene, col, mat, seed + 14)
    if motes:
        out['motes'] = dust_motes(scene, col, seed + 2)
    out['world'] = space_backdrop(scene, _dir(key_azimuth, key_elevation))
    return out


def _sun(scene, col, name, d, strength, color, angle_deg):
    l = bpy.data.lights.get(name) or bpy.data.lights.new(name, 'SUN')
    l.energy = strength
    l.color = color
    l.angle = math.radians(angle_deg)
    o = bpy.data.objects.get(name) or _obj(name, l, col)
    o.rotation_euler = Vector(d).to_track_quat('Z', 'Y').to_euler()
    o.location = Vector(d) * 30.0
    return o


def arena_lights(scene, key_azimuth=KEY_AZ, key_elevation=KEY_EL, key_strength=9.0, rim_strength=4.0,
                 fill_strength=0.45, haze=0.0):
    """Light the arena: a hard warm KEY (a Sun, ~0.5 deg: crisp shadows) from the nearby star, a cool
    blue-violet RIM from the nebula side behind, a dim soft cool FILL from the front. haze > 0 adds a thin
    volumetric haze around the arena (density in 1/units, try 0.004-0.01; slower to render)."""
    col = _collection(scene, ARENA)
    key = _sun(scene, col, 'Arena_Key', _dir(key_azimuth, key_elevation), key_strength, (1.0, 0.88, 0.74), 0.5)
    rim = _sun(scene, col, 'Arena_Rim', _dir(RIM_AZ, RIM_EL), rim_strength, (0.5, 0.62, 1.0), 2.5)
    fill = _sun(scene, col, 'Arena_Fill', _dir(key_azimuth + 150.0, 12.0), fill_strength, (0.62, 0.72, 1.0), 45.0)
    for o in (key, rim, fill):
        o.data.cycles.max_bounces = 8 if hasattr(o.data, 'cycles') else 0
    out = {'key': key, 'rim': rim, 'fill': fill}
    if haze > 0:
        out['haze'] = haze_volume(scene, col, haze)
    return out


def haze_volume(scene, col, density=0.006, size=(70, 70, 30)):
    """A thin, forward-scattering haze box around the arena (light shafts, depth)."""
    me = bpy.data.meshes.get('Arena_Haze')
    if me is None:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
        me = bpy.data.meshes.new('Arena_Haze')
        bm.to_mesh(me)
        bm.free()
    o = bpy.data.objects.get('Arena_Haze') or _obj('Arena_Haze', me, col)
    o.location = (0, 0, 4)
    m = bpy.data.materials.get('Arena_Haze') or bpy.data.materials.new('Arena_Haze')
    nt, N, L = _nodes(m)
    out = _n(N, 'ShaderNodeOutputMaterial', (400, 0))
    v = _n(N, 'ShaderNodeVolumePrincipled', (0, 0))
    v.inputs['Color'].default_value = (0.75, 0.75, 0.8, 1)
    v.inputs['Density'].default_value = density
    v.inputs['Anisotropy'].default_value = 0.55
    L.new(v.outputs[0], out.inputs['Volume'])
    if not me.materials:
        me.materials.append(m)
    o.visible_shadow = False
    return o


def set_key(scene, azimuth, elevation, frame=None):
    """Move the key light (a per-shot cheat). With frame, keys the change there (constant until next key)."""
    key = bpy.data.objects.get('Arena_Key')
    if key is None:
        return None
    d = _dir(azimuth, elevation)
    key.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    key.location = d * 30.0
    if frame is not None:
        key.keyframe_insert('rotation_euler', frame=frame)
    return key

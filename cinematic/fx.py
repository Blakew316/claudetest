"""Visual effects kit for the Iron Man vs Thanos cinematic (Cycles, Blender 4.2+).

Repulsor charge and shots, the Power Stone and its blast, impacts (flash, sparks, debris, shock ring), boot and
palm thrusters, landing dust and ground cracks.

Everything is emission shaders, lights and keyframed geometry. Sparks, arcs and anything else that changes shape
every frame is stored as one mesh holding every frame's geometry, each vertex tagged with its frame, and a tiny
geometry-nodes group shows only the current frame's piece: no simulation caches to bake, the same result at any
frame on any machine. Times are frames at 24 fps (FPS); positions are world units (1 unit ~ 0.5 m, Z up, ground at
GROUND_Z). Effects that ride a character are parented to its bones, so they follow whatever animation it plays.
Randomness is seeded from each call's arguments: the same call always builds the same effect.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix, Quaternion

FPS = 24.0
UNIT_M = 0.5                 # metres per world unit
G = 9.81 / UNIT_M            # gravity, units/s^2
GROUND_Z = 0.0
TRAIL = 1.0                  # frames of travel a spark streak shows (a 180-degree shutter, doubled for the bloom of a film lens)

PALETTE = {
    # Iron Man: white-hot cores in a pale cyan-blue sheath.
    'repulsor': {'core': (1.0, 0.97, 0.92), 'sheath': (0.22, 0.58, 1.0), 'light': (0.62, 0.82, 1.0),
                 'ring': (0.42, 0.72, 1.0)},
    # Power Stone: deep violet with a hot magenta-white heart.
    'stone': {'core': (1.0, 0.70, 1.0), 'sheath': (0.50, 0.04, 1.0), 'light': (0.60, 0.16, 1.0),
              'ring': (0.62, 0.12, 1.0)},
}
# Black-body-ish colours of cooling metal, by heat 0..1.
HEAT_RAMP = [(0.0, (0.16, 0.006, 0.0)), (0.2, (0.75, 0.07, 0.005)), (0.45, (1.0, 0.28, 0.03)),
             (0.72, (1.0, 0.58, 0.16)), (1.0, (1.0, 0.88, 0.62))]
DUST_COLOR = (0.40, 0.29, 0.21)   # Titan's ochre dust
ROCK_COLOR = (0.085, 0.065, 0.055)


# ---------------------------------------------------------------------------------------------- small helpers

def _seed(*vals):
    """A stable seed from numbers (Python's own hash of strings is randomised per run, so it is not used)."""
    s = 2166136261
    for a in vals:
        for v in (a if hasattr(a, '__len__') else (a,)):
            s = (s ^ (int(round(float(v) * 1000)) & 0xffffffff)) * 16777619 % (2 ** 32)
    return s


def _rng(*vals):
    return random.Random(_seed(*vals))


def _clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def _smooth(x):
    x = _clamp(x)
    return x * x * (3 - 2 * x)


def _coll(scene, name):
    """A new sub-collection of 'FX' for one effect."""
    root = bpy.data.collections.get('FX')
    if root is None:
        root = bpy.data.collections.new('FX')
    if root.name not in scene.collection.children:
        scene.collection.children.link(root)
    c = bpy.data.collections.new('FX_' + name)
    root.children.link(c)
    return c


def _obj(coll, name, data=None):
    o = bpy.data.objects.new('FX_' + name, data)
    coll.objects.link(o)
    return o


def _glowy(o, blur=True):
    """Emitters light nothing by themselves (explicit lights do that, without noise), cast no shadows, and still
    show in reflections on the armour."""
    o.visible_shadow = False
    o.visible_diffuse = False
    o.visible_volume_scatter = False
    try:
        o.cycles.use_motion_blur = blur
    except AttributeError:
        pass


def _fcurves(idb):
    """All F-curves of an ID's action (layered actions in 4.4+, plain ones before)."""
    ad = idb.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    if hasattr(act, 'layers') and len(act.layers):
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    if getattr(ad, 'action_slot', None) is None or cb.slot == ad.action_slot:
                        out += list(cb.fcurves)
        return out
    return list(getattr(act, 'fcurves', []))


def _linear(*ids):
    """Linear interpolation on every key of these IDs (booleans stay constant)."""
    for idb in ids:
        for fc in _fcurves(idb):
            for kp in fc.keyframe_points:
                if kp.interpolation != 'CONSTANT':
                    kp.interpolation = 'LINEAR'


def _kp(o, prop, frame, value):
    """Key a custom property (read by the FX shaders through an Object attribute)."""
    o[prop] = float(value)
    o.keyframe_insert('["%s"]' % prop, frame=frame)


def _show(o, f_on, f_off=None):
    """Visible (render and viewport) only from f_on to f_off inclusive; forever after f_on when f_off is None."""
    keys = [(f_on - 1, True), (f_on, False)]
    if f_off is not None:
        keys.append((f_off + 1, True))
    for f, hide in keys:
        o.hide_render = hide
        o.hide_viewport = hide
        o.keyframe_insert('hide_render', frame=f)
        o.keyframe_insert('hide_viewport', frame=f)


def _at_frame(scene, frame):
    """Context manager-ish: evaluate the scene at a frame (returns the frame to restore)."""
    f0 = scene.frame_current
    if frame != f0:
        scene.frame_set(int(frame))
    return f0


def _restore(scene, f0):
    if scene.frame_current != f0:
        scene.frame_set(f0)


def _orth(d):
    """Two unit vectors perpendicular to d and to each other."""
    d = Vector(d).normalized()
    u = d.orthogonal().normalized()
    return u, d.cross(u)


def _cone_dir(rng, n, max_ang):
    """A random unit vector within max_ang of n (uniform over the spherical cap)."""
    n = Vector(n).normalized()
    ct = 1 - rng.random() * (1 - math.cos(max_ang))
    st = math.sqrt(max(0.0, 1 - ct * ct))
    ph = rng.random() * 2 * math.pi
    u, w = _orth(n)
    return (n * ct + u * st * math.cos(ph) + w * st * math.sin(ph)).normalized()


def _track(d, up=Vector((0, 0, 1))):
    """Rotation matrix whose +Z points along d."""
    d = Vector(d).normalized()
    return d.to_track_quat('Z', 'X' if abs(d.z) > 0.95 else 'Y').to_matrix()


# ----------------------------------------------------------------------------------------------- mesh builders

def _mesh(name, verts, faces, attrs=None, smooth=True):
    me = bpy.data.meshes.new('FX_' + name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    for k, vals in (attrs or {}).items():
        a = me.attributes.new(k, 'FLOAT', 'POINT')
        a.data.foreach_set('value', [float(x) for x in vals])
    if smooth and len(me.polygons):
        try:
            me.shade_smooth()
        except AttributeError:
            me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.update()
    return me


def _lathe(profile, seg=16, axis='Z'):
    """Surface of revolution: profile is [(h, r, v), ...]; returns verts, faces and the 'v' value per vertex."""
    verts, faces, vs = [], [], []
    for h, r, v in profile:
        for k in range(seg):
            a = 2 * math.pi * k / seg
            x, y = r * math.cos(a), r * math.sin(a)
            verts.append((x, h, y) if axis == 'Y' else (x, y, h))
            vs.append(v)
    for i in range(len(profile) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((i * seg + k, i * seg + k2, (i + 1) * seg + k2, (i + 1) * seg + k))
    return verts, faces, vs


def _sphere(r=1.0, seg=16, rings=10):
    prof = [(-r * math.cos(math.pi * i / rings), max(1e-4, r * math.sin(math.pi * i / rings)), i / rings)
            for i in range(rings + 1)]
    return _lathe(prof, seg)


def _annulus(r_in, r_out, seg=64, rings=4):
    """Flat ring in XY; 'v' runs 0 at the inner edge to 1 at the outer edge."""
    prof = [(0.0, r_in + (r_out - r_in) * i / rings, i / rings) for i in range(rings + 1)]
    return _lathe(prof, seg)


def _rock_mesh(i):
    """One of a few shared, faceted rock/shard shapes (deterministic), about 1 unit across."""
    name = 'FX_rock_%d' % i
    me = bpy.data.meshes.get(name)
    if me:
        return me
    rng = _rng(77, i)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.5)
    sq = Vector((1.0, 0.55 + 0.4 * rng.random(), 0.3 + 0.35 * rng.random()))
    for v in bm.verts:
        v.co = Vector((v.co.x * sq.x, v.co.y * sq.y, v.co.z * sq.z)) * (0.75 + 0.5 * rng.random())
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


class _Table:
    """Geometry for every frame of an effect in one mesh, each vertex tagged with its frame index 'fi'."""

    def __init__(self, attrs=()):
        self.v, self.f, self.fi = [], [], []
        self.a = {k: [] for k in attrs}
        self.cur = 0

    def add(self, verts, faces, **vals):
        base = len(self.v)
        self.v += verts
        self.f += [tuple(i + base for i in fc) for fc in faces]
        self.fi += [self.cur] * len(verts)
        for k, lst in self.a.items():
            x = vals.get(k, 0.0)
            lst += list(x) if hasattr(x, '__len__') else [x] * len(verts)

    def prism(self, a, b, ra, rb, sides=3, **vals_ab):
        """A thin tapered prism from a to b; each attribute given as (value at a, value at b)."""
        d = b - a
        if d.length < 1e-6:
            d = Vector((0, 0, 1e-4))
        u, w = _orth(d)
        verts = []
        for p, r in ((a, ra), (b, rb)):
            for k in range(sides):
                ang = 2 * math.pi * k / sides
                verts.append(p + (u * math.cos(ang) + w * math.sin(ang)) * r)
        faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
        vals = {k: [v[0]] * sides + [v[1]] * sides for k, v in vals_ab.items()}
        self.add(verts, faces, **vals)

    def polyline(self, pts, r0, r1, sides=3, **vals_ab):
        """Prisms along a polyline, the radius going from r0 to r1."""
        n = len(pts) - 1
        for i in range(n):
            s0, s1 = i / n, (i + 1) / n
            vv = {k: (v[0] + (v[1] - v[0]) * s0, v[0] + (v[1] - v[0]) * s1) for k, v in vals_ab.items()}
            self.prism(pts[i], pts[i + 1], r0 + (r1 - r0) * s0, r0 + (r1 - r0) * s1, sides, **vv)

    def build(self, coll, name, f0, mat):
        """The table object: shows, at frame f, the geometry added under index f - f0."""
        attrs = dict(self.a)
        attrs['fi'] = [i + f0 for i in self.fi]       # absolute frame numbers
        me = _mesh(name, self.v, self.f, attrs)
        me.materials.append(mat)
        o = _obj(coll, name, me)
        mod = o.modifiers.new('FX_frames', 'NODES')
        mod.node_group = _table_group()
        o['fx_k'] = 1.0
        o['fx_w'] = 0.0
        _glowy(o, blur=False)
        _show(o, f0, f0 + max(self.fi or [0]))
        return o


def _sock_by(sockets, name, kind=None):
    for s in sockets:
        if s.name == name and getattr(s, 'enabled', True) and (kind is None or s.type == kind):
            return s
    for s in sockets:
        if s.name == name and (kind is None or s.type == kind):
            return s
    raise KeyError(name)


def _table_group():
    """Geometry nodes: delete every vertex whose 'fi' (a frame number) is not the scene's current frame."""
    ng = bpy.data.node_groups.get('FX_FrameTable')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('FX_FrameTable', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N, L = ng.nodes, ng.links
    gi, go = N.new('NodeGroupInput'), N.new('NodeGroupOutput')
    st = N.new('GeometryNodeInputSceneTime')
    na = N.new('GeometryNodeInputNamedAttribute')
    na.data_type = 'FLOAT'
    na.inputs['Name'].default_value = 'fi'
    cmp = N.new('FunctionNodeCompare')
    cmp.data_type = 'FLOAT'
    cmp.operation = 'NOT_EQUAL'
    L.new(_sock_by(na.outputs, 'Attribute', 'VALUE'), _sock_by(cmp.inputs, 'A', 'VALUE'))
    L.new(_sock_by(st.outputs, 'Frame'), _sock_by(cmp.inputs, 'B', 'VALUE'))
    _sock_by(cmp.inputs, 'Epsilon').default_value = 0.5
    dl = N.new('GeometryNodeDeleteGeometry')
    dl.domain = 'POINT'
    L.new(gi.outputs[0], dl.inputs['Geometry'])
    L.new(cmp.outputs['Result'], dl.inputs['Selection'])
    L.new(dl.outputs[0], go.inputs[0])
    return ng


# ------------------------------------------------------------------------------------------------- materials

def _new_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    try:
        m.cycles.emission_sampling = 'NONE'   # FX are lit by explicit lights; keep emitters out of the light tree
    except AttributeError:
        pass
    return m, nt


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


def _attr(nt, name, kind='OBJECT'):
    a = nt.nodes.new('ShaderNodeAttribute')
    a.attribute_type = kind
    a.attribute_name = name
    return a.outputs['Fac']


def _mix_rgb(nt, fac, a, b):
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    for i, v in ((0, fac), (6, a), (7, b)):
        if isinstance(v, (int, float)):
            mx.inputs[i].default_value = v
        elif isinstance(v, tuple):
            mx.inputs[i].default_value = (*v[:3], 1.0)
        else:
            nt.links.new(v, mx.inputs[i])
    return mx.outputs[2]


def _additive(nt, color, strength):
    """Additive glow: the emission adds onto whatever is behind it."""
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    add = nt.nodes.new('ShaderNodeAddShader')
    for v, sock in ((color, em.inputs['Color']), (strength, em.inputs['Strength'])):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, tuple):
            sock.default_value = (*v[:3], 1.0)
        else:
            nt.links.new(v, sock)
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs['Surface'])
    return em


def _facing(nt):
    """1 where the surface faces the camera, 0 at its silhouette."""
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dp = nt.nodes.new('ShaderNodeVectorMath')
    dp.operation = 'DOT_PRODUCT'
    nt.links.new(geo.outputs['Normal'], dp.inputs[0])
    nt.links.new(geo.outputs['Incoming'], dp.inputs[1])
    return _math(nt, 'ABSOLUTE', _sock_by(dp.outputs, 'Value'))


def _glow_mat(pal, base, core_pow, edge_pow, along=None, tag='', breakup=0.0, flow=0.0):
    """Additive energy shader. Colour runs from the palette's sheath (silhouette) to its core (facing the camera);
    strength = base * fx_k * facing^edge_pow (* along-attribute profile). Object props: fx_k intensity, fx_w
    extra whiteness (0..1). along: name of a vertex attribute multiplied in (e.g. 'v')."""
    name = 'FX_glow_%s_%g_%g_%g_%s%s_%g_%g' % (pal, base, core_pow, edge_pow, along or '', tag, breakup, flow)
    m = bpy.data.materials.get(name)
    if m:
        return m
    P = PALETTE[pal]
    m, nt = _new_mat(name)
    c = _facing(nt)
    cp = _math(nt, 'POWER', c, core_pow)
    w = _math(nt, 'ADD', cp, _attr(nt, 'fx_w'), clamp=True)
    col = _mix_rgb(nt, w, P['sheath'], P['core'])
    s = _math(nt, 'MULTIPLY', _math(nt, 'POWER', c, edge_pow), _attr(nt, 'fx_k'))
    if along:
        s = _math(nt, 'MULTIPLY', s, _attr(nt, along, 'GEOMETRY'))
    if breakup:
        # Patchy, torn-up energy: object-space noise (re-seeded per object by fx_t) gates the glow.
        tc = nt.nodes.new('ShaderNodeTexCoord')
        nz = nt.nodes.new('ShaderNodeTexNoise')
        nz.noise_dimensions = '4D'
        nz.inputs['Scale'].default_value = breakup
        nz.inputs['Detail'].default_value = 4.0
        nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
        nt.links.new(_attr(nt, 'fx_t'), nz.inputs['W'])
        gate = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', nz.outputs['Fac'], 0.38), 3.2, clamp=True)
        s = _math(nt, 'MULTIPLY', s, _math(nt, 'POWER', gate, 1.5))
    if flow:
        # Energy streaming down a beam: noise stretched along it (object Y is 0..1 over fx_len units) and
        # scrolled outward with fx_t, tearing the sheath into roiling filaments.
        tc = nt.nodes.new('ShaderNodeTexCoord')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(tc.outputs['Object'], sep.inputs[0])
        cmb = nt.nodes.new('ShaderNodeCombineXYZ')
        nt.links.new(_math(nt, 'MULTIPLY', sep.outputs[0], 2.2), cmb.inputs[0])
        yy = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', sep.outputs[1], _attr(nt, 'fx_len')), 1.1)
        nt.links.new(_math(nt, 'SUBTRACT', yy, _math(nt, 'MULTIPLY', _attr(nt, 'fx_t'), 1.6)), cmb.inputs[1])
        nt.links.new(_math(nt, 'MULTIPLY', sep.outputs[2], 2.2), cmb.inputs[2])
        nz = nt.nodes.new('ShaderNodeTexNoise')
        nz.noise_dimensions = '4D'
        nz.inputs['Scale'].default_value = 1.6
        nz.inputs['Detail'].default_value = 6.0
        nz.inputs['Roughness'].default_value = 0.6
        nt.links.new(cmb.outputs[0], nz.inputs['Vector'])
        nt.links.new(_math(nt, 'MULTIPLY', _attr(nt, 'fx_t'), 0.5), nz.inputs['W'])
        gate = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', nz.outputs['Fac'], 0.32), 2.6, clamp=True)
        g = _math(nt, 'ADD', 1.0 - flow, _math(nt, 'MULTIPLY', _math(nt, 'POWER', gate, 1.6), 1.7 * flow))
        s = _math(nt, 'MULTIPLY', s, g)
    s = _math(nt, 'MULTIPLY', s, base)
    _additive(nt, col, s)
    return m


def _spark_mat():
    """Hot metal sparks: colour and brightness from the per-vertex 'heat' (1 white-hot ... 0 dark red) and
    'fade' (head 1, tail lower); palette sparks ('tint' > 0) blend toward the vertex's tint colour."""
    m = bpy.data.materials.get('FX_spark')
    if m:
        return m
    m, nt = _new_mat('FX_spark')
    heat = _attr(nt, 'heat', 'GEOMETRY')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = HEAT_RAMP[0][0], (*HEAT_RAMP[0][1], 1)
    els[1].position, els[1].color = HEAT_RAMP[-1][0], (*HEAT_RAMP[-1][1], 1)
    for pos, col in HEAT_RAMP[1:-1]:
        e = els.new(pos)
        e.color = (*col, 1)
    nt.links.new(heat, ramp.inputs['Fac'])
    tint_col = nt.nodes.new('ShaderNodeCombineXYZ')
    for i, nm in enumerate(('tr', 'tg', 'tb')):
        nt.links.new(_attr(nt, nm, 'GEOMETRY'), tint_col.inputs[i])
    col = _mix_rgb(nt, _attr(nt, 'tint', 'GEOMETRY'), ramp.outputs['Color'], tint_col.outputs[0])
    s = _math(nt, 'POWER', heat, 1.6)
    s = _math(nt, 'MULTIPLY', s, _attr(nt, 'fade', 'GEOMETRY'))
    s = _math(nt, 'MULTIPLY', s, _attr(nt, 'fx_k'))
    s = _math(nt, 'MULTIPLY', s, 90.0)
    _additive(nt, col, s)
    return m


def _rock_mat():
    """Dark rock / armour fragments, lit by the scene; fx_heat (object prop) makes them glow as they cool."""
    m = bpy.data.materials.get('FX_rock')
    if m:
        return m
    m = bpy.data.materials.new('FX_rock')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 18.0
    col = _mix_rgb(nt, noise.outputs['Fac'], tuple(x * 0.55 for x in ROCK_COLOR), tuple(x * 1.8 for x in ROCK_COLOR))
    nt.links.new(col, b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.78
    b.inputs['Metallic'].default_value = 0.15
    heat = _attr(nt, 'fx_heat')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*HEAT_RAMP[1][1], 1)
    ramp.color_ramp.elements[1].color = (*HEAT_RAMP[3][1], 1)
    nt.links.new(heat, ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Emission Color'])
    nt.links.new(_math(nt, 'MULTIPLY', _math(nt, 'POWER', heat, 2.0), 30.0), b.inputs['Emission Strength'])
    nt.links.new(b.outputs[0], out.inputs['Surface'])
    return m


# ------------------------------------------------------------------------------------------ bone attachments

def _skinned(arm):
    return [o for o in bpy.data.objects if o.type == 'MESH'
            and any(md.type == 'ARMATURE' and md.object == arm for md in o.modifiers)]


def _points(objs, center, radius):
    """World positions of evaluated mesh vertices within radius of center (numpy array, n x 3)."""
    dg = bpy.context.evaluated_depsgraph_get()
    c = np.array(center)
    out = [np.zeros((0, 3))]
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        M = np.array(o.matrix_world)
        w = co @ M[:3, :3].T + M[:3, 3]
        out.append(w[np.linalg.norm(w - c, axis=1) < radius])
        ev.to_mesh_clear()
    return np.concatenate(out)


def _bone_tail_matrix(arm, bone):
    pb = arm.pose.bones[bone]
    return arm.matrix_world @ pb.matrix @ Matrix.Translation((0, pb.bone.length, 0))


def _socket(coll, arm, bone, world, name):
    """An empty parented to the bone so that, in the current pose, it sits at the world matrix `world` (unit
    scale) - and from then on rides the bone."""
    e = _obj(coll, name)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = 0.15
    e.parent = arm
    e.parent_type = 'BONE'
    e.parent_bone = bone
    e.matrix_parent_inverse = Matrix.Identity(4)
    e.matrix_basis = _bone_tail_matrix(arm, bone).inverted() @ world
    bpy.context.view_layer.update()
    return e


def _frame_matrix(origin, z_axis, y_hint):
    z = Vector(z_axis).normalized()
    y = Vector(y_hint) - z * Vector(y_hint).dot(z)
    if y.length < 1e-5:
        y = z.orthogonal()
    y.normalize()
    x = y.cross(z)
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = origin
    return M


_FRAMES = {}


def _palm_local(arm, bone):
    """The palm centre and normal in the hand bone's own space (cached). Iron Man's palm repulsor is the glowing
    'Light' geometry nearest the hand: its centre, and the side of it facing away from the hand."""
    key = (arm.name, bone, 'palm')
    if key in _FRAMES:
        return _FRAMES[key]
    pb = arm.pose.bones[bone]
    M = arm.matrix_world @ pb.matrix
    Mi = M.inverted()
    tail = arm.matrix_world @ pb.tail
    side = -1.0 if bone.rstrip('.0123456789').endswith(('R', 'r', '_R')) or '_R_' in bone else 1.0
    meshes = _skinned(arm)
    lights = [o for o in meshes if 'light' in o.name.lower()]
    scale = (arm.matrix_world.to_scale()[0])
    L = _points(lights, tail, 0.2) if lights else np.zeros((0, 3))
    if len(L) > 12:
        c = L.mean(axis=0)
        _, _, vh = np.linalg.svd(L - c)
        n = vh[2]
        A = _points(meshes, Vector(c), 0.16)
        sd = (A - c) @ n
        lat = np.linalg.norm((A - c) - np.outer(sd, n), axis=1)
        if np.median(sd[lat < 0.05]) > 0:   # most of the hand must lie behind the palm
            n = -n
        cl = Mi @ Vector(c)
        nl = (Mi.to_3x3() @ Vector(n)).normalized()
    else:   # no lens geometry: the middle of the hand, out along the bone's X
        cl = Vector((0, pb.bone.length * 1.4, 0))
        nl = Vector((side, 0, 0))
    _FRAMES[key] = (cl, nl)
    return cl, nl


def _sole_local(arm, bone):
    """The boot sole centre and the jet direction (straight down when he stands in his rest pose), in the foot
    bone's space."""
    key = (arm.name, bone, 'sole')
    if key in _FRAMES:
        return _FRAMES[key]
    b = arm.data.bones[bone]
    R = arm.matrix_world @ b.matrix_local       # rest pose, world
    lowest = min(min((arm.matrix_world @ bb.head_local).z, (arm.matrix_world @ bb.tail_local).z)
                 for bb in arm.data.bones)
    mid = (arm.matrix_world @ b.head_local + arm.matrix_world @ b.tail_local) / 2
    sole = Vector((mid.x, mid.y, lowest + 0.01))
    Ri = R.inverted()
    cl = Ri @ sole
    nl = (Ri.to_3x3() @ Vector((0, 0, -1))).normalized()
    _FRAMES[key] = (cl, nl)
    return cl, nl


def _emitter(coll, arm, bone, push=0.02):
    """Socket at the palm (hands) or sole (feet): +Z out along the jet, +Y toward the fingers/toes. push moves it
    a little in front of the surface."""
    low = bone.lower()
    if 'foot' in low or 'ankle' in low:
        cl, nl = _sole_local(arm, bone)
    else:
        cl, nl = _palm_local(arm, bone)
    pb = arm.pose.bones[bone]
    M = arm.matrix_world @ pb.matrix
    S = M.to_3x3().normalized()
    origin = M @ cl + (S @ nl) * push
    z = S @ nl
    y = S @ Vector((0, 1, 0))
    return _socket(coll, arm, bone, _frame_matrix(origin, z, y), 'sock_' + bone)


def _stone_info(arm, hand_bone, color='purple'):
    """(stone mesh object or None, bone it rides, centre, radius, fist centre) for an Infinity Stone set in the
    gauntlet on hand_bone."""
    meshes = _skinned(arm)
    stones = [o for o in meshes if color in (o.data.name + o.name).lower() and 'stone' in (o.data.name + o.name).lower()]
    bone = next((c.name for c in arm.pose.bones[hand_bone].children if color in c.name.lower()), hand_bone)
    if stones:
        P = _points(stones[:1], arm.matrix_world.translation, 1e9)
        c = Vector(P.mean(axis=0))
        r = float(np.percentile(np.linalg.norm(P - np.array(c), axis=1), 90))
    else:
        c = arm.matrix_world @ arm.pose.bones[bone].head
        r = 0.035
    near = _points(meshes, c, 0.2)
    fist = Vector(near.mean(axis=0)) if len(near) else c
    return (stones[0] if stones else None), bone, c, r, fist


def _target_point(scene, target, frame):
    """World position of a target at a frame: a point, an object, or (armature, bone_name)."""
    if isinstance(target, (tuple, list)) and len(target) == 2 and isinstance(target[0], bpy.types.Object):
        arm, bone = target
        f0 = _at_frame(scene, frame)
        pb = arm.pose.bones[bone]
        p = arm.matrix_world @ ((pb.head + pb.tail) / 2)
        _restore(scene, f0)
        return p
    if isinstance(target, bpy.types.Object):
        f0 = _at_frame(scene, frame)
        p = target.matrix_world.translation.copy()
        _restore(scene, f0)
        return p
    return Vector(target)


def _surface_hit(scene, frame, origin, point, ignore=()):
    """Where the ray from origin toward point first meets a (non-FX) surface near point, and its normal; falls
    back to point itself, facing back along the ray."""
    f0 = _at_frame(scene, frame)
    dg = bpy.context.evaluated_depsgraph_get()
    d = (point - origin)
    dist = d.length
    d.normalize()
    o = origin + d * 0.05
    hit = None
    for _ in range(8):
        ok, loc, nor, _, ob, _ = scene.ray_cast(dg, o, d, distance=dist * 1.25)
        if not ok:
            break
        if ob.name.startswith('FX_') or ob in ignore or (ob.parent and ob.parent in ignore):
            o = loc + d * 0.01
            continue
        hit = (loc.copy(), nor.normalized())
        break
    _restore(scene, f0)
    if hit and (hit[0] - origin).length > dist * 0.6:
        n = hit[1] if hit[1].dot(d) < 0 else -hit[1]
        return hit[0] - d * 0.02, n
    return point - d * 0.02, -d


# --------------------------------------------------------------------------------------------------- physics

def _ballistic(p, v, t_end, drag=0.0, rest=0.3, fric=0.6, radius=0.0, dt=1.0 / (FPS * 8)):
    """Positions sampled every dt for t in [0, t_end], with gravity, air drag and bounces on the ground."""
    p, v = Vector(p), Vector(v)
    out = [p.copy()]
    g = Vector((0, 0, -G))
    n = int(t_end / dt) + 2
    floor = GROUND_Z + radius
    for _ in range(n):
        v = v + g * dt
        if drag:
            v *= math.exp(-drag * dt)
        p = p + v * dt
        if p.z < floor:
            p.z = floor
            if v.z < 0:
                v.z = -v.z * rest
                v.x *= fric
                v.y *= fric
                if v.z < 0.6:
                    v.z = 0.0
        out.append(p.copy())
    return out, dt


def _sample(path, dt, t):
    i = t / dt
    k = int(i)
    if k >= len(path) - 1:
        return path[-1]
    return path[k].lerp(path[k + 1], i - k)


def _debris(coll, rng, origin, frame, n, size, speed, normal, cone, hot=0.0, dur=2.5, tag='debris'):
    """Rock / armour chunks flung from origin: keyed every frame (location, spin), bouncing and settling on the
    ground; hot chunks glow orange and cool."""
    mat = _rock_mat()
    objs = []
    for i in range(n):
        s = size * (0.45 + 0.9 * rng.random() ** 1.5)
        d = _cone_dir(rng, normal, cone)
        v = d * speed * (0.4 + 0.9 * rng.random())
        o = _obj(coll, '%s_%d' % (tag, i), _rock_mesh(rng.randrange(8)))
        if not o.data.materials:
            o.data.materials.append(mat)
        o.scale = (s, s, s)
        start = Vector(origin) + d * 0.03
        path, dt = _ballistic(start, v, dur, drag=0.25, rest=0.25, fric=0.45, radius=s * 0.25)
        spin = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * (12 + 18 * rng.random())
        rot = Vector((rng.random() * 6.3, rng.random() * 6.3, rng.random() * 6.3))
        heat = hot * (0.6 + 0.4 * rng.random())
        last = None
        nf = int(dur * FPS)
        for k in range(nf + 1):
            t = k / FPS
            p = _sample(path, dt, t)
            if last is not None and (p - last).length < 1e-4 and k > 6:
                break
            o.location = p
            o.rotation_euler = rot
            o.keyframe_insert('location', frame=frame + k)
            o.keyframe_insert('rotation_euler', frame=frame + k)
            if hot:
                _kp(o, 'fx_heat', frame + k, heat * math.exp(-t / 0.5))
            on_ground = p.z <= GROUND_Z + s * 0.25 + 1e-3
            sp = spin * (0.15 if on_ground else 1.0)
            rot = rot + sp / FPS
            if on_ground:
                spin *= 0.6
            last = p
        if hot:
            _kp(o, 'fx_heat', frame + nf + 1, 0.0)
        else:
            o['fx_heat'] = 0.0
        _show(o, frame)
        _linear(o)
        objs.append(o)
    return objs


def _point_light(coll, name, color, radius=0.03):
    ld = bpy.data.lights.new('FX_' + name, 'POINT')
    ld.color = color
    ld.energy = 0.0
    ld.shadow_soft_size = radius
    o = _obj(coll, name, ld)
    o.visible_camera = False
    return o


def _key_light(o, frame, energy, color=None):
    o.data.energy = max(0.0, energy)
    o.data.keyframe_insert('energy', frame=frame)
    if color is not None:
        o.data.color = color
        o.data.keyframe_insert('color', frame=frame)


# ------------------------------------------------------------------------------------------- impact pieces

def _sparks(coll, rng, origin, normal, frame, n, speed, cone, tint=None, tint_frac=0.0, dur=1.6, size=1.0,
            name='sparks'):
    """Hot metal sparks: streaks along their true paths over the last TRAIL of a frame, gravity and drag bending
    them down, bouncing and skittering on the ground, cooling from white-hot through orange to dull red."""
    tab = _Table(('heat', 'fade', 'tint', 'tr', 'tg', 'tb'))
    sparks = []
    for i in range(n):
        fast = rng.random() < 0.18
        d = _cone_dir(rng, normal, cone * (0.45 if fast else 1.0))
        sp = speed * (1.6 + 1.2 * rng.random() if fast else 0.35 + 0.9 * rng.lognormvariate(0, 0.35))
        tau = 0.12 + 0.38 * rng.random() ** 1.3
        delay = rng.random() ** 2 * 1.5 / FPS
        big = rng.random() < 0.08          # a few fat molten droplets that live longer
        r = size * (0.005 + 0.006 * rng.random()) * (1.8 if big else 1.0)
        if big:
            tau *= 1.8
        path, dt = _ballistic(origin, d * sp, dur, drag=1.1 + 1.4 * rng.random(), rest=0.32, fric=0.55, radius=r)
        is_t = tint is not None and rng.random() < tint_frac
        sparks.append((path, dt, tau, delay, r, is_t))
    nf = int(dur * FPS)
    for k in range(nf + 1):
        tab.cur = k
        t = k / FPS
        for path, dt, tau, delay, r, is_t in sparks:
            age = t - delay + 0.5 / FPS
            if age < 0:
                continue
            heat = math.exp(-age / tau) * (1.0 if age > 0.04 else 1.0)
            if heat < 0.05:
                continue
            head = _sample(path, dt, age)
            tail = _sample(path, dt, max(0.0, age - TRAIL / FPS))
            if (head - tail).length < r * 3:
                tail = head - (head - tail).normalized() * r * 3 if (head - tail).length > 1e-6 else head - Vector((0, 0, r * 3))
            tc = tint if is_t else (0, 0, 0)
            tab.prism(tail, head, r * 0.35, r, 3, heat=(heat, heat), fade=(0.15, 1.0),
                      tint=(0.85 if is_t else 0.0,) * 2, tr=(tc[0],) * 2, tg=(tc[1],) * 2, tb=(tc[2],) * 2)
    return tab.build(coll, name, frame, _spark_mat())


def _flash_spikes(coll, rng, origin, normal, frame, pal, power, back=0.35):
    """The first two frames of an impact: a tight starburst of white-hot spikes, mostly out of the surface."""
    verts, faces, amp = [], [], []
    k = 28
    for i in range(k):
        d = _cone_dir(rng, normal, math.radians(85)) if rng.random() > back else _cone_dir(rng, -Vector(normal), math.radians(70))
        ln = (0.12 + 0.38 * rng.random() ** 2.5) * power ** 0.6
        w = ln * (0.02 + 0.02 * rng.random())
        u, v = _orth(d)
        base = len(verts)
        verts.append(Vector((0, 0, 0)))
        amp.append(1.0)
        for j in range(4):
            a = j * math.pi / 2
            verts.append(d * ln * 0.18 + (u * math.cos(a) + v * math.sin(a)) * w)
            amp.append(0.75)
        verts.append(d * ln)
        amp.append(0.0)
        for j in range(4):
            j2 = (j + 1) % 4
            faces.append((base, base + 1 + j, base + 1 + j2))
            faces.append((base + 1 + j, base + 5, base + 1 + j2))
    o = _obj(coll, 'flash_spikes', _mesh('flash_spikes', verts, faces, {'amp': amp}, smooth=False))
    o.data.materials.append(_glow_mat(pal, 40.0, 0.6, 0.3, along='amp'))
    o.location = origin
    _glowy(o)
    for f, s, kk, w in ((frame, 0.8, 1.0, 1.0), (frame + 1, 1.3, 0.25, 0.5), (frame + 2, 1.5, 0.0, 0.3)):
        o.scale = (s, s, s)
        o.keyframe_insert('scale', frame=f)
        _kp(o, 'fx_k', f, kk)
        _kp(o, 'fx_w', f, w)
    _show(o, frame, frame + 1)
    _linear(o)
    # A tiny white-hot core.
    vs, fs, _ = _sphere(1.0, 12, 8)
    c = _obj(coll, 'flash_core', _mesh('flash_core', vs, fs))
    c.data.materials.append(_glow_mat(pal, 60.0, 0.5, 0.8))
    c.location = origin
    _glowy(c)
    for f, s, kk in ((frame, 0.05, 1.0), (frame + 1, 0.07, 0.3), (frame + 2, 0.08, 0.0)):
        sc = s * power ** 0.5
        c.scale = (sc, sc, sc)
        c.keyframe_insert('scale', frame=f)
        _kp(c, 'fx_k', f, kk)
        _kp(c, 'fx_w', f, 1.0)
    _show(c, frame, frame + 1)
    _linear(c)
    return o, c


def _shock_ring(coll, origin, normal, frame, pal, radius, frames=5, name='shock_ring', gain=1.0):
    """A thin, translucent ring of light racing outward from the hit, its leading edge brightest, gone in about
    a fifth of a second."""
    vs, fs, v = _annulus(0.55, 1.0, 96, 8)
    amp = [x ** 4 for x in v]
    o = _obj(coll, name, _mesh(name, vs, fs, {'amp': amp}))
    o.data.materials.append(_glow_mat(pal, 7.0, 4.0, 0.0, along='amp', tag='ring', breakup=2.5))
    o.location = origin
    o.rotation_euler = _track(normal).to_euler()
    _glowy(o)
    for k in range(frames + 1):
        r = radius * (1 - math.exp(-(k + 0.7) / 1.5))
        o.scale = (r, r, r)
        o.keyframe_insert('scale', frame=frame + k)
        _kp(o, 'fx_k', frame + k, gain * (1 - k / frames) ** 2.2)
        _kp(o, 'fx_w', frame + k, 0.0)
        _kp(o, 'fx_t', frame + k, frame * 0.37 + k * 0.15)
    _show(o, frame, frame + frames - 1)
    _linear(o)
    return o


def _flash_light(coll, origin, frame, color, peak, name='flash_light', decay=(1.0, 0.42, 0.17, 0.06, 0.0)):
    """A hard, fast flash: full on the hit frame, gone within a few frames."""
    L = _point_light(coll, name, color, radius=0.04)
    L.location = origin
    _key_light(L, frame - 1, 0.0)
    for k, a in enumerate(decay):
        _key_light(L, frame + k, peak * a)
    _linear(L.data)
    return L


# ------------------------------------------------------------------------------------------------ public API

def impact(scene, location, frame, power=1.0, palette='repulsor', normal=None, debris=True, ring=True, seed=0):
    """A hit at `location` on `frame`: a hard white flash (light + white-hot starburst, two frames), a spray of
    hot metal sparks that arc down, bounce and cool, small debris, and a brief shock ring. normal: the direction
    out of the struck surface (default: up on the ground, otherwise up-ish). palette 'repulsor' or 'stone' tints
    the flash, the ring and a share of the sparks. Returns the effect's collection."""
    p = Vector(location)
    near_ground = p.z - GROUND_Z < 0.35
    n = Vector(normal).normalized() if normal is not None else Vector((0, 0, 1))
    if near_ground and normal is None:
        n = Vector((0, 0, 1))
    rng = _rng(frame, p, power, seed)
    P = PALETTE[palette]
    coll = _coll(scene, 'impact_%d' % frame)
    flash_col = tuple(0.5 * a + 0.5 for a in P['light'])
    _flash_light(coll, p + n * 0.55, frame, flash_col, 7000.0 * power)
    # A slower glow of the hot spot (orange for metal, violet for the stone).
    glow = _point_light(coll, 'hot_glow', P['light'] if palette == 'stone' else (1.0, 0.45, 0.12), 0.06)
    glow.location = p + n * 0.1
    _key_light(glow, frame, 0.0)
    _key_light(glow, frame + 1, 250.0 * power)
    _key_light(glow, frame + 10, 60.0 * power)
    _key_light(glow, frame + 24, 0.0)
    _linear(glow.data)
    _flash_spikes(coll, rng, p, n, frame, palette, power)
    # Sparks favour the surface normal but tip toward the sky a little (they are thrown, not sprayed sideways).
    sn = (n + Vector((0, 0, 0.35))).normalized() if not near_ground else n
    _sparks(coll, rng, p, sn, frame, int(190 * power ** 0.8), 9.5 * power ** 0.35, math.radians(70 if not near_ground else 62),
            tint=P['ring'] if palette == 'stone' else None, tint_frac=0.35, name='sparks')
    if debris:
        _debris(coll, rng, p, frame, int(5 + 5 * power), 0.07 * power ** 0.3, 6.0 * power ** 0.3, sn, math.radians(65),
                hot=0.8)
    if ring:
        _shock_ring(coll, p + n * 0.02, n, frame, palette, 0.75 * power ** 0.5, frames=4, gain=0.8)
    return coll


def repulsor_charge(scene, armature, hand_bone, f0, f1, hold=0):
    """Iron Man's palm repulsor powering up from f0 to f1: the lens builds from a faint cyan glow to white-hot,
    with a tight halo and pale-blue light spilling over the hand. It stays lit for `hold` frames after f1, then
    dies in two frames (a shot fired at f1 takes over). Returns the palm socket (+Z out of the palm)."""
    coll = _coll(scene, 'charge_%s_%d' % (hand_bone, f0))
    sock = _emitter(coll, armature, hand_bone, push=0.004)
    rng = _rng(f0, f1, 11)
    vs, fs, v = _lathe([(0.0, 0.034, 1.0), (0.004, 0.03, 1.0), (0.007, 0.018, 1.0), (0.008, 0.001, 1.0)], 24)
    lens = _obj(coll, 'palm_lens', _mesh('palm_lens', vs, fs))
    lens.data.materials.append(_glow_mat('repulsor', 14.0, 1.5, 0.2))
    lens.parent = sock
    _glowy(lens)
    vs, fs, _ = _sphere(1.0, 16, 10)
    halo = _obj(coll, 'palm_halo', _mesh('palm_halo', vs, fs))
    halo.data.materials.append(_glow_mat('repulsor', 3.0, 5.0, 2.5))
    halo.parent = sock
    halo.location = (0, 0, 0.02)
    _glowy(halo)
    L = _point_light(coll, 'palm_light', PALETTE['repulsor']['light'], 0.015)
    L.parent = sock
    L.location = (0, 0, 0.07)
    end = f1 + hold
    for f in range(f0, end + 3):
        t = _clamp((f - f0) / max(1, f1 - f0))
        e = t ** 2.2 if f <= end else 0.35 ** (f - end)
        fl = 1.0 + 0.1 * (rng.random() - 0.5) * (0.4 + t)
        _kp(lens, 'fx_k', f, (0.12 + 0.88 * e) * fl)
        _kp(lens, 'fx_w', f, e)
        _kp(halo, 'fx_k', f, e * fl)
        _kp(halo, 'fx_w', f, e * 0.5)
        s = 0.035 + 0.035 * e
        halo.scale = (s, s, s)
        halo.keyframe_insert('scale', frame=f)
        col = Vector(PALETTE['repulsor']['light']).lerp(Vector((0.85, 0.93, 1.0)), e)
        _key_light(L, f, 30.0 * e * fl, tuple(col))
    _key_light(L, f0 - 1, 0.0)
    for o in (lens, halo):
        _show(o, f0, end + 2)
        _linear(o)
    _linear(L.data)
    return sock


def _beam_mesh(name, radius, seg=16, rings=24, tip=0.0):
    """A unit-length tube along +Y (0..1) with rounded ends, for Stretch To beams; 'v' runs 0..1 along it."""
    prof = []
    for i in range(rings + 1):
        y = i / rings
        r = radius * math.sqrt(_clamp(y / 0.06)) * (1 - tip * y)
        prof.append((y, max(1e-4, r), y))
    vs, fs, v = _lathe(prof, seg, axis='Y')
    return _mesh(name, vs, fs, {'v': v})


def _bolt_mesh(name):
    """A repulsor bolt: a teardrop along -Z from its head at the origin, length 1 (scaled to the streak)."""
    prof = []
    for i in range(21):
        s = i / 20                       # 0 head .. 1 tail
        r = (math.sqrt(_clamp(s / 0.08)) if s < 0.08 else (1 - s) ** 1.3 / 0.92 ** 1.3)
        prof.append((-s, max(1e-4, r), 1 - s))
    vs, fs, v = _lathe(prof, 16)
    return vs, fs, v


def repulsor_shot(scene, armature, hand_bone, target, f_fire, f_hit, power=1.0, hold=None):
    """A repulsor shot: a muzzle flash and expanding rings at the palm on f_fire, a white-hot bolt in a cyan
    sheath streaking to the target (or, for power > 1.5, a sustained beam held `hold` frames), and impact(...)
    on f_hit at the first surface the shot meets. target: a point, an object, or (armature, bone_name).
    Returns (collection, hit point)."""
    coll = _coll(scene, 'shot_%s_%d' % (hand_bone, f_fire))
    rng = _rng(f_fire, f_hit, power, 23)
    P = PALETTE['repulsor']
    sock = _emitter(coll, armature, hand_bone, push=0.01)
    f_save = _at_frame(scene, f_fire)
    p0 = sock.matrix_world.translation.copy()
    _restore(scene, f_save)
    aim = _target_point(scene, target, f_hit)
    shooter = set(_skinned(armature))
    p1, n1 = _surface_hit(scene, f_hit, p0, aim, ignore=shooter)
    d = (p1 - p0).normalized()
    dist = (p1 - p0).length
    beam = power > 1.5
    hold = (int(6 + 4 * power) if hold is None else hold) if beam else 0
    # Muzzle: flash light, a short white-hot cone of spikes along the shot, and two rings racing up the line.
    _flash_light(coll, p0 + d * 0.12, f_fire, (0.8, 0.92, 1.0), 2600.0 * power ** 0.7, 'muzzle_light',
                 decay=(1.0, 0.5, 0.2, 0.0) if not beam else (1.0,) + (0.55,) * hold + (0.3, 0.1, 0.0))
    mz = _obj(coll, 'muzzle_flare', None)
    mz.location = p0
    mz.rotation_euler = _track(d).to_euler()
    vs, fs, v = _lathe([(0.0, 0.05, 1.0), (0.05, 0.075, 0.9), (0.2, 0.05, 0.5), (0.45, 0.012, 0.0)], 16)
    cone = _obj(coll, 'muzzle_cone', _mesh('muzzle_cone', vs, fs, {'v': v}))
    cone.data.materials.append(_glow_mat('repulsor', 18.0, 1.0, 0.8, along='v'))
    cone.parent = mz
    _glowy(cone)
    for f, s, k in ((f_fire, 1.0, 1.0), (f_fire + 1, 1.5, 0.45), (f_fire + 2, 1.8, 0.0)):
        s *= power ** 0.4
        cone.scale = (s, s, s * 1.3)
        cone.keyframe_insert('scale', frame=f)
        _kp(cone, 'fx_k', f, k if not beam else max(k, 0.6))
        _kp(cone, 'fx_w', f, 0.8)
    _show(cone, f_fire, f_fire + (1 if not beam else hold + 1))
    _linear(cone)
    _shock_ring(coll, p0 + d * 0.1, d, f_fire, 'repulsor', 0.3 * power ** 0.4, frames=3, name='muzzle_ring', gain=0.6)
    # The palm lens burns white for the shot.
    vs, fs, _ = _sphere(1.0, 16, 10)
    pl = _obj(coll, 'palm_burn', _mesh('palm_burn', vs, fs))
    pl.data.materials.append(_glow_mat('repulsor', 30.0, 1.0, 0.6))
    pl.parent = sock
    _glowy(pl)
    last = f_fire + 3 + hold
    for f in range(f_fire - 1, last + 1):
        k = 0.0 if f < f_fire else (1.0 if f <= f_fire + hold else 0.5 ** (f - f_fire - hold))
        s = 0.045 * (0.6 + 0.4 * k) * power ** 0.3
        pl.scale = (s, s, s * 0.5)
        pl.keyframe_insert('scale', frame=f)
        _kp(pl, 'fx_k', f, k)
        _kp(pl, 'fx_w', f, 1.0)
    _show(pl, f_fire, last)
    _linear(pl)
    if not beam:
        # The bolt: head travels p0 -> p1 between f_fire and f_hit, its streak one frame of travel long.
        span = max(1, f_hit - f_fire)
        per = dist / span
        vs, fs, v = _bolt_mesh('bolt')
        core = _obj(coll, 'bolt_core', _mesh('bolt_core', vs, fs, {'v': v}))
        core.data.materials.append(_glow_mat('repulsor', 40.0, 0.8, 0.4, along='v'))
        sheath = _obj(coll, 'bolt_sheath', _mesh('bolt_sheath', vs, fs, {'v': v}))
        sheath.data.materials.append(_glow_mat('repulsor', 7.0, 6.0, 1.8, along='v'))
        bl = _point_light(coll, 'bolt_light', P['light'], 0.05)
        for o in (core, sheath):
            o.rotation_euler = _track(d).to_euler()
            _glowy(o)
        for f in range(f_fire, f_hit):
            a = (f - f_fire + 0.75) / span
            head = p0 + d * dist * min(1.0, a)
            ln = min(max(0.7, per * 1.1), (head - p0).length + 0.05)
            for o, w in ((core, 0.035), (sheath, 0.11)):
                o.location = head
                o.scale = (w * power ** 0.5, w * power ** 0.5, ln)
                o.keyframe_insert('location', frame=f)
                o.keyframe_insert('scale', frame=f)
                _kp(o, 'fx_k', f, 1.0)
                _kp(o, 'fx_w', f, 0.0)
            bl.location = head - d * ln * 0.3
            bl.keyframe_insert('location', frame=f)
            _key_light(bl, f, 900.0 * power)
        _key_light(bl, f_fire - 1, 0.0)
        _key_light(bl, f_hit, 0.0)
        for o in (core, sheath):
            _show(o, f_fire, f_hit - 1)
            _linear(o)
        _linear(bl, bl.data)
    else:
        _beam(coll, scene, sock, p0, p1, f_fire, f_hit, hold, 'repulsor', power, rng)
    impact(scene, p1, f_hit, power, 'repulsor', normal=(n1 + Vector((0, 0, 0.25))).normalized())
    if beam:
        for j, f in enumerate(range(f_hit + 3, f_hit + hold, 3)):
            impact(scene, p1, f, power * 0.45, 'repulsor', normal=n1, debris=False, ring=False, seed=j + 1)
    return coll, p1


def _beam(coll, scene, sock, p0, p1, f_fire, f_hit, hold, pal, power, rng, arcs=False):
    """A sustained beam from the socket to p1: core, sheath and haze tubes stretched to a tip empty that races
    out from the emitter between f_fire and f_hit, held until f_hit + hold, then thinning out."""
    tip = _obj(coll, 'beam_tip', None)
    root = _obj(coll, 'beam_root', None)
    root.parent = sock
    d = (p1 - p0).normalized()
    span = max(1, f_hit - f_fire)
    for f in range(f_fire, f_hit + 1):
        a = _clamp((f - f_fire + 1) / (span + 1))
        tip.location = p0.lerp(p1, a)
        tip.keyframe_insert('location', frame=f)
    _linear(tip)
    end = f_hit + hold
    rad = (0.03, 0.10, 0.24) if pal == 'repulsor' else (0.035, 0.13, 0.30)
    turb = 0.35 if pal == 'repulsor' else 1.0
    mats = (_glow_mat(pal, 45.0, 0.7, 0.4, flow=0.25 * turb), _glow_mat(pal, 7.0, 5.0, 1.6, flow=turb),
            _glow_mat(pal, 1.6, 8.0, 2.5, flow=turb))
    tubes = []
    for nm, r, m in zip(('beam_core', 'beam_sheath', 'beam_haze'), rad, mats):
        o = _obj(coll, nm, _beam_mesh(nm, 1.0))
        o.data.materials.append(m)
        o.parent = root
        c = o.constraints.new('STRETCH_TO')
        c.target = tip
        c.rest_length = 1.0
        c.volume = 'NO_VOLUME'
        _glowy(o)
        tubes.append((o, r))
    for f in range(f_fire, end + 4):
        k = 1.0 if f <= end else 0.45 ** (f - end)
        fl = 1.0 + 0.16 * (rng.random() - 0.5) * (2.0 if pal == 'stone' else 1.0)
        for o, r in tubes:
            w = r * power ** 0.4 * fl * (0.55 + 0.45 * k)
            o.scale = (w, 1.0, w)
            o.keyframe_insert('scale', frame=f)
            _kp(o, 'fx_k', f, k * fl)
            _kp(o, 'fx_w', f, 0.0)
            _kp(o, 'fx_t', f, (f - f_fire) * 0.9)
            _kp(o, 'fx_len', f, (p1 - p0).length)
    for o, r in tubes:
        _show(o, f_fire, end + 3)
        _linear(o)
    # Light along the beam: three lamps riding the line.
    P = PALETTE[pal]
    for j, a in enumerate((0.2, 0.5, 0.8)):
        L = _point_light(coll, 'beam_light%d' % j, P['light'], 0.08)
        for f in range(f_fire, end + 4):
            k = 1.0 if f <= end else 0.45 ** (f - end)
            reach = _clamp((f - f_fire + 1) / (span + 1))
            L.location = p0.lerp(p1, a * reach)
            L.keyframe_insert('location', frame=f)
            _key_light(L, f, 800.0 * power * k * (1 if a <= reach + 1e-6 else 0))
        _key_light(L, f_fire - 1, 0.0)
        _linear(L, L.data)
    return tubes, tip, root


def _zigzag(rng, pts, rough, depth):
    """Fractal midpoint displacement of a polyline (lightning)."""
    for _ in range(depth):
        out = [pts[0]]
        for p, q in zip(pts, pts[1:]):
            dd = q - p
            u, w = _orth(dd if dd.length > 1e-6 else Vector((0, 0, 1)))
            a = rng.random() * 2 * math.pi
            out.append((p + q) / 2 + (u * math.cos(a) + w * math.sin(a)) * rng.gauss(0, rough * dd.length))
            out.append(q)
        pts = out
    return pts


def _slerp_dir(a, b, s):
    q = a.rotation_difference(b)
    return (Quaternion().slerp(q, s) @ a).normalized()


def power_stone(scene, armature, hand_bone, f0, f1, intensity=1.0):
    """The gauntlet's Power Stone awake from f0 to f1: the stone itself burns violet with a white-hot heart, a
    tight halo and a pulsing purple light wash the gauntlet, and violet arcs crackle over the fist (new arcs every
    frame or two). Returns the stone socket (an empty at the stone, +Z out of the fist)."""
    coll = _coll(scene, 'power_stone_%d' % f0)
    rng = _rng(f0, f1, 31)
    stone, bone, c, r, fist = _stone_info(armature, hand_bone)
    out = (c - fist).normalized() if (c - fist).length > 1e-4 else Vector((0, 0, 1))
    pb = armature.pose.bones[bone]
    y = (armature.matrix_world.to_3x3() @ (pb.tail - pb.head)).normalized()
    sock = _socket(coll, armature, bone, _frame_matrix(c, out, y), 'stone_sock')
    Mi = sock.matrix_world.inverted()
    fist_l = Mi @ fist
    fist_r = max(0.12, (c - fist).length * 1.15)
    P = PALETTE['stone']
    ramp = lambda f: _smooth((f - f0) / 6.0) * _smooth((f1 - f) / 6.0 + 0.0001) * intensity
    # The stone itself.
    if stone is not None:
        _stone_material(stone)
    vs, fs, _ = _sphere(1.0, 16, 10)
    halo = _obj(coll, 'stone_halo', _mesh('stone_halo', vs, fs))
    halo.data.materials.append(_glow_mat('stone', 2.2, 6.0, 3.0))
    halo.parent = sock
    _glowy(halo)
    L = _point_light(coll, 'stone_light', P['light'], 0.03)
    L.parent = sock
    L.location = (0, 0, 0.12)
    for f in range(f0, f1 + 1):
        k = ramp(f)
        pulse = 0.82 + 0.18 * math.sin((f - f0) * 0.9) + 0.12 * (rng.random() - 0.5)
        s = r * (1.2 + 0.3 * k * pulse)
        halo.scale = (s, s, s)
        halo.keyframe_insert('scale', frame=f)
        _kp(halo, 'fx_k', f, k * pulse)
        _kp(halo, 'fx_w', f, 0.0)
        _key_light(L, f, 25.0 * k * pulse)
        if stone is not None:
            _kp(stone, 'fx_stone', f, k * pulse)
    _key_light(L, f0 - 1, 0.0)
    if stone is not None:
        _kp(stone, 'fx_stone', f0 - 1, 0.0)
        _kp(stone, 'fx_stone', f1 + 1, 0.0)
        _linear(stone)
    _show(halo, f0, f1)
    _linear(halo, L.data)
    # Arcs: born at the stone, crawling over the fist, a few leaping into the air. Each is a thin white-hot
    # core over a wider violet glow, the way an arc photographs.
    tab = _Table(('amp',))
    glow = _Table(('amp',))
    arcs = []
    for f in range(f0, f1 + 1):
        k = ramp(f)
        tab.cur = glow.cur = f - f0
        keep = [a for a in arcs if a[1] > f]
        n_new = int(k * (2.0 + 3.0 * rng.random()) + rng.random() * k)
        for _ in range(n_new):
            start = Vector((0, 0, 0)) + Vector((rng.gauss(0, 0.3), rng.gauss(0, 0.3), 0)) * r
            a_dir = (start - fist_l).normalized()
            b_dir = _cone_dir(rng, a_dir, math.radians(40 + 80 * rng.random()))
            bulge = 0.04 + 0.25 * rng.random()
            n = 8
            pts = [fist_l + _slerp_dir(a_dir, b_dir, i / n) * fist_r * (1 + bulge * math.sin(math.pi * i / n) * (0.4 + 0.6 * rng.random()))
                   for i in range(n + 1)]
            pts[0] = start
            if rng.random() < 0.25:   # a stray arc leaping off into the air
                pts = pts[:n // 2 + 1] + [pts[n // 2] + _cone_dir(rng, b_dir, 0.7) * fist_r * (0.3 + 0.5 * rng.random())]
            pts = _zigzag(rng, pts, 0.22, 3)
            arcs.append((pts, f + rng.choice((1, 1, 2, 3)), 0.6 + 0.4 * rng.random()))
            keep.append(arcs[-1])
        arcs = keep
        for pts, until, amp in arcs:
            tab.polyline(pts, 0.004, 0.0016, 3, amp=(amp * k, amp * k * 0.5))
            glow.polyline(pts[::2] + ([pts[-1]] if len(pts) % 2 == 0 else []), 0.022, 0.01, 5, amp=(amp * k, amp * k * 0.4))
            # Thin side forks.
            if len(pts) > 6:
                i = len(pts) // 3
                fk = _zigzag(rng, [pts[i], pts[i] + _cone_dir(rng, (pts[i] - fist_l).normalized(), 1.0) * fist_r * 0.3], 0.3, 3)
                tab.polyline(fk, 0.0016, 0.0006, 3, amp=(amp * k * 0.6, 0.0))
    if tab.v:
        for t_, nm, m in ((tab, 'stone_arcs', _glow_mat('stone', 30.0, 3.0, 0.2, along='amp')),
                          (glow, 'stone_arc_glow', _glow_mat('stone', 2.5, 12.0, 2.0, along='amp'))):
            o = t_.build(coll, nm, f0, m)
            o.parent = sock
            o.matrix_parent_inverse = Matrix.Identity(4)
    return sock


def _stone_material(stone):
    """Give the stone mesh (its own object) a copy of its material with an added violet emission driven by the
    object's 'fx_stone' property (0 = as modelled)."""
    if 'fx_stone' not in stone:
        stone['fx_stone'] = 0.0
    for i, slot in enumerate(stone.material_slots):
        m = slot.material
        if m is None or m.name.startswith('FX_'):
            continue
        m2 = m.copy()
        m2.name = 'FX_stone_' + m.name
        nt = m2.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        src = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
        em = nt.nodes.new('ShaderNodeEmission')
        k = _attr(nt, 'fx_stone')
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        lw = nt.nodes.new('ShaderNodeLayerWeight')
        lw.inputs['Blend'].default_value = 0.35
        col = _mix_rgb(nt, lw.outputs['Facing'], (0.95, 0.5, 1.0), (0.42, 0.02, 1.0))
        nt.links.new(col, em.inputs['Color'])
        nt.links.new(_math(nt, 'MULTIPLY', k, 5.0), em.inputs['Strength'])
        add = nt.nodes.new('ShaderNodeAddShader')
        if src:
            nt.links.new(src, add.inputs[0])
        nt.links.new(em.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], out.inputs['Surface'])
        if slot.link == 'OBJECT':
            slot.material = m2
        else:
            stone.data.materials[i] = m2


def stone_blast(scene, armature, hand_bone, target, f_fire, f_hit, hold=10, power=1.0):
    """Thanos fires the Power Stone: the stone flares (from f_fire - 4), a violent violet beam with a white-hot
    core and arcs whipping around it tears out to the target (reaching it on f_hit), holds `hold` frames and
    gutters out; impacts in the stone palette hammer the target. target: a point, an object or
    (armature, bone_name). Returns (collection, hit point)."""
    coll = _coll(scene, 'stone_blast_%d' % f_fire)
    rng = _rng(f_fire, f_hit, 41)
    aim = _target_point(scene, target, f_hit)
    f_save = _at_frame(scene, f_fire)
    stone, bone, c, r, fist = _stone_info(armature, hand_bone)
    d0 = (aim - c).normalized()
    pb = armature.pose.bones[bone]
    y = (armature.matrix_world.to_3x3() @ (pb.tail - pb.head)).normalized()
    p0 = c + d0 * r * 1.2
    sock = _socket(coll, armature, bone, _frame_matrix(p0, d0, y), 'blast_sock')
    _restore(scene, f_save)
    p1, n1 = _surface_hit(scene, f_hit, p0, aim, ignore=set(_skinned(armature)))
    end = f_hit + hold
    # The stone surges for the shot.
    power_stone(scene, armature, hand_bone, f_fire - 8, end + 4, intensity=1.6)
    P = PALETTE['stone']
    vs, fs, _ = _sphere(1.0, 16, 10)
    fl = _obj(coll, 'blast_flare', _mesh('blast_flare', vs, fs))
    fl.data.materials.append(_glow_mat('stone', 16.0, 2.5, 2.2))
    fl.parent = sock
    _glowy(fl)
    for f in range(f_fire - 4, end + 5):
        if f < f_fire:
            k = ((f - f_fire + 5) / 5.0) ** 2 * 0.6
        elif f <= end:
            k = 1.0 + 0.25 * (rng.random() - 0.5)
        else:
            k = 0.45 ** (f - end)
        s = 0.035 + 0.045 * k
        fl.scale = (s, s, s)
        fl.keyframe_insert('scale', frame=f)
        _kp(fl, 'fx_k', f, k)
        _kp(fl, 'fx_w', f, 0.4 * k)
    _show(fl, f_fire - 4, end + 4)
    _linear(fl)
    _flash_light(coll, p0, f_fire, (0.8, 0.55, 1.0), 4000.0 * power, 'blast_muzzle_light',
                 decay=(1.0,) + (0.5,) * hold + (0.3, 0.1, 0.0))
    tubes, tip, root = _beam(coll, scene, sock, p0, p1, f_fire, f_hit, hold, 'stone', power * 1.3, rng)
    # Arcs whipping around the beam, in the beam's own space (x/z in world units, y along it 0..1).
    beam_len = (p1 - p0).length
    tab = _Table(('amp',))
    glow = _Table(('amp',))
    for f in range(f_fire, end + 3):
        tab.cur = glow.cur = f - f_fire
        k = 1.0 if f <= end else 0.4 ** (f - end)
        for _ in range(int(3 + 4 * rng.random())):
            y0 = rng.random() * 0.85
            y1 = min(1.0, y0 + (0.08 + 0.3 * rng.random()))
            n = 14
            ph = rng.random() * 2 * math.pi
            turns = rng.uniform(-1.5, 1.5)
            rr = (0.12 + 0.22 * rng.random()) * power ** 0.4
            pts = []
            for i in range(n + 1):
                s = i / n
                a = ph + turns * 2 * math.pi * s
                rad = rr * (0.4 + 0.6 * math.sin(math.pi * s))
                pts.append(Vector((math.cos(a) * rad, y0 + (y1 - y0) * s, math.sin(a) * rad)))
            # Zigzag in world-proportioned space (y scaled by the beam length), then back.
            wp = [Vector((p.x, p.y * beam_len, p.z)) for p in pts]
            wp = _zigzag(rng, wp, 0.16, 3)
            pts = [Vector((p.x, p.y / beam_len, p.z)) for p in wp]
            a_ = k * (0.6 + 0.4 * rng.random())
            tab.polyline(pts, 0.005, 0.0018, 3, amp=(a_, k * 0.3))
            glow.polyline(pts[::2] + ([pts[-1]] if len(pts) % 2 == 0 else []), 0.03, 0.012, 5, amp=(a_, k * 0.3))
    for t_, nm, m in ((tab, 'blast_arcs', _glow_mat('stone', 30.0, 3.0, 0.2, along='amp')),
                      (glow, 'blast_arc_glow', _glow_mat('stone', 2.5, 12.0, 2.0, along='amp'))):
        arc = t_.build(coll, nm, f_fire, m)
        arc.parent = root
        c_ = arc.constraints.new('STRETCH_TO')
        c_.target = tip
        c_.rest_length = 1.0
        c_.volume = 'NO_VOLUME'
    impact(scene, p1, f_hit, 1.6 * power, 'stone', normal=(n1 + Vector((0, 0, 0.25))).normalized())
    for j, f in enumerate(range(f_hit + 3, end, 3)):
        impact(scene, p1 + Vector((rng.gauss(0, 0.06), rng.gauss(0, 0.06), rng.gauss(0, 0.06))), f, 0.55 * power,
               'stone', normal=n1, debris=False, ring=(j % 2 == 1), seed=j + 1)
    return coll, p1


def _curve_value(curve, f, f0, f1):
    """intensity_curve: a number, a callable taking the frame, or [(frame, value), ...] (linear in between)."""
    if callable(curve):
        return float(curve(f))
    if isinstance(curve, (int, float)):
        return float(curve)
    pts = sorted(curve)
    if f <= pts[0][0]:
        return pts[0][1]
    for (a, va), (b, vb) in zip(pts, pts[1:]):
        if a <= f <= b:
            return va + (vb - va) * (f - a) / max(1e-6, b - a)
    return pts[-1][1]


def _jet_mat():
    """Thruster flame: white-hot at the nozzle and in the core, pale cyan then blue toward the tip, faint shock
    diamonds, turbulent flicker (object props fx_k intensity, fx_t time)."""
    m = bpy.data.materials.get('FX_jet')
    if m:
        return m
    m, nt = _new_mat('FX_jet')
    v = _attr(nt, 'v', 'GEOMETRY')
    c = _facing(nt)
    tex = nt.nodes.new('ShaderNodeTexCoord')
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.noise_dimensions = '4D'
    noise.inputs['Scale'].default_value = 7.0
    noise.inputs['Detail'].default_value = 3.0
    nt.links.new(tex.outputs['Object'], noise.inputs['Vector'])
    nt.links.new(_attr(nt, 'fx_t'), noise.inputs['W'])
    turb = _math(nt, 'ADD', _math(nt, 'MULTIPLY', noise.outputs['Fac'], 1.3), 0.35)
    along = _math(nt, 'POWER', _math(nt, 'SUBTRACT', 1.0, v, clamp=True), 1.6)
    diam = _math(nt, 'ADD', 0.75, _math(nt, 'MULTIPLY', _math(nt, 'COSINE', _math(nt, 'MULTIPLY', v, 40.0)), 0.25))
    s = _math(nt, 'MULTIPLY', along, _math(nt, 'POWER', c, 1.2))
    s = _math(nt, 'MULTIPLY', s, _math(nt, 'MULTIPLY', turb, diam))
    s = _math(nt, 'MULTIPLY', s, _attr(nt, 'fx_k'))
    s = _math(nt, 'MULTIPLY', s, 22.0)
    hot = _math(nt, 'MULTIPLY', _math(nt, 'POWER', c, 3.0), _math(nt, 'POWER', _math(nt, 'SUBTRACT', 1.0, v, clamp=True), 3.0))
    col = _mix_rgb(nt, _math(nt, 'ADD', hot, _attr(nt, 'fx_w'), clamp=True), (0.12, 0.42, 1.0), (0.92, 0.97, 1.0))
    _additive(nt, col, s)
    return m


def thrusters(scene, armature, bones, f0, f1, intensity_curve=1.0, length=1.0):
    """Iron Man's boot and palm jets from f0 to f1: blue-white cores with faint shock diamonds in a pale-cyan
    flame, flickering, each with a light washing the ground/suit. bones: e.g. ['DEF-footL', 'DEF-footR',
    'DEF-handL', 'DEF-handR'] (feet fire from the soles, hands from the palms). intensity_curve: a number, a
    callable f(frame) -> 0..1.5, or [(frame, value), ...]. Returns the list of jet sockets."""
    coll = _coll(scene, 'thrusters_%d' % f0)
    rng = _rng(f0, f1, len(bones), 53)
    mat = _jet_mat()
    socks = []
    for bi, bone in enumerate(bones):
        foot = 'foot' in bone.lower() or 'ankle' in bone.lower()
        sock = _emitter(coll, armature, bone, push=0.005)
        socks.append(sock)
        L0 = (0.95 if foot else 0.55) * length
        r0 = 0.055 if foot else 0.04
        layers = []
        for nm, prof in (('core', [(0.0, r0 * 0.55, 0.0), (0.06, r0 * 0.5, 0.05), (0.35, r0 * 0.28, 0.35), (0.6, 0.002, 0.6)]),
                         ('flame', [(0.0, r0, 0.0), (0.08, r0 * 1.35, 0.08), (0.3, r0 * 1.5, 0.3), (0.65, r0 * 1.0, 0.65), (1.0, 0.004, 1.0)]),
                         ('haze', [(0.0, r0 * 1.4, 0.0), (0.2, r0 * 2.6, 0.2), (0.7, r0 * 2.4, 0.7), (1.1, 0.01, 1.0)])):
            prof2 = []
            for (h0, ra, va), (h1, rb, vb) in zip(prof, prof[1:]):
                for j in range(4):
                    s = j / 4
                    prof2.append((h0 + (h1 - h0) * s, ra + (rb - ra) * s, va + (vb - va) * s))
            prof2.append(prof[-1])
            vs, fs, v = _lathe(prof2, 16)
            o = _obj(coll, 'jet_%s_%s' % (nm, bone), _mesh('jet_' + nm, vs, fs, {'v': v}))
            o.data.materials.append(mat)
            o.parent = sock
            _glowy(o, blur=True)
            layers.append((nm, o))
        L = _point_light(coll, 'jet_light_' + bone, (0.6, 0.8, 1.0), 0.05)
        L.parent = sock
        L.location = (0, 0, 0.25 if foot else 0.15)
        for f in range(f0, f1 + 1):
            k = max(0.0, _curve_value(intensity_curve, f, f0, f1))
            fl = 1.0 + 0.14 * (rng.random() - 0.5)
            for nm, o in layers:
                ln = L0 * (0.35 + 0.65 * min(k, 1.5)) * fl
                wd = 0.7 + 0.3 * min(k, 1.5)
                o.scale = (wd, wd, ln)
                o.keyframe_insert('scale', frame=f)
                gain = {'core': 1.6, 'flame': 0.55, 'haze': 0.12}[nm]
                _kp(o, 'fx_k', f, k * gain * fl)
                _kp(o, 'fx_w', f, 0.6 if nm == 'core' else 0.0)
                _kp(o, 'fx_t', f, (f - f0) * 0.45 + bi * 7.1)
            _key_light(L, f, (220.0 if foot else 120.0) * k * fl)
        _key_light(L, f0 - 1, 0.0)
        _key_light(L, f1 + 1, 0.0)
        for nm, o in layers:
            _show(o, f0, f1)
            _linear(o)
        _linear(L.data)
    return socks


def _dust_mat():
    """Volumetric dust ring, lit by the scene. Object props: fx_r ring radius, fx_w ring width, fx_h height,
    fx_d density, fx_t turbulence time (all in the domain's unit space: x,y in [-1, 1], z in [0, 1])."""
    m = bpy.data.materials.get('FX_dust')
    if m:
        return m
    m = bpy.data.materials.new('FX_dust')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    vol = nt.nodes.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (*DUST_COLOR, 1)
    vol.inputs['Anisotropy'].default_value = 0.35
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    x, y, z = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    r = _math(nt, 'SQRT', _math(nt, 'ADD', _math(nt, 'MULTIPLY', x, x), _math(nt, 'MULTIPLY', y, y)))
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.noise_dimensions = '4D'
    noise.inputs['Scale'].default_value = 3.2
    noise.inputs['Detail'].default_value = 6.0
    noise.inputs['Roughness'].default_value = 0.6
    nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    nt.links.new(_attr(nt, 'fx_t'), noise.inputs['W'])
    nz = _math(nt, 'SUBTRACT', noise.outputs['Fac'], 0.5)
    # Billows: the noise pushes the ring in and out and lifts it.
    rr = _math(nt, 'ADD', r, _math(nt, 'MULTIPLY', nz, 0.35))
    dr = _math(nt, 'DIVIDE', _math(nt, 'SUBTRACT', rr, _attr(nt, 'fx_r')), _attr(nt, 'fx_w'))
    ring = _math(nt, 'EXPONENT', _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', dr, dr), -1.0))
    zz = _math(nt, 'ADD', z, _math(nt, 'MULTIPLY', nz, -0.25))
    hz = _math(nt, 'EXPONENT', _math(nt, 'DIVIDE', _math(nt, 'MULTIPLY', zz, -1.0), _attr(nt, 'fx_h')))
    inner = _math(nt, 'MULTIPLY', _math(nt, 'LESS_THAN', rr, _attr(nt, 'fx_r')), 0.25)
    prof = _math(nt, 'MULTIPLY', _math(nt, 'ADD', ring, inner), hz)
    detail = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', noise.outputs['Fac'], 0.32), 3.0, clamp=True)
    edge = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', 1.0, r), 6.0, clamp=True)     # fade at the domain's walls
    top = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', 1.0, z), 6.0, clamp=True)
    dens = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', prof, detail), _math(nt, 'MULTIPLY', edge, top))
    dens = _math(nt, 'MULTIPLY', dens, _attr(nt, 'fx_d'))
    nt.links.new(dens, vol.inputs['Density'])
    nt.links.new(vol.outputs[0], out.inputs['Volume'])
    return m


def dust_burst(scene, location, frame, radius=2.0, density=1.0, pebbles=True, color=None):
    """A ring of dust kicked off the ground at `location` on `frame` (a hard landing, a heavy stomp, a blast on
    the ground): a low volumetric wall racing out to about `radius`, rolling and climbing as it slows, thinning
    over ~3 s, plus pebbles skittering outward. Lit by the scene's own lights. Returns the collection."""
    coll = _coll(scene, 'dust_%d' % frame)
    rng = _rng(frame, location, radius, 61)
    p = Vector((location[0], location[1], GROUND_Z))
    Rd = radius * 1.6
    Hd = radius * 0.9
    vs, fs, _ = _lathe([(0.0, 0.001, 0), (0.0, 1.0, 0), (1.0, 1.0, 0), (1.0, 0.001, 0)], 32)
    o = _obj(coll, 'dust', _mesh('dust', vs, fs, smooth=False))
    mat = _dust_mat()
    if color is not None:
        mat = mat.copy()
        mat.node_tree.nodes['Principled Volume'].inputs['Color'].default_value = (*color, 1)
    o.data.materials.append(mat)
    o.location = p
    o.scale = (Rd, Rd, Hd)
    o.visible_shadow = True
    dur = int(3.2 * FPS)
    for k in range(-1, dur + 1):
        t = max(0.0, k) / FPS
        R = (radius / Rd) * (1 - math.exp(-t / 0.22)) * (1 + 0.12 * t)
        W = (0.07 + 0.22 * (1 - math.exp(-t / 0.6))) * (radius / Rd) * 1.6
        H = 0.08 + 0.32 * (1 - math.exp(-t / 0.7))
        D = (0 if k < 0 else 1.0) * density * 14.0 * math.exp(-t / 1.0) * _smooth(t * FPS / 2.0 + 0.3)
        f = frame + k
        _kp(o, 'fx_r', f, max(0.02, R))
        _kp(o, 'fx_w', f, W)
        _kp(o, 'fx_h', f, H)
        _kp(o, 'fx_d', f, D)
        _kp(o, 'fx_t', f, t * 0.6)
    _show(o, frame, frame + dur)
    _linear(o)
    if pebbles:
        n = int(10 + 8 * radius)
        for i in range(n):
            pass
        _debris(coll, rng, p + Vector((0, 0, 0.03)), frame, n, 0.045, 4.0 * radius ** 0.5, Vector((0, 0, 1)),
                math.radians(80), hot=0.0, dur=2.0, tag='pebble')
    return coll


def _crack_paths(rng, radius):
    """Radial impact fractures: main cracks out from the centre, forking, plus a few partial rings."""
    paths = []

    def walk(p, ang, length, width, depth):
        pts, ws = [p.copy()], [width]
        step = radius * 0.05
        n = max(2, int(length / step))
        for i in range(n):
            ang += rng.gauss(0, 0.28)
            p = p + Vector((math.cos(ang), math.sin(ang), 0)) * step * (0.7 + 0.6 * rng.random())
            pts.append(p.copy())
            ws.append(width * (1 - (i + 1) / (n + 1)) ** 0.8 + 0.002)
            if depth < 2 and rng.random() < 0.13:
                walk(p, ang + rng.choice((-1, 1)) * rng.uniform(0.4, 1.0), length * (1 - i / n) * rng.uniform(0.3, 0.6),
                     ws[-1] * 0.7, depth + 1)
        paths.append((pts, ws))

    k = rng.randint(6, 9)
    for i in range(k):
        ang = 2 * math.pi * (i + rng.random() * 0.6) / k
        start = Vector((math.cos(ang), math.sin(ang), 0)) * radius * 0.04
        walk(start, ang, radius * rng.uniform(0.6, 1.0), radius * 0.028 + 0.012, 0)
    for j in range(rng.randint(1, 3)):
        rr = radius * rng.uniform(0.22, 0.45)
        a0 = rng.random() * 2 * math.pi
        a1 = a0 + rng.uniform(0.6, 1.6)
        pts, ws = [], []
        for i in range(13):
            a = a0 + (a1 - a0) * i / 12
            pts.append(Vector((math.cos(a), math.sin(a), 0)) * rr * (1 + rng.gauss(0, 0.04)))
            ws.append(radius * 0.008 + 0.003)
        paths.append((pts, ws))
    return paths


def _crack_mat(glow):
    name = 'FX_crack_%.2f_%.2f_%.2f' % tuple(glow)
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (0.012, 0.009, 0.008, 1)
    b.inputs['Roughness'].default_value = 0.95
    u = _attr(nt, 'u', 'GEOMETRY')          # -1..1 across the crack
    au = _math(nt, 'ABSOLUTE', u)
    centre = _math(nt, 'POWER', _math(nt, 'SUBTRACT', 1.0, au, clamp=True), 2.0)
    heat = _attr(nt, 'fx_k')
    col = _mix_rgb(nt, _attr(nt, 'fx_w'), (0.7, 0.05, 0.005), tuple(glow))
    nt.links.new(col, b.inputs['Emission Color'])
    nt.links.new(_math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', centre, heat), 40.0), b.inputs['Emission Strength'])
    # Revealed outward from the centre (vertex 'dist' along the crack < fx_r), soft at its edges.
    reveal = _math(nt, 'LESS_THAN', _attr(nt, 'dist', 'GEOMETRY'), _attr(nt, 'fx_r'))
    alpha = _math(nt, 'MULTIPLY', reveal, _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', 1.0, _math(nt, 'POWER', au, 3.0)), 1.0, clamp=True))
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(alpha, mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(b.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    return m


def ground_crack(scene, location, frame, radius=1.5, glow=(1.0, 0.42, 0.08), chunks=True):
    """The rock splits at `location` on `frame`: radial and ring fractures race out to `radius` in three frames,
    glowing hot inside for a moment then cooling dark, with a scorched dent, a few up-thrust slabs and chunks
    thrown up. glow: the colour of the heat in the cracks (orange for raw force; pass a violet for the stone).
    Returns the collection."""
    coll = _coll(scene, 'crack_%d' % frame)
    rng = _rng(frame, location, radius, 71)
    p = Vector((location[0], location[1], GROUND_Z + 0.004))
    verts, faces, U, D = [], [], [], []
    for pts, ws in _crack_paths(rng, radius):
        dist = 0.0
        prev = None
        base0 = len(verts)
        for i, (q, w) in enumerate(zip(pts, ws)):
            if prev is not None:
                dist += (q - prev).length
            dirv = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)])
            dirv = Vector((dirv.x, dirv.y, 0)).normalized() if dirv.length > 1e-6 else Vector((1, 0, 0))
            side = Vector((-dirv.y, dirv.x, 0))
            for s in (-1.0, 0.0, 1.0):
                verts.append(q + side * w * s * 1.0)
                U.append(s)
                D.append(dist + q.length * 0.0 + (pts[0].length if True else 0))
            prev = q
        for i in range(len(pts) - 1):
            a = base0 + i * 3
            faces.append((a, a + 1, a + 4, a + 3))
            faces.append((a + 1, a + 2, a + 5, a + 4))
    me = _mesh('cracks', verts, faces, {'u': U, 'dist': D}, smooth=False)
    me.materials.append(_crack_mat(glow))
    o = _obj(coll, 'cracks', me)
    o.location = p
    o.visible_shadow = False
    for k in range(-1, int(2.5 * FPS)):
        f = frame + k
        t = max(0.0, k) / FPS
        _kp(o, 'fx_r', f, 0.0 if k < 0 else radius * 1.3 * _smooth((k + 1) / 3.0))
        _kp(o, 'fx_k', f, 0.0 if k < 0 else math.exp(-t / 0.35) + 0.05 * math.exp(-t / 1.5))
        _kp(o, 'fx_w', f, math.exp(-t / 0.25))
    _show(o, frame)
    _linear(o)
    # A scorched dent at the centre.
    vs, fs, v = _lathe([(0.0, 0.001, 1.0), (0.0, radius * 0.2, 0.8), (0.0, radius * 0.42, 0.0)], 40)
    dent = _obj(coll, 'scorch', _mesh('scorch', vs, fs, {'v': v}))
    dm = bpy.data.materials.get('FX_scorch')
    if dm is None:
        dm = bpy.data.materials.new('FX_scorch')
        dm.use_nodes = True
        nt = dm.node_tree
        nt.nodes.clear()
        outn = nt.nodes.new('ShaderNodeOutputMaterial')
        bb = nt.nodes.new('ShaderNodeBsdfPrincipled')
        bb.inputs['Base Color'].default_value = (0.01, 0.008, 0.007, 1)
        bb.inputs['Roughness'].default_value = 0.9
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        nz = nt.nodes.new('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = 6.0
        a = _math(nt, 'MULTIPLY', _attr(nt, 'v', 'GEOMETRY'), _math(nt, 'ADD', 0.45, _math(nt, 'MULTIPLY', nz.outputs['Fac'], 0.8)), clamp=True)
        nt.links.new(a, mx.inputs[0])
        nt.links.new(tr.outputs[0], mx.inputs[1])
        nt.links.new(bb.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], outn.inputs['Surface'])
    dent.data.materials.append(dm)
    dent.location = p - Vector((0, 0, 0.001))
    dent.visible_shadow = False
    _show(dent, frame)
    # Up-thrust slabs around the centre (pop up over two frames and stay).
    mat = _rock_mat()
    for i in range(rng.randint(5, 8)):
        a = rng.random() * 2 * math.pi
        rr = radius * rng.uniform(0.12, 0.45)
        s = radius * rng.uniform(0.06, 0.13)
        sl = _obj(coll, 'slab_%d' % i, _rock_mesh(rng.randrange(8)))
        if not sl.data.materials:
            sl.data.materials.append(mat)
        sl['fx_heat'] = 0.0
        sl.rotation_euler = (rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), a)
        pos = p + Vector((math.cos(a), math.sin(a), 0)) * rr
        for f, lift in ((frame, -0.6), (frame + 2, 0.15)):
            sl.location = pos + Vector((0, 0, lift * s))
            sl.scale = (s * 1.6, s * 1.2, s * (0.4 if f == frame else 0.8))
            sl.keyframe_insert('location', frame=f)
            sl.keyframe_insert('scale', frame=f)
        _show(sl, frame)
        _linear(sl)
    if chunks:
        _debris(coll, rng, p + Vector((0, 0, 0.05)), frame, int(6 + 4 * radius), 0.06 * radius ** 0.4, 5.0 * radius ** 0.3,
                Vector((0, 0, 1)), math.radians(55), hot=0.6 if glow[0] > glow[2] else 0.0, tag='chunk')
    return coll


def prepare_render(scene):
    """Cycles settings the effects rely on: enough transparent bounces for stacked additive glows."""
    scene.cycles.transparent_max_bounces = max(scene.cycles.transparent_max_bounces, 32)
    scene.cycles.max_bounces = max(scene.cycles.max_bounces, 8)


def lens_glow(scene, strength=0.5, threshold=1.0, size=0.6):
    """Optional compositor bloom (what a film lens does to white-hot energy). Builds RenderLayers -> Glare
    (Fog Glow) -> output, for Blender 4.2-4.x (scene.node_tree) and 5.x (scene.compositing_node_group)."""
    if hasattr(scene, 'compositing_node_group'):
        ng = bpy.data.node_groups.new('FX_Compositor', 'CompositorNodeTree')
        scene.compositing_node_group = ng
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        rl = ng.nodes.new('CompositorNodeRLayers')
        gl = ng.nodes.new('CompositorNodeGlare')
        out = ng.nodes.new('NodeGroupOutput')
        for nm, val in (('Type', 'Fog Glow'), ('Quality', 'High'), ('Threshold', threshold), ('Strength', strength),
                        ('Size', size)):
            try:
                gl.inputs[nm].default_value = val
            except Exception:
                pass
        ng.links.new(rl.outputs['Image'], gl.inputs['Image'])
        ng.links.new(gl.outputs['Image'], out.inputs[0])
    else:
        scene.use_nodes = True
        nt = scene.node_tree
        nt.nodes.clear()
        rl = nt.nodes.new('CompositorNodeRLayers')
        gl = nt.nodes.new('CompositorNodeGlare')
        gl.glare_type = 'FOG_GLOW'
        gl.quality = 'HIGH'
        gl.threshold = threshold
        gl.size = max(6, min(9, int(6 + size * 4)))
        try:
            gl.mix = strength - 1.0
        except AttributeError:
            pass
        comp = nt.nodes.new('CompositorNodeComposite')
        nt.links.new(rl.outputs['Image'], gl.inputs['Image'])
        nt.links.new(gl.outputs['Image'], comp.inputs['Image'])
    scene.render.use_compositing = True

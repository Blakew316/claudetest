"""Iron Man's nanotech: weapons that grow out of the suit behind a glowing edge, fed by a shimmer of nanites from
the chest reactor, and that break. Shapes after the Mark 50 / Mark 85 references (the Titan fight, the threezero
and Hot Toys pieces):

  cannon      the Mark 50 forearm cannon (after the concept art): an angular sleeve of stepped plates, jaws ahead
              of the fist with a rack of glowing coils between them, gold trim
  shield      the Mark 50 shield on the left forearm, after the Hot Toys figure (shield_mk50.py): its red plates,
              gold V and centre frame, glass visor and side panels as separate pieces (so it breaks into them)
  blade       the Mark 50 sword from the right wrist: long, curved, red back, glowing silver edge, after the
              threezero figure (weapon_sword.py)
  wings       two pairs of red wing blades with gold trim from the upper back, after the Hot Toys figure
              (weapon_wing.py)
  energy      the Endgame energy shield: a tall curved sheet of see-through blue light off the left palm
  fist        the giant fist of the uploaded nanotech model (smoothed, in the suit's metal)

  kit = build(scene, root, arm)        # in his imported pose, before any motion: every piece made and bound
  form(kit, 'cannon', f0, f1)          # grows over f0..f1
  retract(kit, 'cannon', f0, f1)       # flows back in
  snap_blade(scene, kit, frame, fx)    # the blade breaks in a fist: the outer half falls away spinning
  flicker_out(kit, 'energy', f0, f1)   # an energy shield failing: flickers and is gone
  shatter_shield(scene, kit, frame, push, fx)   # the shield breaks into its pieces, thrown along push

Every piece carries a 'nano_t' point attribute (0 where it grows from, 1 at its far end). Its materials read the
object's own keyed properties: 'form' (shown where nano_t < form, the edge glowing), 'cut_on'/'cut_at' (a break:
hide nano_t > cut_at) and 'keep_above' (a broken-off piece: show nano_t > keep_above)."""
import bpy, bmesh, importlib, math, os, random
from mathutils import Vector, Matrix
import paths
import retarget as rt
import shield_mk50

NANO_OBJ = 'hero_ironman01.obj'  # (inside the uploaded nanotech zip)
MOBILE_H = 2.03                  # that model's height (its units)
EDGE = (0.55, 0.85, 1.0)         # the forming edge's light
BLUE = (0.08, 0.5, 1.0)          # the cells and rings


# ---------- materials ----------
def _mask(nt, surface):
    """Wrap a surface shader in the nanotech mask (shown where nano_t < the object's 'form', its edge lit; the
    break and broken-piece cuts)."""
    N, L = nt.nodes.new, nt.links.new

    def obj_attr(name):
        a = N('ShaderNodeAttribute')
        a.attribute_type = 'OBJECT'
        a.attribute_name = name
        return a.outputs['Fac']

    def math(op, a, b=None):
        m = N('ShaderNodeMath')
        m.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L(v, m.inputs[i])
        return m.outputs[0]

    t = N('ShaderNodeAttribute')
    t.attribute_name = 'nano_t'
    t = t.outputs['Fac']
    tc = N('ShaderNodeTexCoord')
    noise = N('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 45.0
    L(tc.outputs['Object'], noise.inputs['Vector'])
    rag = math('MULTIPLY_ADD', noise.outputs['Fac'], 0.06)
    L(t, rag.node.inputs[2])
    form = obj_attr('form')
    # (fully formed shows all of it: the ragged edge would otherwise still eat the far end, where nano_t ~ 1)
    shown = math('MAXIMUM', math('LESS_THAN', rag, form), math('GREATER_THAN', form, 0.999))
    # a break (cut_on: hide nano_t > cut_at) and a broken piece (keep nano_t > keep_above)
    cut = math('MAXIMUM', math('SUBTRACT', 1.0, obj_attr('cut_on')), math('LESS_THAN', t, obj_attr('cut_at')))
    keep = math('GREATER_THAN', t, math('SUBTRACT', obj_attr('keep_above'), 1e-4))
    shown = math('MULTIPLY', math('MULTIPLY', shown, cut), keep)
    # the edge: a band below form, bright, while forming
    band = N('ShaderNodeMapRange')
    band.inputs['From Min'].default_value, band.inputs['From Max'].default_value = 0.0, 0.08
    band.inputs['To Min'].default_value, band.inputs['To Max'].default_value = 1.0, 0.0
    band.clamp = True
    L(math('SUBTRACT', form, rag), band.inputs['Value'])
    edge = math('MULTIPLY', band.outputs[0], math('LESS_THAN', form, 0.999))
    emit = N('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*EDGE, 1)
    L(math('MULTIPLY', edge, 30.0), emit.inputs['Strength'])
    add = N('ShaderNodeAddShader')
    L(surface, add.inputs[0])
    L(emit.outputs[0], add.inputs[1])
    clear = N('ShaderNodeBsdfTransparent')
    mix = N('ShaderNodeMixShader')
    L(shown, mix.inputs['Fac'])
    L(clear.outputs[0], mix.inputs[1])
    L(add.outputs[0], mix.inputs[2])
    out = N('ShaderNodeOutputMaterial')
    L(mix.outputs[0], out.inputs['Surface'])


def _mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes.clear()
    return m, m.node_tree


def metal(name, color, rough, coat=0.0, metallic=1.0):
    m, nt = _mat(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    for k in ('Coat Weight', 'Clearcoat'):
        if k in b.inputs:
            b.inputs[k].default_value = coat
            break
    _mask(nt, b.outputs[0])
    return m


def glass(name, color=(0.2, 0.4, 0.72), rough=0.38, light=(0.45, 0.66, 0.92), strength=0.04):
    """The shield's pale blue glass panels: frosted, lit from within a little."""
    m, nt = _mat(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    for k in ('Emission Color', 'Emission'):
        if k in b.inputs:
            b.inputs[k].default_value = (*light, 1)
            break
    b.inputs['Emission Strength'].default_value = strength
    _mask(nt, b.outputs[0])
    return m


def energy(name):
    """The energy shield: see-through blue, flowing lines across it, brighter toward its edges."""
    m, nt = _mat(name)
    N, L = nt.nodes.new, nt.links.new
    tc = N('ShaderNodeTexCoord')
    wave = N('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.inputs['Scale'].default_value = 6.0
    wave.inputs['Distortion'].default_value = 9.0
    wave.inputs['Detail'].default_value = 3.0
    L(tc.outputs['Object'], wave.inputs['Vector'])
    lines = N('ShaderNodeMapRange')
    lines.inputs['From Min'].default_value, lines.inputs['From Max'].default_value = 0.85, 1.0
    L(wave.outputs['Fac'], lines.inputs['Value'])
    lw = N('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.35
    rim = N('ShaderNodeMath')
    rim.operation = 'ADD'
    L(lines.outputs[0], rim.inputs[0])
    L(lw.outputs['Facing'], rim.inputs[1])
    emit = N('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (0.25, 0.65, 1.0, 1)
    st = N('ShaderNodeMath')
    st.operation = 'MULTIPLY_ADD'
    st.inputs[1].default_value = 6.0
    st.inputs[2].default_value = 0.6
    L(rim.outputs[0], st.inputs[0])
    L(st.outputs[0], emit.inputs['Strength'])
    clear = N('ShaderNodeBsdfTransparent')
    mix = N('ShaderNodeMixShader')
    mix.inputs['Fac'].default_value = 0.45
    L(clear.outputs[0], mix.inputs[1])
    L(emit.outputs[0], mix.inputs[2])
    _mask(nt, mix.outputs[0])
    return m


def glow(name, color, strength):
    m, nt = _mat(name)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs['Color'].default_value = (*color, 1)
    e.inputs['Strength'].default_value = strength
    _mask(nt, e.outputs[0])
    return m


def stream_material(name):
    """The nanite stream: a fine shimmer of specks running along it (keyed 'flow')."""
    m, nt = _mat(name)
    N, L = nt.nodes.new, nt.links.new
    tc = N('ShaderNodeTexCoord')
    sep = N('ShaderNodeSeparateXYZ')
    L(tc.outputs['UV'], sep.inputs[0])
    flow = N('ShaderNodeValue')
    flow.name = 'flow'
    u = N('ShaderNodeMath')
    u.operation = 'MULTIPLY_ADD'
    u.inputs[1].default_value = 90.0
    L(sep.outputs['X'], u.inputs[0])
    L(flow.outputs[0], u.inputs[2])
    v = N('ShaderNodeMath')
    v.operation = 'MULTIPLY'
    v.inputs[1].default_value = 7.0
    L(sep.outputs['Y'], v.inputs[0])
    comb = N('ShaderNodeCombineXYZ')
    L(u.outputs[0], comb.inputs['X'])
    L(v.outputs[0], comb.inputs['Y'])
    vor = N('ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = 1.0
    vor.inputs['Randomness'].default_value = 1.0
    L(comb.outputs[0], vor.inputs['Vector'])
    spark = N('ShaderNodeMapRange')
    spark.inputs['From Min'].default_value, spark.inputs['From Max'].default_value = 0.0, 0.16
    spark.inputs['To Min'].default_value, spark.inputs['To Max'].default_value = 1.0, 0.0
    spark.clamp = True
    L(vor.outputs['Distance'], spark.inputs['Value'])
    emit = N('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*EDGE, 1)
    st = N('ShaderNodeMath')
    st.operation = 'MULTIPLY'
    st.inputs[1].default_value = 40.0
    L(spark.outputs[0], st.inputs[0])
    L(st.outputs[0], emit.inputs['Strength'])
    clear = N('ShaderNodeBsdfTransparent')
    mix = N('ShaderNodeMixShader')
    L(spark.outputs[0], mix.inputs['Fac'])
    L(clear.outputs[0], mix.inputs[1])
    L(emit.outputs[0], mix.inputs[2])
    out = N('ShaderNodeOutputMaterial')
    L(mix.outputs[0], out.inputs['Surface'])
    return m


# ---------- geometry ----------
def _set_t(me, anchor, axis=None):
    """nano_t on every vertex: distance from the anchor (or along an axis from it), 0..1."""
    ds = [((v.co - anchor).dot(axis) if axis is not None else (v.co - anchor).length) for v in me.vertices]
    lo, hi = min(ds), max(ds)
    at = me.attributes.get('nano_t') or me.attributes.new('nano_t', 'FLOAT', 'POINT')
    for i, d in enumerate(ds):
        at.data[i].value = (d - lo) / max(1e-6, hi - lo)


def _prism(bm, pts, z0, z1, mat=0):
    """A flat polygon (2D points, in order) extruded from z0 to z1; faces given material index mat."""
    lo = [bm.verts.new((x, y, z0)) for x, y in pts]
    hi = [bm.verts.new((x, y, z1)) for x, y in pts]
    faces = [bm.faces.new(list(reversed(lo))), bm.faces.new(hi)]
    n = len(pts)
    for i in range(n):
        faces.append(bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i])))
    for f in faces:
        f.material_index = mat
    return faces


def _arc_x(y, h, sag):
    """x on the circular arc through (0, -h) and (0, h) that bulges to +x by sag."""
    r = (h * h + sag * sag) / (2 * sag)
    return (sag - r) + math.sqrt(max(0.0, r * r - y * y))


def _box_profile(a, b, c):
    """A flat octagon: half-width a, half-height b, corners chamfered by c (x across, z up)."""
    return [(a, b - c), (a - c, b), (-(a - c), b), (-a, b - c), (-a, -(b - c)), (-(a - c), -b), (a - c, -b), (a, -(b - c))]


def _loft(bm, sections, mat, cap_start=True, cap_end=True):
    """Rings of the same point count at given y (each (y, [(x, z) ...])) joined into a tube."""
    rings = [[bm.verts.new((x, y, z)) for x, z in pts] for y, pts in sections]
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k])).material_index = mat
    if cap_start:
        bm.faces.new(list(reversed(rings[0]))).material_index = mat
    if cap_end:
        bm.faces.new(rings[-1]).material_index = mat
    return rings


def _cannon(bm, length, r, red=0, gold=1, blue=2):
    """The Mark 50 forearm cannon along +y from 0 (the elbow end), after the concept art: an angular sleeve of
    stepped plates over the forearm and fist; ahead of the fist it splits into an upper and a lower jaw with a
    rack of glowing coils between them and the emitter glowing at the back of the gap; gold trim along the top
    and down the jaws."""
    L = length
    # the sleeve: stepped plates, each a little wider than the last
    for i, (y0, y1, k0, k1) in enumerate(((0.0, 0.17, 0.82, 0.95), (0.15, 0.33, 0.92, 1.05), (0.31, 0.5, 1.02, 1.12),
                                           (0.48, 0.62, 1.1, 1.16))):
        _loft(bm, [(y0 * L, _box_profile(r * k0 * 1.25, r * k0 * 0.95, r * 0.3)),
                   (y1 * L, _box_profile(r * k1 * 1.25, r * k1 * 0.95, r * 0.3))], red)
    # the jaws: upper and lower slabs ahead of the fist, tapering, a gap between them
    for side in (1, -1):
        z0, z1 = side * r * 0.32, side * r * 1.05
        lo_, hi_ = min(z0, z1), max(z0, z1)
        def slab(y, w, zl, zh):
            return [(w, zl), (w * 0.8, zh), (-w * 0.8, zh), (-w, zl)] if side > 0 else [(w * 0.8, zl), (w, zh), (-w, zh), (-w * 0.8, zl)]
        _loft(bm, [(0.6 * L, slab(0, r * 1.38, lo_, hi_)), (0.86 * L, slab(0, r * 1.25, lo_ + (0.08 * r if side < 0 else 0), hi_ - (0.08 * r if side > 0 else 0))),
                   (1.0 * L, slab(0, r * 1.0, lo_ + (0.25 * r if side < 0 else 0), hi_ - (0.25 * r if side > 0 else 0)))], red)
        # gold trim down each jaw's flanks
        for sx in (1, -1):
            x = sx * r * 1.33
            zc = side * r * 0.68
            _loft(bm, [(0.62 * L, [(x, zc - 0.06 * r), (x + sx * 0.05 * r, zc - 0.06 * r), (x + sx * 0.05 * r, zc + 0.06 * r), (x, zc + 0.06 * r)]),
                       (0.95 * L, [(x * 0.8, zc - 0.06 * r), (x * 0.8 + sx * 0.05 * r, zc - 0.06 * r), (x * 0.8 + sx * 0.05 * r, zc + 0.06 * r), (x * 0.8, zc + 0.06 * r)])], gold)
    # the rack of coils in the gap, glowing
    for i in range(8):
        y = (0.64 + 0.03 * i) * L
        _loft(bm, [(y, _box_profile(r * 1.15, r * 0.3, r * 0.08)), (y + 0.012 * L, _box_profile(r * 1.15, r * 0.3, r * 0.08))], blue)
    # the emitter at the back of the gap
    _loft(bm, [(0.6 * L, _box_profile(r * 0.9, r * 0.3, r * 0.1)), (0.605 * L, _box_profile(r * 0.9, r * 0.3, r * 0.1))], blue)
    # gold trim along the top of the sleeve
    for sx in (1, -1):
        x = sx * r * 0.45
        _loft(bm, [(0.05 * L, [(x - 0.05 * r, r * 0.86), (x + 0.05 * r, r * 0.86), (x + 0.05 * r, r * 0.95), (x - 0.05 * r, r * 0.95)]),
                   (0.6 * L, [(x - 0.05 * r, r * 1.12), (x + 0.05 * r, r * 1.12), (x + 0.05 * r, r * 1.21), (x - 0.05 * r, r * 1.21)])], gold)


def _energy_panel(bm, height, width, bulge, rows=24, cols=16):
    """The Endgame energy shield: a tall curved sheet (y up, bowed toward +z), as a fine grid."""
    vs = []
    for i in range(rows + 1):
        y = -height / 2 + height * i / rows
        row = []
        for j in range(cols + 1):
            x = -width / 2 + width * j / cols
            z = bulge * (1 - (2 * x / width) ** 2) * (1 - 0.35 * (2 * y / height) ** 2)
            row.append(bm.verts.new((x, y, z)))
        vs.append(row)
    for i in range(rows):
        for j in range(cols):
            bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))


def _wrap(m):
    """A finished material put through the nanotech mask (once)."""
    if m is None or m.get('nano_masked'):
        return
    nt = m.node_tree
    outs = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial']
    out = next((n for n in outs if n.is_active_output), outs[0])
    src = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
    for n in outs:
        nt.nodes.remove(n)
    if src is None:
        src = nt.nodes.new('ShaderNodeBsdfTransparent').outputs[0]
    _mask(nt, src)
    m['nano_masked'] = True


def _traced(scene, coll, module, data):
    """The pieces of a photo-traced weapon (module.build(json) in cinematic/): length 1 along +y from 0, facing +z.
    Each gets nano_t along its length, its materials masked, and is moved into coll."""
    mod = importlib.import_module(module)
    before = set(bpy.data.objects)
    mod.build(os.path.join(os.path.dirname(os.path.abspath(__file__)), data))
    new = [o for o in bpy.data.objects if o not in before]
    out = []
    for o in new:
        if o.type != 'MESH':
            continue
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        o.data.transform(mw)  # (its own placement into its mesh: the weapon's frame is put on it below)
        o.matrix_world = Matrix.Identity(4)
        _set_t(o.data, Vector((0, 0, 0)), Vector((0, 1, 0)))
        for mt in o.data.materials:
            _wrap(mt)
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
        o['form'] = 0.0
        out.append(o)
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    return out


def _mesh_obj(scene, coll, name, build_fn, mats):
    bm = bmesh.new()
    build_fn(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    o['form'] = 0.0
    return o


def _frame(origin, x, y):
    """A world matrix at origin with axes x, y (made orthonormal) and z = x cross y."""
    x = x.normalized()
    y = (y - x * y.dot(x)).normalized()
    return Matrix.Translation(origin) @ Matrix((x, y, x.cross(y))).transposed().to_4x4()


def _mobile_parts():
    """The uploaded nanotech model's giant arms, in its own space."""
    z = None
    for root in paths.roots():
        for d, _, fs in os.walk(root):
            if NANO_OBJ in fs:
                z = os.path.join(d, NANO_OBJ)
                break
        if z:
            break
    if z is None:  # (still zipped: the nanotech zip holds a zip holding the OBJ)
        z = paths.clip(NANO_OBJ)
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=z)
    new = [o for o in bpy.data.objects if o not in before]
    parts = {}
    for o in new:
        if o.name.startswith('hero_ironman01_S04_wp5'):
            parts['giant'] = o
        else:
            bpy.data.objects.remove(o, do_unlink=True)
    return parts


def _split_side(o, keep_negative_x):
    """Keep one side (x < 0: his right) of a mirrored part."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    kill = [v for v in bm.verts if (v.co.x >= 0) == keep_negative_x]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(o.data)
    bm.free()


def _bind(o, arm, bone):
    """Parent o to his bone, keeping where it is now (his imported pose)."""
    mw = o.matrix_world.copy()
    o.parent = arm
    o.parent_type = 'BONE'
    o.parent_bone = bone
    o.matrix_world = mw


# ---------- the kit ----------
def build(scene, root, arm):
    """Every nanotech piece, made in his imported pose and bound to his bones (call before any motion is put on
    him). Returns the kit: {name: {'objs': [...], 'bone': where it grows from}}."""
    coll = bpy.data.collections.new('Nanotech')
    scene.collection.children.link(coll)
    I = rt.IRON
    bpy.context.view_layer.update()
    W = {n: arm.matrix_world @ arm.pose.bones[n].matrix for n in I.values()}
    P = {k: W[I[k]].translation.copy() for k in I}
    scale = (P['head'] - (P['footL'] + P['footR']) / 2).length
    m = scale / 1.62  # (world units per metre: head-to-foot ~1.62 m on him)
    red = metal('nano_red', (0.30, 0.012, 0.016), 0.22, coat=0.6)
    gold = metal('nano_gold', (0.78, 0.53, 0.2), 0.3)
    silver = metal('nano_silver', (0.6, 0.6, 0.62), 0.25)
    blue = glow('nano_blue', BLUE, 18.0)
    body = (P['chest'] + P['hips']) / 2
    kit = {}

    def arm_axes(side):
        e, w = P['fore' + side], P['hand' + side]
        d = (w - e).normalized()
        out_ = body.copy()
        out_ = (e + (w - e) * 0.5) - body
        out_ = (out_ - d * out_.dot(d)).normalized()
        return e, w, d, out_

    # Cannons (each forearm): from the elbow over the fist and past it.
    for side, key in (('R', 'cannon'), ('L', 'cannon_l')):
        e, w, d, out_ = arm_axes(side)
        length = (w - e).length * 1.85
        o = _mesh_obj(scene, coll, 'nano_' + key, lambda bm: _cannon(bm, length, 0.062 * m), (red, gold, blue))
        _set_t(o.data, Vector((0, 0, 0)), Vector((0, 1, 0)))
        o.matrix_world = _frame(e - d * 0.02 * m, out_.cross(d), d)  # (x across, y along the arm)
        _bind(o, arm, I['fore' + side])
        kit[key] = {'objs': [o], 'bone': I['fore' + side]}

    # Shield: the Mark 50 shield (after the Hot Toys figure) on the outside of the left forearm, its top at the
    # fist, its points past the elbow, facing out from the arm. Its own paint: deeper red, warmer gold.
    e, w, d, out_ = arm_axes('L')
    across = d.cross(out_).normalized()
    H = 0.9 * m
    smats = (metal('shield_red', (0.20, 0.006, 0.009), 0.3, coat=1.0, metallic=0.9),
             metal('shield_gold', (0.58, 0.38, 0.15), 0.3), glass('shield_glass'),
             metal('shield_panel', (0.26, 0.16, 0.055), 0.42),
             metal('shield_backing', (0.035, 0.004, 0.004), 0.5, metallic=0.6))
    o = _mesh_obj(scene, coll, 'nano_shield', lambda bm: shield_mk50.build(bm, H), smats)
    _set_t(o.data, Vector((0, H / 2, 0)))  # (grows from the top, at the fist, outward)
    top = w + d * 0.1 * m
    o.matrix_world = _frame(top - d * (H / 2) + out_ * 0.075 * m, across, d)  # (x across, y up the arm, z out)
    _bind(o, arm, I['foreL'])
    kit['shield'] = {'objs': [o], 'bone': I['foreL']}

    # Blade: the Mark 50 sword from the back of the right wrist, past the fist (flat across the arm).
    e, w, d, out_ = arm_axes('R')
    blade = _traced(scene, coll, 'weapon_sword', 'weapon_sword.json')
    for i, o in enumerate(blade):
        o.name = 'nano_blade' + ('' if i == 0 else f'_{i}')
        o.matrix_world = _frame(w - d * 0.06 * m + out_ * 0.05 * m, out_.cross(d), d) @ Matrix.Scale(1.0 * m, 4)
        _bind(o, arm, I['foreR'])
    kit['blade'] = {'objs': blade, 'bone': I['foreR']}

    # Wings: two pairs of long angular blades from the upper back, the upper pair raised, the lower flatter.
    up = Vector((0, 0, 1))
    right = (P['armR'] - P['armL']).normalized()
    fwd = up.cross(right).normalized()
    back = P['chest'] - fwd * 0.12 * m + up * 0.06 * m
    wings = []
    blade_ = _traced(scene, coll, 'weapon_wing', 'weapon_wing.json')[0]  # (one built; the others share its mesh)
    for side in (1, -1):
        for j, (ang, length) in enumerate(((42, 0.95), (12, 0.75))):
            a_ = math.radians(ang)
            dir_ = (right * side * math.cos(a_) + up * math.sin(a_) - fwd * 0.45).normalized()
            across_ = fwd.cross(dir_).normalized()
            o = blade_ if not wings else blade_.copy()
            if o is not blade_:
                coll.objects.link(o)
            o.name = f'nano_wing{"R" if side > 0 else "L"}{j}'
            o['form'] = 0.0
            o.matrix_world = (_frame(back + right * side * 0.07 * m + up * (0.05 - 0.09 * j) * m, across_, dir_)
                              @ Matrix.Scale(length * m, 4))
            _bind(o, arm, I['chest'])
            wings.append(o)
    kit['wings'] = {'objs': wings, 'bone': I['chest']}

    # Energy shield (the Endgame one): projected from the left palm, a tall curved sheet facing out from it.
    e, w, d, out_ = arm_axes('L')
    across = d.cross(out_).normalized()
    o = _mesh_obj(scene, coll, 'nano_energy', lambda bm: _energy_panel(bm, 1.25 * m, 0.95 * m, 0.16 * m), (energy('nano_energy'),))
    _set_t(o.data, Vector((0, 0, 0)))
    o.matrix_world = _frame(w + d * 0.12 * m + out_ * 0.18 * m, across, d)  # (centred off the hand, facing out)
    _bind(o, arm, I['handL'])
    kit['energy'] = {'objs': [o], 'bone': I['foreL']}

    # The uploaded model's wings and giant fist, brought from its space into his.
    try:
        parts = _mobile_parts()
    except Exception as e_:
        print('(nanotech model not found:', e_, ')')
        parts = {}
    to_him = root.matrix_world @ Matrix.Scale((scale / root.matrix_world.to_scale().x) / (0.85 * MOBILE_H), 4)
    for key, bone_key, side_neg, name in (('giant', 'foreR', True, 'fist'),):
        o = parts.get(key)
        if o is None:
            continue
        if side_neg is not None:
            _split_side(o, side_neg)
        o.matrix_world = to_him @ o.matrix_world
        bpy.context.view_layer.update()
        anchor = P[bone_key]
        a_local = o.matrix_world.inverted() @ anchor
        near = min((v.co for v in o.data.vertices), key=lambda c: (c - a_local).length)
        k_ = {'giant': 0.42}[key]
        pw = o.matrix_world @ near
        o.matrix_world = Matrix.Translation(pw) @ Matrix.Scale(k_, 4) @ Matrix.Translation(-pw) @ o.matrix_world
        mod = o.modifiers.new('smooth', 'SUBSURF')
        mod.levels, mod.render_levels = 1, 2
        _set_t(o.data, near.copy())
        o.data.materials.clear()
        o.data.materials.append(red)
        for p in o.data.polygons:
            p.use_smooth = True
            p.material_index = 0
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
        o.name = 'nano_' + name
        o['form'] = 0.0
        _bind(o, arm, I['handR'] if key == 'giant' else I[bone_key])
        kit[name] = {'objs': [o], 'bone': I[bone_key]}

    kit['_stream'] = _stream(scene, coll, arm, P, scale)
    for k, v in kit.items():
        if not k.startswith('_'):
            for o in v['objs']:
                o.hide_render = True
                o.keyframe_insert('hide_render', frame=1)
                o.keyframe_insert('["form"]', frame=1)
    return kit


def _stream(scene, coll, arm, P, scale):
    cu = bpy.data.curves.new('nano_stream', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 0.01 * scale
    cu.bevel_resolution = 3
    cu.use_fill_caps = True
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(1)
    o = bpy.data.objects.new('nano_stream', cu)
    coll.objects.link(o)
    o.data.materials.append(stream_material('nano_stream'))
    ends = {}
    for i, name in enumerate(('start', 'end')):
        e = bpy.data.objects.new('nano_stream_' + name, None)
        coll.objects.link(e)
        if i == 0:  # (the reactor: on his chest)
            e.location = P['chest']
            _bind(e, arm, rt.IRON['chest'])
        # (the far end sits at the origin; while a piece forms, a Child Of puts it on that piece's bone)
        bpy.context.view_layer.update()
        ends[name] = e
        bp = sp.bezier_points[i]
        bp.co = e.matrix_world.translation
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
        h = o.modifiers.new('hook_' + name, 'HOOK')
        h.object = e
        h.vertex_indices_set([i * 3, i * 3 + 1, i * 3 + 2])
        h.matrix_inverse = (o.matrix_world.inverted() @ e.matrix_world).inverted()
    o.hide_render = True
    o.keyframe_insert('hide_render', frame=1)
    return {'obj': o, 'ends': ends, 'arm': arm}


# ---------- timing ----------
def _key(o, prop, frame, value):
    o[prop] = value
    o.keyframe_insert(f'["{prop}"]', frame=frame)


def _vis(objs, frame, on):
    for o in objs:
        o.hide_render = not on
        o.keyframe_insert('hide_render', frame=frame)


def form(kit, name, f0, f1, stream=True):
    """The piece grows over f0..f1 (the nanites streaming from the reactor to it)."""
    k = kit.get(name)
    if not k:
        return
    _vis(k['objs'], f0 - 1, True)
    for o in k['objs']:
        _key(o, 'form', f0 - 1, 0.0)
        _key(o, 'form', f1, 1.0)
    if stream:
        s = kit['_stream']
        end = s['ends']['end']
        con = end.constraints.new('CHILD_OF')  # (one stream, hung on whichever piece is forming)
        con.target = s['arm']
        con.subtarget = k['bone']
        con.inverse_matrix = Matrix.Identity(4)
        if hasattr(con, 'set_inverse_pending'):
            con.set_inverse_pending = False  # (new Child Ofs otherwise keep the object where it is)
        for f, v in ((f0 - 2, 0.0), (f0 - 1, 1.0), (f1 + 1, 1.0), (f1 + 2, 0.0)):
            con.influence = v
            con.keyframe_insert('influence', frame=f)
        o = s['obj']
        o.hide_render = False
        o.keyframe_insert('hide_render', frame=f0 - 1)
        o.hide_render = True
        o.keyframe_insert('hide_render', frame=f1 + 1)
        flow = o.data.materials[0].node_tree.nodes['flow'].outputs[0]
        flow.default_value = 0.0
        flow.keyframe_insert('default_value', frame=f0 - 1)
        flow.default_value = -3.0 * (f1 - f0 + 2)
        flow.keyframe_insert('default_value', frame=f1 + 1)


def retract(kit, name, f0, f1):
    k = kit.get(name)
    if not k:
        return
    for o in k['objs']:
        _key(o, 'form', f0, 1.0)
        _key(o, 'form', f1, 0.0)
    _vis(k['objs'], f1 + 1, False)


def flicker_out(kit, name, f0, f1):
    """A shield failing under a blow: its light stutters over f0..f1 and is gone."""
    k = kit.get(name)
    if not k:
        return
    rng = random.Random(f0)
    for o in k['objs']:
        _key(o, 'form', f0, 1.0)
        for f in range(f0 + 1, f1):
            _key(o, 'form', f, rng.choice((0.25, 0.9, 0.5, 1.0, 0.1)))
        _key(o, 'form', f1, 0.0)
    _vis(k['objs'], f1 + 1, False)


def _free_copy(scene, o, frame, name):
    """A stand-alone copy of o, fixed where o is at frame (evaluated: modifiers applied), fully formed."""
    scene.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    c = bpy.data.objects.new(name, me)
    o.users_collection[0].objects.link(c)
    c.matrix_world = o.matrix_world.copy()
    for i, mt in enumerate(o.data.materials):
        if i < len(me.materials):
            me.materials[i] = mt
        else:
            me.materials.append(mt)
    c['form'] = 1.0
    return c


def _fly(o, f0, vel, spin, frames=30, gravity=-0.02):
    """Thrown from where it is at f0: velocity (units/frame), spin (radians/frame per axis), falling."""
    p0 = o.location.copy()
    r0 = o.rotation_euler.copy()
    for i in range(0, frames + 1, 2):
        o.location = p0 + vel * i + Vector((0, 0, gravity * i * i))
        o.rotation_euler = (r0.x + spin.x * i, r0.y + spin.y * i, r0.z + spin.z * i)
        o.keyframe_insert('location', frame=f0 + i)
        o.keyframe_insert('rotation_euler', frame=f0 + i)
    for f, hide in ((f0 - 1, True), (f0, False), (f0 + frames, True)):
        o.hide_render = hide
        o.keyframe_insert('hide_render', frame=f)


def snap_blade(scene, kit, frame, fx=None):
    """The blades break in the fist that holds them: their outer halves fall away spinning; the stumps stay."""
    k = kit.get('blade')
    if not k:
        return
    rng = random.Random(frame)
    for i, o in enumerate(k['objs']):
        tip = _free_copy(scene, o, frame, f'{o.name}_tip')
        tip['keep_above'] = 0.5
        _key(o, 'cut_on', frame - 1, 0.0)
        _key(o, 'cut_on', frame, 1.0)
        o['cut_at'] = 0.5
        _fly(tip, frame, Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0.05 + 0.02 * i)),
             Vector((0.25, 0.1 * (i + 1), 0.3)))
    if fx:
        try:
            fx.impact(scene, k['objs'][0].matrix_world.translation, frame, 1.0)
        except Exception as e:
            print('(snap sparks skipped:', e, ')')


def _plates(o):
    """o split into one object per loose piece, each with its origin at its own middle (world placement kept)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    seen, groups = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, grp = [v], []
        seen.add(v.index)
        while stack:
            u = stack.pop()
            grp.append(u)
            for e in u.link_edges:
                w = e.other_vert(u)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        groups.append(grp)
    out = []
    mw = o.matrix_world
    for i, grp in enumerate(groups):
        ids = {v.index for v in grp}
        c = sum((v.co for v in grp), Vector()) / len(grp)
        nb = bm.copy()
        nb.verts.ensure_lookup_table()
        bmesh.ops.delete(nb, geom=[v for v in nb.verts if v.index not in ids], context='VERTS')
        for v in nb.verts:
            v.co -= c
        me = bpy.data.meshes.new(f'{o.name}_{i}')
        nb.to_mesh(me)
        nb.free()
        for mt in o.data.materials:
            me.materials.append(mt)
        p = bpy.data.objects.new(me.name, me)
        o.users_collection[0].objects.link(p)
        p.matrix_world = mw @ Matrix.Translation(c)
        p['form'] = 1.0
        out.append(p)
    bm.free()
    bpy.data.objects.remove(o, do_unlink=True)
    return out


def shatter_shield(scene, kit, frame, push, fx=None):
    """The shield breaks into its pieces (plates, gold frames, glass, backing), thrown along push and spinning."""
    k = kit.get('shield')
    if not k:
        return
    rng = random.Random(frame)
    center = None
    for o in k['objs']:
        whole = _free_copy(scene, o, frame, o.name + '_broken')
        c = whole.matrix_world.translation.copy()  # (before the split: it removes the whole)
        center = c if center is None else center
        for p in _plates(whole):
            out_ = (p.matrix_world.translation - c)
            v = push.normalized() * rng.uniform(0.1, 0.22) + out_.normalized() * rng.uniform(0.04, 0.1)
            _fly(p, frame, v, Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4))), frames=26)
        o.hide_render = True
        o.keyframe_insert('hide_render', frame=frame)
    if fx and center is not None:
        try:
            fx.impact(scene, center, frame, 1.8)
        except Exception as e:
            print('(shatter flash skipped:', e, ')')

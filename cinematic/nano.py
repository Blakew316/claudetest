"""Iron Man's nanotech: weapons that grow out of the suit behind a glowing edge, fed by a shimmer of nanites from
the chest reactor, and that break. Shapes after the Mark 50 / Mark 85 references (the Titan fight, the threezero
and Hot Toys pieces):

  cannon      the long forearm cannon: stacked red armour plates, gold strips, blue rings glowing at the muzzle
  shield      the Mark 50 shield on the left forearm: tall, bowed, red with a gold centre frame and pale blue
              glass panels, its shell in bands (so it breaks into pieces)
  blade       twin curved blades from the right forearm, their outer edges white-hot
  wings, fist the booster wings and the giant fist of the uploaded nanotech model (smoothed, in the suit's metal)

  kit = build(scene, root, arm)        # in his imported pose, before any motion: every piece made and bound
  form(kit, 'cannon', f0, f1)          # grows over f0..f1
  retract(kit, 'cannon', f0, f1)       # flows back in
  snap_blade(scene, kit, frame, fx)    # the blades break in a fist: the outer halves fall away spinning
  shatter_shield(scene, kit, frame, push, fx)   # the shield breaks into its pieces, thrown along push

Every piece carries a 'nano_t' point attribute (0 where it grows from, 1 at its far end). Its materials read the
object's own keyed properties: 'form' (shown where nano_t < form, the edge glowing), 'cut_on'/'cut_at' (a break:
hide nano_t > cut_at) and 'keep_above' (a broken-off piece: show nano_t > keep_above)."""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix
import paths
import retarget as rt

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
    shown = math('LESS_THAN', rag, form)
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


def metal(name, color, rough, coat=0.0):
    m, nt = _mat(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = 1.0
    b.inputs['Roughness'].default_value = rough
    for k in ('Coat Weight', 'Clearcoat'):
        if k in b.inputs:
            b.inputs[k].default_value = coat
            break
    _mask(nt, b.outputs[0])
    return m


def glass(name):
    """The shield's pale blue glass panels: lit from within, a little."""
    m, nt = _mat(name)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (0.55, 0.75, 0.9, 1)
    b.inputs['Roughness'].default_value = 0.08
    for k in ('Emission Color', 'Emission'):
        if k in b.inputs:
            b.inputs[k].default_value = (0.45, 0.75, 1.0, 1)
            break
    b.inputs['Emission Strength'].default_value = 1.2
    _mask(nt, b.outputs[0])
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


def _mk50_shield(bm, H, W, T, bulge, red=0, gold=1, glass=2, bands=4, gap=0.004):
    """The Mark 50 nano shield, upright in XY (y up, facing +z): a rounded top, straight flanks narrowing to a
    blunt point; a red shell in bands (so it breaks into pieces), a raised gold frame up the middle with a red
    panel set in it, pale blue glass along the upper flanks and at the top. Bowed outward by bulge."""
    def half_width(y):  # (of the outline, at height y; y from -H/2 to H/2)
        t = (y + H / 2) / H  # 0 at the point, 1 at the top
        if t > 0.86:  # the rounded top
            u = (t - 0.86) / 0.14
            return W / 2 * math.sqrt(max(0.0, 1 - u * u)) if u < 1 else 0.0
        if t > 0.3:
            return W / 2 * (0.86 + 0.14 * (t - 0.3) / 0.56)
        return W / 2 * (0.12 + 0.74 * t / 0.3)  # (tapering to the point)

    def outline(y0, y1, k=1.0, n=10):
        ys = [y0 + (y1 - y0) * i / n for i in range(n + 1)]
        right = [(half_width(y) * k, y) for y in ys]
        left = [(-half_width(y) * k, y) for y in reversed(ys)]
        return right + left

    top = H / 2 - 1e-4
    cuts = [-H / 2 + H * i / bands for i in range(bands + 1)]
    cuts[-1] = top
    for i in range(bands):
        y0, y1 = cuts[i] + (gap / 2 if i else 0), cuts[i + 1] - (gap / 2 if i < bands - 1 else 0)
        _prism(bm, outline(y0, y1), -T / 2, T / 2, red)
    # the gold frame: an elongated hexagon up the middle, a red panel set inside it
    hexa = lambda k: [(0.0, H * 0.40 * k), (W * 0.2 * k, H * 0.28 * k), (W * 0.2 * k, -H * 0.05 * k),
                      (0.0, -H * 0.43 * k), (-W * 0.2 * k, -H * 0.05 * k), (-W * 0.2 * k, H * 0.28 * k)]
    _prism(bm, hexa(1.0), T / 2, T / 2 + 0.25 * T, gold)
    _prism(bm, hexa(0.72), T / 2 + 0.25 * T, T / 2 + 0.45 * T, red)
    # pale blue glass: strips along the upper flanks, a window at the top
    for side in (1, -1):
        strip = [(side * W * 0.27, H * 0.02), (side * W * 0.40, H * 0.06), (side * W * 0.40, H * 0.30),
                 (side * W * 0.30, H * 0.36), (side * W * 0.27, H * 0.30)]
        _prism(bm, strip if side > 0 else list(reversed(strip)), T / 2, T / 2 + 0.2 * T, glass)
    window = [(-W * 0.16, H * 0.41), (W * 0.16, H * 0.41), (W * 0.1, H * 0.475), (-W * 0.1, H * 0.475)]
    _prism(bm, window, T / 2, T / 2 + 0.2 * T, glass)
    # bowed outward across its width
    for v in bm.verts:
        v.co.z += bulge * (1 - min(1.0, (2 * v.co.x / W) ** 2))


def _blade(bm, length, width, bulge, thick, body_mat=0, edge_mat=1):
    """A curved blade along y (0 at the arm, length at the tip), bulging to +x; its outer edge a glowing strip."""
    h = length / 2
    n = 14
    ys = [-h + length * k / n for k in range(n + 1)]
    taper = lambda y: max(0.15, 1 - ((y + h) / length) ** 3)  # (narrowing to the point)
    outer = [(_arc_x(y, h, bulge), y) for y in ys]
    inner = [(_arc_x(y, h, bulge) - width * taper(y), y) for y in reversed(ys)]
    _prism(bm, outer + inner, -thick / 2, thick / 2, body_mat)
    edge_out = [(x + width * 0.12, y) for x, y in outer]
    edge_in = [(x - width * 0.04, y) for x, y in reversed(outer)]
    _prism(bm, edge_out + edge_in, -thick * 0.25, thick * 0.25, edge_mat)
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=(0, h, 0))  # (base at y = 0)


def _cannon(bm, length, r, red=0, gold=1, blue=2):
    """The forearm cannon along +y from 0 (the elbow end): octagonal, four stacked plates, a collar, gold
    strips on its flanks and glowing rings in the muzzle."""
    oct8 = lambda rad: [(rad * math.cos(math.pi / 8 + k * math.pi / 4), rad * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]

    def ring(rad, y):
        return [bm.verts.new((x, y, z)) for x, z in oct8(rad)]

    def bridge(a, b, mat):
        for k in range(8):
            f = bm.faces.new((a[k], a[(k + 1) % 8], b[(k + 1) % 8], b[k]))
            f.material_index = mat

    profile = []
    plates = 4
    for i in range(plates):  # (each plate starts narrow and ends wide: the stacked look)
        y0, y1 = length * (0.04 + 0.19 * i), length * (0.04 + 0.19 * (i + 1))
        r0, r1 = r * (0.9 + 0.05 * i), r * (1.02 + 0.05 * i)
        profile.append((r0, y0, True))
        profile.append((r1, y1 - 0.01 * length, False))
    profile += [(r * 1.25, 0.80 * length, True), (r * 1.25, 0.9 * length, False), (r * 1.12, length, False)]
    rings = [ring(rad, y) for rad, y, _ in profile]
    cap = ring(r * 0.85, 0.0)
    bridge(cap, rings[0], red)
    for i in range(len(rings) - 1):
        bridge(rings[i], rings[i + 1], red)
    # muzzle: recessed, with an emitter at the back of it
    mouth = ring(r * 0.95, length)
    bridge(rings[-1], mouth, red)
    back = ring(r * 0.95, 0.93 * length)
    bridge(mouth, back, red)
    disc_c = bm.verts.new((0, 0.93 * length, 0))
    for k in range(8):
        f = bm.faces.new((back[k], back[(k + 1) % 8], disc_c))
        f.material_index = blue
    # gold strips along both flanks
    for side in (1, -1):
        for i in range(plates):
            y0, y1 = length * (0.08 + 0.19 * i), length * (0.17 + 0.19 * i)
            rr = r * (1.05 + 0.05 * i)
            pts = [(side * rr, y0), (side * (rr + 0.08 * r), y0 + 0.01 * length), (side * (rr + 0.08 * r), y1), (side * rr, y1)]
            vs = [bm.verts.new((x, y, z)) for x, y in pts for z in (-0.18 * r, 0.18 * r)]
            for f in (bm.faces.new((vs[0], vs[2], vs[4], vs[6])), bm.faces.new((vs[1], vs[7], vs[5], vs[3])),
                      bm.faces.new((vs[0], vs[1], vs[3], vs[2])), bm.faces.new((vs[4], vs[5], vs[7], vs[6])),
                      bm.faces.new((vs[2], vs[3], vs[5], vs[4])), bm.faces.new((vs[6], vs[7], vs[1], vs[0]))):
                f.material_index = gold
    # glowing rings in the muzzle
    for y, rr in ((0.965 * length, r * 1.0), (0.99 * length, r * 1.08)):
        res = bmesh.ops.create_circle(bm, cap_ends=False, segments=24, radius=rr)
        ring_v = res['verts']
        bmesh.ops.rotate(bm, verts=ring_v, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
        bmesh.ops.translate(bm, verts=ring_v, vec=(0, y, 0))
        ext = bmesh.ops.extrude_edge_only(bm, edges=list({e for v in ring_v for e in v.link_edges}))
        nv = [v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)]
        for v in nv:
            d = Vector((v.co.x, 0, v.co.z)).normalized()
            v.co += d * (-0.07 * r)
        for f in ext['geom']:
            if isinstance(f, bmesh.types.BMFace):
                f.material_index = blue


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
    """The uploaded nanotech model's weapon meshes (wings, giant arms), in its own space."""
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
        if o.name.startswith('hero_ironman01_S04_wp4'):
            parts['wings'] = o
        elif o.name.startswith('hero_ironman01_S04_wp5'):
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
    pale = glass('nano_glass')
    blue = glow('nano_blue', BLUE, 18.0)
    hot = glow('nano_hot', (0.75, 0.92, 1.0), 12.0)
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

    # Shield: the Mark 50 shield on the outside of the left forearm, its top at the fist, its point past the
    # elbow, facing out from the arm.
    e, w, d, out_ = arm_axes('L')
    across = d.cross(out_).normalized()
    H, Wd = 0.9 * m, 0.38 * m
    o = _mesh_obj(scene, coll, 'nano_shield', lambda bm: _mk50_shield(bm, H, Wd, 0.035 * m, 0.06 * m), (red, gold, pale))
    _set_t(o.data, Vector((0, H / 2, 0)))  # (grows from the top, at the fist, outward)
    top = w + d * 0.1 * m
    o.matrix_world = _frame(top - d * (H / 2) + out_ * 0.075 * m, across, d)  # (x across, y up the arm, z out)
    _bind(o, arm, I['foreL'])
    kit['shield'] = {'objs': [o], 'bone': I['foreL']}

    # Blades: twin curves from the right forearm, past the fist, their edges white-hot.
    e, w, d, out_ = arm_axes('R')
    across = d.cross(out_).normalized()
    blades = []
    for i, off in enumerate((-0.022, 0.022)):
        o = _mesh_obj(scene, coll, f'nano_blade{i}',
                      lambda bm: _blade(bm, 0.72 * m, 0.045 * m, 0.09 * m, 0.012 * m), (silver, hot))
        _set_t(o.data, Vector((0, 0, 0)), Vector((0, 1, 0)))
        base = e + (w - e) * 0.45 + out_ * 0.045 * m + across * off * m
        o.matrix_world = _frame(base, out_, d)  # (along the arm, curving outward)
        _bind(o, arm, I['foreR'])
        blades.append(o)
    kit['blade'] = {'objs': blades, 'bone': I['foreR']}

    # The uploaded model's wings and giant fist, brought from its space into his.
    try:
        parts = _mobile_parts()
    except Exception as e_:
        print('(nanotech model not found:', e_, ')')
        parts = {}
    to_him = root.matrix_world @ Matrix.Scale((scale / root.matrix_world.to_scale().x) / (0.85 * MOBILE_H), 4)
    for key, bone_key, side_neg, name in (('giant', 'foreR', True, 'fist'), ('wings', 'chest', None, 'wings')):
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
        k_ = {'giant': 0.42, 'wings': 0.5}[key]
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
    """The shield breaks into its pieces (shell bands, frame, glass), thrown along push and spinning."""
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

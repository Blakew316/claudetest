"""Iron Man's nanotech: weapons that grow out of the suit behind a glowing edge, fed by a stream of nanites from the
chest reactor, and that break.

  kit = build(scene, root, arm)        # before any motion is put on him: every piece made and bound to his bones
  form(kit, 'cannon', f0, f1)          # grows over f0..f1 (stream from the reactor while it does)
  retract(kit, 'cannon', f0, f1)       # flows back in
  snap_blade(scene, kit, frame)        # the blade breaks in a fist: the tip falls away spinning, sparks
  shatter_shield(scene, kit, frame, push)  # the shield breaks into its plates, thrown along push

Pieces: cannon (right forearm) and shield (left forearm) are built here; the blade (right forearm), the booster
wings (back) and the giant fist (right arm) are the uploaded nanotech model's (smoothed, in the suit's metal).
Each piece carries a 'nano_t' attribute: 0 where it grows from, 1 at its far end; its material shows the part
of it with nano_t below its 'form' value (keyed 0..1) and lights the edge."""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix
import paths
import retarget as rt

NANO_OBJ = 'hero_ironman01.obj'  # (inside the uploaded nanotech zip)
MOBILE_H = 2.03                  # that model's height (its units)
EDGE = (0.55, 0.85, 1.0)         # the forming edge's light


# ---------- materials ----------
def nano_material(name):
    """Dark red nanotech metal with gold flecks, cut off above 'form' along nano_t, the cut edge glowing."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes.new, nt.links.new
    out = N('ShaderNodeOutputMaterial')
    bsdf = N('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Metallic'].default_value = 1.0
    bsdf.inputs['Roughness'].default_value = 0.28
    tc = N('ShaderNodeTexCoord')
    vor = N('ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = 60.0
    L(tc.outputs['Object'], vor.inputs['Vector'])
    ramp = N('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = 0.0, (0.33, 0.025, 0.02, 1)
    ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 0.9, (0.5, 0.06, 0.04, 1)
    gold = ramp.color_ramp.elements.new(0.97)
    gold.color = (0.85, 0.6, 0.25, 1)
    L(vor.outputs['Distance'], ramp.inputs['Fac'])
    L(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    t = N('ShaderNodeAttribute')
    t.attribute_name = 'nano_t'
    form = N('ShaderNodeValue')
    form.name = 'form'
    form.outputs[0].default_value = 0.0
    # Shown where t < form (a little ragged: nanites, not a clean line).
    noise = N('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 40.0
    L(tc.outputs['Object'], noise.inputs['Vector'])
    rag = N('ShaderNodeMath')
    rag.operation = 'MULTIPLY_ADD'
    rag.inputs[1].default_value = 0.06
    L(noise.outputs['Fac'], rag.inputs[0])
    L(t.outputs['Fac'], rag.inputs[2])
    shown = N('ShaderNodeMath')
    shown.operation = 'LESS_THAN'
    L(rag.outputs[0], shown.inputs[0])
    L(form.outputs[0], shown.inputs[1])
    # The edge: within a band below form, bright.
    gap = N('ShaderNodeMath')
    gap.operation = 'SUBTRACT'
    L(form.outputs[0], gap.inputs[0])
    L(rag.outputs[0], gap.inputs[1])
    band = N('ShaderNodeMapRange')
    band.inputs['From Min'].default_value, band.inputs['From Max'].default_value = 0.0, 0.08
    band.inputs['To Min'].default_value, band.inputs['To Max'].default_value = 1.0, 0.0
    band.clamp = True
    L(gap.outputs[0], band.inputs['Value'])
    # (no edge once fully formed)
    full = N('ShaderNodeMath')
    full.operation = 'LESS_THAN'
    full.inputs[1].default_value = 0.999
    L(form.outputs[0], full.inputs[0])
    edge = N('ShaderNodeMath')
    edge.operation = 'MULTIPLY'
    L(band.outputs[0], edge.inputs[0])
    L(full.outputs[0], edge.inputs[1])
    emit = N('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*EDGE, 1)
    strength = N('ShaderNodeMath')
    strength.operation = 'MULTIPLY'
    strength.inputs[1].default_value = 30.0
    L(edge.outputs[0], strength.inputs[0])
    L(strength.outputs[0], emit.inputs['Strength'])
    add = N('ShaderNodeAddShader')
    L(bsdf.outputs[0], add.inputs[0])
    L(emit.outputs[0], add.inputs[1])
    clear = N('ShaderNodeBsdfTransparent')
    mix = N('ShaderNodeMixShader')
    L(shown.outputs[0], mix.inputs['Fac'])
    L(clear.outputs[0], mix.inputs[1])
    L(add.outputs[0], mix.inputs[2])
    L(mix.outputs[0], out.inputs['Surface'])
    return m


def stream_material(name):
    """The nanite stream: bright dashes running along it (keyed 'flow')."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes.new, nt.links.new
    out = N('ShaderNodeOutputMaterial')
    tc = N('ShaderNodeTexCoord')
    sep = N('ShaderNodeSeparateXYZ')
    L(tc.outputs['UV'], sep.inputs[0])
    flow = N('ShaderNodeValue')
    flow.name = 'flow'
    add = N('ShaderNodeMath')
    add.operation = 'ADD'
    L(sep.outputs['X'], add.inputs[0])
    L(flow.outputs[0], add.inputs[1])
    wave = N('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 9.0
    wave.inputs['Distortion'].default_value = 4.0
    comb = N('ShaderNodeCombineXYZ')
    L(add.outputs[0], comb.inputs['X'])
    L(comb.outputs[0], wave.inputs['Vector'])
    pw = N('ShaderNodeMath')
    pw.operation = 'POWER'
    pw.inputs[1].default_value = 6.0
    L(wave.outputs['Fac'], pw.inputs[0])
    emit = N('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*EDGE, 1)
    st = N('ShaderNodeMath')
    st.operation = 'MULTIPLY'
    st.inputs[1].default_value = 25.0
    L(pw.outputs[0], st.inputs[0])
    L(st.outputs[0], emit.inputs['Strength'])
    clear = N('ShaderNodeBsdfTransparent')
    mix = N('ShaderNodeMixShader')
    L(pw.outputs[0], mix.inputs['Fac'])
    L(clear.outputs[0], mix.inputs[1])
    L(emit.outputs[0], mix.inputs[2])
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


def _obj(scene, coll, name, me, mat):
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    me.materials.clear()
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return o


def _cannon_mesh(name, length, r):
    """A forearm cannon along +Y from 0: a sleeve, rings, a flared barrel."""
    prof = [(r * 0.95, 0.0), (r * 1.05, 0.08 * length), (r * 1.1, 0.35 * length), (r * 0.9, 0.42 * length),
            (r * 1.0, 0.48 * length), (r * 0.78, 0.62 * length), (r * 0.72, 0.9 * length), (r * 0.82, 0.97 * length),
            (r * 0.82, length), (r * 0.5, length), (r * 0.48, 0.9 * length)]
    bm = bmesh.new()
    seg = 28
    rings = []
    for rad, y in prof:
        rings.append([bm.verts.new((rad * math.cos(2 * math.pi * k / seg), y, rad * math.sin(2 * math.pi * k / seg))) for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            bm.faces.new((a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def _shield_mesh(name, radius, rings=4, seg=10):
    """A round shield of separate plates (rings of curved plates, slightly domed), facing +Z."""
    bm = bmesh.new()
    gap = 0.012 * radius
    for ri in range(rings):
        r0, r1 = radius * ri / rings, radius * (ri + 1) / rings
        n = max(1, seg * ri) if ri else 1
        for k in range(n):
            a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
            steps = max(2, int(12 / max(1, n / 6)))
            outer, inner = [], []
            for s in range(steps + 1):
                a = a0 + (a1 - a0) * s / steps
                ga = gap / max(r1, 1e-3)
                a = min(max(a, a0 + ga), a1 - ga) if n > 1 else a
                for rr, lst in ((r1 - gap, outer), (max(0.0, r0 + gap) if ri else 0.0, inner)):
                    z = 0.18 * radius * (1 - (rr / radius) ** 2)
                    lst.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), z)))
            if ri == 0:
                c = bm.verts.new((0, 0, 0.18 * radius))
                for s in range(steps):
                    bm.faces.new((c, outer[s], outer[s + 1]))
            else:
                for s in range(steps):
                    bm.faces.new((inner[s], outer[s], outer[s + 1], inner[s + 1]))
    # (some thickness)
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.04 * radius)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def _mobile_parts():
    """The uploaded nanotech model's weapon meshes (blade pair, wings, giant arms), in its own space."""
    z = None
    for root in paths.roots():
        for d, _, fs in os.walk(root):
            if NANO_OBJ in fs:
                z = os.path.join(d, NANO_OBJ)
                break
        if z:
            break
    if z is None:  # (still zipped: the nanotech zip holds a zip holding the OBJ)
        p = paths.clip(NANO_OBJ)
        z = p
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=z)
    new = [o for o in bpy.data.objects if o not in before]
    parts = {}
    for o in new:
        if o.name.startswith('hero_ironman01_S04_wp2'):
            parts['blades'] = o
        elif o.name.startswith('hero_ironman01_S04_wp4'):
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
    him). Returns the kit: {name: {'objs': [...], 'mat': material, 'bone': where it grows from}}."""
    coll = bpy.data.collections.new('Nanotech')
    scene.collection.children.link(coll)
    I = rt.IRON
    bpy.context.view_layer.update()
    W = {n: arm.matrix_world @ arm.pose.bones[n].matrix for n in I.values()}
    P = {k: W[I[k]].translation.copy() for k in I}
    scale = (P['head'] - (P['footL'] + P['footR']) / 2).length  # (his size in the world, for sizing pieces)
    kit = {}

    def piece(name, me, *_):
        mat = nano_material('nano_' + name)
        o = _obj(scene, coll, 'nano_' + name, me, mat)
        return o, mat

    # Cannon: along the right forearm from the elbow, out past the fist.
    e, w = P['foreR'], P['handR']
    d = (w - e).normalized()
    length = (w - e).length * 1.9
    me = _cannon_mesh('nano_cannon', length, 0.11 * scale)
    _set_t(me, Vector((0, 0, 0)), Vector((0, 1, 0)))
    o, mat = piece('cannon', me, I['foreR'], e)
    side = d.cross(Vector((0, 0, 1))).normalized()
    o.matrix_world = Matrix.Translation(e) @ Matrix((side, d, side.cross(d))).transposed().to_4x4()
    _bind(o, arm, I['foreR'])
    kit['cannon'] = {'objs': [o], 'mat': mat, 'bone': I['foreR']}
    # A second cannon on the left arm (the ending).
    e2, w2 = P['foreL'], P['handL']
    d2 = (w2 - e2).normalized()
    me2 = _cannon_mesh('nano_cannon_l', length, 0.11 * scale)
    _set_t(me2, Vector((0, 0, 0)), Vector((0, 1, 0)))
    o2, mat2 = piece('cannon_l', me2, I['foreL'], e2)
    side2 = d2.cross(Vector((0, 0, 1))).normalized()
    o2.matrix_world = Matrix.Translation(e2) @ Matrix((side2, d2, side2.cross(d2))).transposed().to_4x4()
    _bind(o2, arm, I['foreL'])
    kit['cannon_l'] = {'objs': [o2], 'mat': mat2, 'bone': I['foreL']}

    # Shield: on the outside of the left forearm, facing out from it.
    e, w = P['foreL'], P['handL']
    mid = e + (w - e) * 0.55
    body = (P['chest'] + P['hips']) / 2
    out_ = (mid - body)
    fd = (w - e).normalized()
    out_ = (out_ - fd * out_.dot(fd)).normalized()
    me = _shield_mesh('nano_shield', 0.32 * scale)
    _set_t(me, Vector((0, 0, 0)))
    o, mat = piece('shield', me, I['foreL'], mid)
    y = fd
    x = y.cross(out_).normalized()
    o.matrix_world = Matrix.Translation(mid + out_ * 0.05 * scale) @ Matrix((x, y, out_)).transposed().to_4x4()
    _bind(o, arm, I['foreL'])
    kit['shield'] = {'objs': [o], 'mat': mat, 'bone': I['foreL']}

    # The uploaded model's pieces, brought from its space into his: same stance (feet at 0, facing -y), so a
    # uniform scale, then his root's turn and place.
    try:
        parts = _mobile_parts()
    except Exception as e_:
        print('(nanotech model not found:', e_, ')')
        parts = {}
    to_him = root.matrix_world @ Matrix.Scale((scale / root.matrix_world.to_scale().x) / (0.85 * MOBILE_H), 4)
    for key, bone_key, side_neg in (('blades', 'foreR', True), ('giant', 'foreR', True), ('wings', 'chest', None)):
        o = parts.get(key)
        if o is None:
            continue
        if side_neg is not None:
            _split_side(o, side_neg)
        o.matrix_world = to_him @ o.matrix_world
        mod = o.modifiers.new('smooth', 'SUBSURF')
        mod.levels, mod.render_levels = 1, 2
        bpy.context.view_layer.update()
        # Grows from the point nearest the bone it hangs on (and, for the oversized game pieces, scaled down
        # about that point to the suit's size).
        anchor_w = P[bone_key]
        mw_inv = o.matrix_world.inverted()
        a_local = mw_inv @ anchor_w
        near = min((v.co for v in o.data.vertices), key=lambda c: (c - a_local).length)
        k_ = {'blades': 1.0, 'giant': 0.42, 'wings': 0.5}[key]
        if k_ != 1.0:
            pw = o.matrix_world @ near
            o.matrix_world = Matrix.Translation(pw) @ Matrix.Scale(k_, 4) @ Matrix.Translation(-pw) @ o.matrix_world
            bpy.context.view_layer.update()
        _set_t(o.data, near.copy())
        mat = nano_material('nano_' + key)
        o.data.materials.clear()
        o.data.materials.append(mat)
        for p in o.data.polygons:
            p.use_smooth = True
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
        o.name = 'nano_' + {'blades': 'blade', 'giant': 'fist', 'wings': 'wings'}[key]
        _bind(o, arm, I[bone_key] if key != 'giant' else I['handR'])
        kit[{'blades': 'blade', 'giant': 'fist', 'wings': 'wings'}[key]] = {'objs': [o], 'mat': mat, 'bone': I[bone_key]}

    # The stream: a thin tube from the reactor to the forming piece's root, hooked to both ends.
    kit['_stream'] = _stream(scene, coll, arm, P, scale)
    for k, v in kit.items():
        if not k.startswith('_'):
            for o in v['objs']:
                o.hide_render = True
                o.keyframe_insert('hide_render', frame=1)
    return kit


def _stream(scene, coll, arm, P, scale):
    cu = bpy.data.curves.new('nano_stream', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 0.012 * scale
    cu.bevel_resolution = 2
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
def _key_form(mat, frame, value):
    s = mat.node_tree.nodes['form'].outputs[0]
    s.default_value = value
    s.keyframe_insert('default_value', frame=frame)


def _vis(objs, frame, on):
    for o in objs:
        o.hide_render = not on
        o.keyframe_insert('hide_render', frame=frame)


def form(kit, name, f0, f1, stream=True):
    """The piece grows over f0..f1 (the stream feeding it from the reactor)."""
    k = kit.get(name)
    if not k:
        return
    _vis(k['objs'], f0 - 1, True)
    _key_form(k['mat'], f0 - 1, 0.0)
    _key_form(k['mat'], f1, 1.0)
    if stream:
        s = kit['_stream']
        end = s['ends']['end']
        # (re-hung on the forming piece's bone for this stretch: one stream, moved to where it's needed)
        con = end.constraints.new('CHILD_OF')
        con.target = s['arm']
        con.subtarget = k['bone']
        con.inverse_matrix = Matrix.Identity(4)
        if hasattr(con, 'set_inverse_pending'):
            con.set_inverse_pending = False  # (new Child Ofs otherwise keep the object where it is)
        con.influence = 0.0
        con.keyframe_insert('influence', frame=f0 - 2)
        con.influence = 1.0
        con.keyframe_insert('influence', frame=f0 - 1)
        con.keyframe_insert('influence', frame=f1 + 1)
        con.influence = 0.0
        con.keyframe_insert('influence', frame=f1 + 2)
        o = s['obj']
        o.hide_render = False
        o.keyframe_insert('hide_render', frame=f0 - 1)
        o.hide_render = True
        o.keyframe_insert('hide_render', frame=f1 + 1)
        flow = o.data.materials[0].node_tree.nodes['flow'].outputs[0]
        flow.default_value = 0.0
        flow.keyframe_insert('default_value', frame=f0 - 1)
        flow.default_value = -0.12 * (f1 - f0 + 2)
        flow.keyframe_insert('default_value', frame=f1 + 1)


def retract(kit, name, f0, f1):
    k = kit.get(name)
    if not k:
        return
    _key_form(k['mat'], f0, 1.0)
    _key_form(k['mat'], f1, 0.0)
    _vis(k['objs'], f1 + 1, False)


def _free_copy(scene, o, frame, name):
    """A stand-alone copy of o, fixed where o is at frame (evaluated: modifiers applied)."""
    scene.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    c = bpy.data.objects.new(name, me)
    o.users_collection[0].objects.link(c)
    c.matrix_world = o.matrix_world.copy()
    mat = o.data.materials[0].copy()
    mat.node_tree.animation_data_clear()  # (its own: fully formed, not keyed with the original)
    mat.node_tree.nodes['form'].outputs[0].default_value = 1.0
    me.materials.clear()
    me.materials.append(mat)
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
    o.hide_render = True
    o.keyframe_insert('hide_render', frame=f0 - 1)
    o.hide_render = False
    o.keyframe_insert('hide_render', frame=f0)
    o.hide_render = True
    o.keyframe_insert('hide_render', frame=f0 + frames)


def snap_blade(scene, kit, frame, fx=None):
    """The blade breaks in the fist that holds it: its outer half falls away spinning; the stump stays."""
    k = kit.get('blade')
    if not k:
        return
    o = k['objs'][0]
    tip = _free_copy(scene, o, frame, 'nano_blade_tip')
    # Keep the outer half on the falling piece, the inner on the arm (by nano_t, through the material).
    _cut(tip.data.materials[0], keep_above=0.5)
    _cut(o.data.materials[0], keep_above=None, below=0.5, from_frame=frame)
    rng = random.Random(frame)
    _fly(tip, frame, Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0.06)), Vector((0.25, 0.1, 0.3)))
    if fx:
        try:
            fx.impact(scene, tip.matrix_world.translation, frame, 1.0)
        except Exception as e:
            print('(snap sparks skipped:', e, ')')


def _cut(mat, keep_above=None, below=None, from_frame=None):
    """Hide part of a piece by nano_t: keep_above shows only t > value (always); below hides t > value from a
    frame on (keyed)."""
    nt = mat.node_tree
    t = next(n for n in nt.nodes if n.type == 'ATTRIBUTE')
    mix = next(n for n in nt.nodes if n.type == 'MIX_SHADER')
    fac_src = mix.inputs['Fac'].links[0].from_socket
    cmp = nt.nodes.new('ShaderNodeMath')
    cmp.operation = 'GREATER_THAN' if keep_above is not None else 'LESS_THAN'
    cmp.inputs[1].default_value = keep_above if keep_above is not None else below
    nt.links.new(t.outputs['Fac'], cmp.inputs[0])
    if from_frame is not None:  # (a switch: 1 before the frame = no cut)
        sw = nt.nodes.new('ShaderNodeMath')
        sw.operation = 'MAXIMUM'
        sw.inputs[1].default_value = 1.0
        sw.inputs[1].keyframe_insert('default_value', frame=from_frame - 1)
        sw.inputs[1].default_value = 0.0
        sw.inputs[1].keyframe_insert('default_value', frame=from_frame)
        nt.links.new(cmp.outputs[0], sw.inputs[0])
        cmp = sw
    both = nt.nodes.new('ShaderNodeMath')
    both.operation = 'MULTIPLY'
    nt.links.new(fac_src, both.inputs[0])
    nt.links.new(cmp.outputs[0], both.inputs[1])
    nt.links.new(both.outputs[0], mix.inputs['Fac'])


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
        me.materials.append(o.data.materials[0])
        p = bpy.data.objects.new(me.name, me)
        o.users_collection[0].objects.link(p)
        p.matrix_world = mw @ Matrix.Translation(c)
        out.append(p)
    bm.free()
    bpy.data.objects.remove(o, do_unlink=True)
    return out


def shatter_shield(scene, kit, frame, push, fx=None):
    """The shield breaks into its plates, thrown along push (a world direction) and spinning."""
    k = kit.get('shield')
    if not k:
        return
    o = k['objs'][0]
    whole = _free_copy(scene, o, frame, 'nano_shield_broken')
    plates = _plates(whole)
    rng = random.Random(frame)
    center = whole.matrix_world.translation.copy()
    for p in plates:
        out_ = (p.matrix_world.translation - center)
        v = push.normalized() * rng.uniform(0.1, 0.22) + out_.normalized() * rng.uniform(0.04, 0.1)
        _fly(p, frame, v, Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4))), frames=26)
    o.hide_render = True
    o.keyframe_insert('hide_render', frame=frame)
    if fx:
        try:
            fx.impact(scene, center, frame, 1.8)
        except Exception as e:
            print('(shatter flash skipped:', e, ')')

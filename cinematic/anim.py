"""Animation assembly: clips placed on the NLA per shot, the characters' root moves, and arm poses aimed in
world space over the motion capture (repulsors, the raised gauntlet, a fist)."""
import bpy
from mathutils import Matrix, Quaternion, Vector
import retarget as rt

ARM_BONES = {
    'iron': {'L': ['bone032', 'bone033', 'bone034', 'bone035'], 'R': ['bone065', 'bone066', 'bone067', 'bone068']},
    'thanos': {'L': ['c_shoulder.l', 'c_arm_fk.l', 'c_forearm_fk.l', 'c_hand_fk.l'],
               'R': ['c_shoulder.r', 'c_arm_fk.r', 'c_forearm_fk.r', 'c_hand_fk.r']},
}
# Which of those bones carry the upper arm, the forearm and the hand.
KEY = {'iron': {'upper': 1, 'fore': 2, 'hand': 3}, 'thanos': {'upper': 1, 'fore': 2, 'hand': 3}}
# First knuckles of the index and little fingers and the middle finger, for the palm's facing and the fingers' line.
KNUCKLES = {'iron': {'L': ('bone052', 'bone037', 'bone047'), 'R': ('bone085', 'bone070', 'bone080')},
            'thanos': {'L': ('index1.l', 'pinky1.l', 'middle1.l'), 'R': ('index1.r', 'pinky1.r', 'middle1.r')}}


def rot(m):
    return m.to_3x3().normalized().to_quaternion()


def clip(arm, names, src, name, src_range=None, rate=1.25, root_motion=True):
    """Bake a motion clip onto him (keyed from frame 1, at film speed by default)."""
    action, n = rt.retarget(src, arm, names, name, frames=src_range, rate=rate, root_motion=root_motion)
    arm.animation_data.action = None
    return action, n


def place(arm, action, start, blend_in=0, blend_out=0, track=None, influence=None, repeat=1.0, scale=1.0):
    """Put an action on his NLA at frame `start` (a new track on top unless one is named)."""
    ad = arm.animation_data or arm.animation_data_create()
    tr = ad.nla_tracks.get(track) if track else None
    if tr is None:
        tr = ad.nla_tracks.new()
        if track:
            tr.name = track
    st = tr.strips.new(action.name, int(start), action)
    st.blend_type = 'REPLACE'
    st.extrapolation = 'NOTHING'
    st.repeat = repeat
    st.scale = scale
    st.blend_in = blend_in
    st.blend_out = blend_out
    if influence is not None:
        st.use_animated_influence = True
        for f, v in influence:
            st.influence = v
            st.keyframe_insert('influence', frame=f)
    return st


def key_root(root, frame, loc=None, yaw=None, interp='BEZIER'):
    """Key his root (placement and facing about z) at a frame."""
    if loc is not None:
        root.location = loc
        root.keyframe_insert('location', frame=frame)
    if yaw is not None:
        root.rotation_euler.z = yaw
        root.keyframe_insert('rotation_euler', index=2, frame=frame)
    if root.animation_data and root.animation_data.action:
        for fc in fcurves_of(root.animation_data.action):
            for kp in fc.keyframe_points:
                if abs(kp.co[0] - frame) < 0.5:
                    kp.interpolation = interp


def fcurves_of(action):
    """All F-curves of an action (Blender 4.4+ keeps them in layers/strips/channelbags)."""
    if hasattr(action, 'fcurves') and action.fcurves is not None:
        try:
            return list(action.fcurves)
        except TypeError:
            pass
    out = []
    for layer in getattr(action, 'layers', []):
        for strip in layer.strips:
            for cb in getattr(strip, 'channelbags', []):
                out.extend(cb.fcurves)
    return out


def palm_axes(arm, who, side):
    """The palm's outward normal and the fingers' line, in the hand bone's own frame (from its imported pose:
    hanging arms, palms in toward the body)."""
    W0 = rt.capture_default(arm)[0]
    hand = ARM_BONES[who][side][KEY[who]['hand']]
    Rh = rot(W0[hand])
    kn = KNUCKLES[who][side]
    if kn is None:  # (Thanos's gauntlet hand: no finger bones; assume the usual bone frame)
        return Vector((0, 0, 1 if side == 'L' else -1)), Vector((0, 1, 0))
    p = {b: W0[b].translation for b in kn}
    across = p[kn[0]] - p[kn[1]]
    fingers = (p[kn[2]] - W0[hand].translation).normalized()
    n = across.cross(fingers).normalized()
    # Palms hang facing in toward the body's middle: point n that way.
    mid = (W0[ARM_BONES[who]['L'][KEY[who]['hand']]].translation + W0[ARM_BONES[who]['R'][KEY[who]['hand']]].translation) / 2
    toward = mid - W0[hand].translation
    toward.z = 0
    if n.dot(toward) < 0:
        n = -n
    return (Rh.inverted() @ n).normalized(), (Rh.inverted() @ fingers).normalized()


def frame_from(a, b):
    """An orthonormal frame with x along a and y as near b as it can be."""
    x = a.normalized()
    y = b - x * b.dot(x)
    if y.length < 1e-6:
        y = Vector((0, 0, 1)) - x * x.z
    y.normalize()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def aim_arm(arm, who, side, f0, f1, target, palm=True, bend=0.12, ramp=5, up_hint=Vector((0, 0, 1)), name=None,
            fore_dir=None, palm_dir=None, upper_dir=None):
    """Over frames f0..f1 put his arm straight out at `target` (a world point, or a function of the frame giving
    one), palm facing it, fingers up — the repulsor pose — over the captured pose, easing in and out over
    `ramp` frames. With fore_dir/palm_dir (functions of the frame giving world directions) the forearm and palm
    are set instead (Thanos raising the gauntlet: forearm up, palm to the blast)."""
    bones = ARM_BONES[who][side]
    k = KEY[who]
    n_loc, f_loc = palm_axes(arm, who, side)
    dg = bpy.context.evaluated_depsgraph_get()
    sc = bpy.context.scene
    A = rot(arm.matrix_world)
    Ainv = A.inverted()
    data = arm.data.bones
    # Each bone measured from the one before it in the chain (rig helper bones in between hold their rest), the
    # upper arm from its own parent.
    cpar = {b: rt.eff_parent(arm, b) if i == k['upper'] else bones[i - 1] for i, b in enumerate(bones) if i >= 1}
    rest_rel = {b: rot(data[cpar[b]].matrix_local.inverted() @ data[b].matrix_local) for b in bones[1:]}
    # Each limb bone's line (to the next joint) in its own frame, from the imported pose: skeleton-agnostic.
    W0 = rt.capture_default(arm)[0]
    line = {}
    for a_, b_ in ((bones[k['upper']], bones[k['fore']]), (bones[k['fore']], bones[k['hand']])):
        line[a_] = rot(W0[a_]).inverted() @ (W0[b_].translation - W0[a_].translation).normalized()
    action = bpy.data.actions.new(name or f'aim_{who}_{side}_{f0}')
    keyed = []
    for f in range(f0 - ramp, f1 + ramp + 1):
        sc.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = arm.evaluated_get(dg)
        P = {b: ev.pose.bones[b] for b in set(bones) | {cpar[bones[k['upper']]]}}
        Wm = {b: arm.matrix_world @ P[b].matrix for b in P}
        T = target(f) if callable(target) else Vector(target)
        sh = Wm[bones[k['upper']]].translation
        to = (T - sh).normalized()
        if fore_dir:
            fd = fore_dir(f).normalized()
            ud = upper_dir(f).normalized() if upper_dir else fd
        else:
            # A slight bend: the elbow a touch down and out from the straight line.
            down = Vector((0, 0, -1))
            fd = to
            ud = (to + down * bend).normalized()
        # Upper arm: turn its captured direction onto ud (keeps the captured twist).
        wr = {}
        for b in bones:
            wr[b] = rot(Wm[b])
        def turn_onto(b, d):
            cur = wr[b] @ line[b]
            return cur.rotation_difference(d) @ wr[b]
        new = {}
        ua = bones[k['upper']]
        new[ua] = turn_onto(ua, ud)
        # Chain: twist bones as captured, relative to their (new) parents.
        chain = bones[k['upper']:]
        world = {ua: new[ua]}
        for i in range(1, len(chain)):
            b = chain[i]
            parent = chain[i - 1]
            basis = P[b].matrix_basis.to_quaternion()
            ident = world[parent] @ rest_rel[b]
            if b == bones[k['fore']]:
                # Forearm onto the line to the target.
                captured = ident @ basis
                cur = captured @ line[b]
                world[b] = cur.rotation_difference(fd) @ captured
            elif b == bones[k['hand']]:
                if palm:
                    pd = palm_dir(f).normalized() if palm_dir else to
                    # Fingers up (as near world up as the palm's facing allows).
                    up = up_hint - pd * up_hint.dot(pd)
                    up.normalize()
                    B_want = frame_from(pd, up)
                    B_loc = frame_from(n_loc, f_loc)
                    world[b] = (B_want @ B_loc.transposed()).to_quaternion()
                else:
                    world[b] = ident @ basis
            else:
                world[b] = ident @ basis
        # Local bases (armature space throughout: the object's own turn taken out).
        parent0 = rot(Wm[cpar[bones[k['upper']]]])  # (the upper arm's own parent: the clavicle, or the chest)
        out = {}
        prev = parent0
        for i, b in enumerate(chain):
            par = prev if i == 0 else world[chain[i - 1]]
            ident = (Ainv @ par) @ rest_rel[b]
            out[b] = ident.inverted() @ (Ainv @ world[b])
        keyed.append((f, out))
    # Key the override action, then put it on a track of its own above the motion capture.
    arm.animation_data.action = action
    for f, out in keyed:
        for b, q in out.items():
            pb = arm.pose.bones[b]
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
    arm.animation_data.action = None
    st = place(arm, action, f0 - ramp, track=None,
               influence=[(f0 - ramp, 0.0), (f0, 1.0), (f1, 1.0), (f1 + ramp, 0.0)])
    return st

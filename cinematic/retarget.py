"""Retarget humanoid FBX motion (Mixamo / mocap packs) onto the Iron Man and Thanos rigs, baked as actions."""
import bpy
from mathutils import Matrix, Quaternion, Vector

LOGICAL = ['hips', 'spine', 'spine1', 'chest', 'neck', 'head',
           'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
           'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR']
# Which logical bone each one points toward (its direction in the rest pose).
TOWARD = {'hips': 'chest', 'spine': 'chest', 'spine1': 'neck', 'chest': 'neck', 'neck': 'head', 'head': None,
          'clavL': 'armL', 'armL': 'foreL', 'foreL': 'handL', 'handL': None,
          'clavR': 'armR', 'armR': 'foreR', 'foreR': 'handR', 'handR': None,
          'thighL': 'shinL', 'shinL': 'footL', 'footL': 'toeL', 'toeL': None,
          'thighR': 'shinR', 'shinR': 'footR', 'footR': 'toeR', 'toeR': None}
# (Bones with no child to point at continue their parent's line.)
CONTINUE = {'head': 'neck', 'handL': 'foreL', 'handR': 'foreR', 'toeL': 'footL', 'toeR': 'footR'}

SRC = {'hips': 'Hips', 'spine': 'Spine', 'spine1': 'Spine1', 'chest': 'Spine2', 'neck': 'Neck', 'head': 'Head',
       'clavL': 'LeftShoulder', 'armL': 'LeftArm', 'foreL': 'LeftForeArm', 'handL': 'LeftHand',
       'clavR': 'RightShoulder', 'armR': 'RightArm', 'foreR': 'RightForeArm', 'handR': 'RightHand',
       'thighL': 'LeftUpLeg', 'shinL': 'LeftLeg', 'footL': 'LeftFoot', 'toeL': 'LeftToeBase',
       'thighR': 'RightUpLeg', 'shinR': 'RightLeg', 'footR': 'RightFoot', 'toeR': 'RightToeBase'}
# The purchased models. Iron Man (MK85, a game rig: bones are numbered, so mapped by where they sit) and Thanos
# (an Auto-Rig Pro rig driven through its FK controls; its deform bones follow those by constraints).
IRON = {'hips': 'bone002', 'spine': 'bone024', 'spine1': 'bone025', 'chest': 'bone027',
        'neck': 'bone098', 'head': 'bone100',
        'clavL': 'bone032', 'armL': 'bone033', 'foreL': 'bone034', 'handL': 'bone035',
        'clavR': 'bone065', 'armR': 'bone066', 'foreR': 'bone067', 'handR': 'bone068',
        'thighL': 'bone004', 'shinL': 'bone005', 'footL': 'bone006', 'toeL': 'bone007',
        'thighR': 'bone018', 'shinR': 'bone019', 'footR': 'bone020', 'toeR': 'bone021'}
THANOS = {'hips': 'c_root.x', 'spine': 'c_spine_01.x', 'spine1': 'c_spine_02.x', 'chest': 'c_spine_03.x',
          'neck': 'c_neck.x', 'head': 'c_head.x',
          'clavL': 'c_shoulder.l', 'armL': 'c_arm_fk.l', 'foreL': 'c_forearm_fk.l', 'handL': 'c_hand_fk.l',
          'clavR': 'c_shoulder.r', 'armR': 'c_arm_fk.r', 'foreR': 'c_forearm_fk.r', 'handR': 'c_hand_fk.r',
          'thighL': 'c_thigh_fk.l', 'shinL': 'c_leg_fk.l', 'footL': 'c_foot_fk.l', 'toeL': 'c_toes_fk.l',
          'thighR': 'c_thigh_fk.r', 'shinR': 'c_leg_fk.r', 'footR': 'c_foot_fk.r', 'toeR': 'c_toes_fk.r'}
# Bones whose real parent follows another bone by constraint (Auto-Rig Pro's head hangs off the neck through
# a Child Of): posed as if parented to that bone.
EFF_PARENT = {'c_head.x': 'c_neck.x'}
# Where the hips' travel goes when it isn't the hips bone itself (Auto-Rig Pro: c_root.x turns the pelvis only;
# c_root_master.x carries the whole body).
LOC_BONE = {'c_root.x': 'c_root_master.x'}


def eff_parent(arm, name):
    p = EFF_PARENT.get(name)
    if p and p in arm.data.bones:
        return p
    b = arm.data.bones[name]
    return b.parent.name if b.parent else None


def rot_of(m):
    return m.to_3x3().normalized().to_quaternion()


DEFAULT = {}  # per target armature: its pose as imported (world matrices, and each bone's basis)


def capture_default(arm):
    """The pose a model shows as imported (its glTF nodes), which is not always its bind pose: the reference
    a target is measured and posed from."""
    if arm.name in DEFAULT:
        return DEFAULT[arm.name]
    bpy.context.view_layer.update()
    DEFAULT[arm.name] = ({pb.name: (arm.matrix_world @ pb.matrix).copy() for pb in arm.pose.bones},
                         {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones})
    return DEFAULT[arm.name]


def rest_world(arm, name):
    """World matrix of a bone in its reference pose: a target's pose as imported, a source's rest."""
    if arm.name in DEFAULT:
        return DEFAULT[arm.name][0][name]
    return arm.matrix_world @ arm.data.bones[name].matrix_local


def basis(d, fwd):
    x = d.normalized()
    z = fwd - x * fwd.dot(x)
    if z.length < 1e-4:
        z = Vector((0, 0, 1)) - x * x.z
    z.normalize()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed()  # columns x, y, z


def frame_basis(arm, names, logical, fwd):
    """Per logical bone: an orthonormal frame from its rest direction and the body's forward."""
    pos = {k: rest_world(arm, names[k]).translation for k in LOGICAL}
    out = {}
    for k in LOGICAL:
        t = TOWARD[k]
        if t:
            d = pos[t] - pos[k]
        else:
            p = CONTINUE[k]
            d = pos[k] - pos[p]
        out[k] = basis(d, fwd)
    return out


def forward_of(arm, names):
    """The body's forward (horizontal): from the heels toward the toes."""
    f = Vector((0, 0, 0))
    for s in 'LR':
        f += rest_world(arm, names['toe' + s]).translation - rest_world(arm, names['foot' + s]).translation
    f.z = 0
    return f.normalized()


def strip(arm):
    """Source bone names without a 'mixamorig:' style prefix."""
    return {b.name.split(':')[-1]: b.name for b in arm.data.bones}


def import_source(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    new = [o for o in bpy.data.objects if o not in before]
    arm = [o for o in new if o.type == 'ARMATURE'][0]
    return arm, new


def retarget(src_path, tgt, tgt_names, name, scale_to=None, frames=None, step=1, root_motion=True, rate=1.0):
    """Bake the motion of the FBX at src_path onto armature object tgt as a new action `name`, keyed from
    frame 1. rate: source frames per output frame (30 fps capture played at 24 fps: 1.25; slower < that).
    frames: the source range (first, last). Returns (action, frame_count)."""
    W0, B0 = capture_default(tgt)
    src, new = import_source(src_path)
    smap = strip(src)
    snames = {k: smap[v] for k, v in SRC.items()}
    act = src.animation_data.action
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    if frames:
        f0, f1 = frames
    sc = bpy.context.scene
    # Rest frames.
    sc.frame_set(f0)
    s_fwd = forward_of(src, snames)
    t_fwd = forward_of(tgt, tgt_names)
    # The source's motion is turned onto his facing: q_yaw takes the source's forward onto the target's.
    q_yaw = s_fwd.rotation_difference(t_fwd)
    M_yaw = q_yaw.to_matrix()
    Bs = {k: M_yaw @ v for k, v in frame_basis(src, snames, LOGICAL, s_fwd).items()}
    Bt = frame_basis(tgt, tgt_names, LOGICAL, t_fwd)
    # C maps the target's rest frame onto the source's: R_t(t) = D_s(t) @ C @ R_t0, D_s = R_s(t) @ R_s0^-1.
    C = {k: (Bs[k] @ Bt[k].transposed()).to_quaternion() for k in LOGICAL}
    # The facing difference between the two (about the vertical): carries the hips' travel across.
    Rs0 = {k: rot_of(rest_world(src, snames[k])) for k in LOGICAL}
    Rt0 = {k: rot_of(rest_world(tgt, tgt_names[k])) for k in LOGICAL}
    s_hip0 = rest_world(src, snames['hips']).translation.copy()
    t_hip0 = rest_world(tgt, tgt_names['hips']).translation.copy()
    s_h = s_hip0.z - min(rest_world(src, snames['foot' + s]).translation.z for s in 'LR')
    t_h = t_hip0.z - min(rest_world(tgt, tgt_names['foot' + s]).translation.z for s in 'LR')
    k_len = t_h / s_h if s_h > 1e-6 else 1.0
    inv_name = {v: k for k, v in tgt_names.items()}
    A = rot_of(tgt.matrix_world)
    Ainv = A.inverted()
    bones = tgt.data.bones
    pose = tgt.pose.bones
    for n in tgt_names.values():
        pose[n].rotation_mode = 'QUATERNION'  # (only the bones it keys: other bones keep theirs, rig drivers read them)
    if not tgt.animation_data:
        tgt.animation_data_create()
    action = bpy.data.actions.new(name)
    tgt.animation_data.action = action
    order = []

    def walk(b):
        order.append(b)
        for c in b.children:
            walk(c)

    for b in bones:
        if b.parent is None:
            walk(b)
    par = {b.name: eff_parent(tgt, b.name) for b in bones}
    rest_rel = {b.name: rot_of(bones[par[b.name]].matrix_local.inverted() @ b.matrix_local) if par[b.name] else rot_of(b.matrix_local) for b in bones}
    out_f = 0
    n_out = int((f1 - f0) / rate) + 1
    for i in range(n_out):
        sf = f0 + i * rate
        sc.frame_set(int(sf), subframe=sf - int(sf))
        Rs = {k: rot_of(src.matrix_world @ src.pose.bones[snames[k]].matrix) for k in LOGICAL}
        want = {}
        for k in LOGICAL:
            D = q_yaw @ Rs[k] @ Rs0[k].inverted() @ q_yaw.inverted()
            want[tgt_names[k]] = Ainv @ (D @ C[k] @ Rt0[k])  # armature space
        arm_rot = dict(want)
        for b in order:
            parent = arm_rot[par[b.name]] if par[b.name] else Quaternion()
            ident = parent @ rest_rel[b.name]
            if b.name in want:
                q = ident.inverted() @ want[b.name]
                arm_rot[b.name] = want[b.name]
            else:
                arm_rot[b.name] = ident @ B0[b.name].to_quaternion()
                continue  # (unmapped bones are not keyed: they hold their pose)
            pb = pose[b.name]
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=out_f + 1)
        # The hips: the source's travel from its rest, scaled to his size, turned to his facing.
        s_hip = (src.matrix_world @ src.pose.bones[snames['hips']].matrix).translation
        d = q_yaw @ ((s_hip - s_hip0) * k_len)
        if not root_motion:
            d.x = d.y = 0
        hb = bones[LOC_BONE.get(tgt_names['hips'], tgt_names['hips'])]
        loc = B0[hb.name].to_translation() + rot_of(hb.matrix_local).inverted() @ (Ainv @ d) / max(1e-6, tgt.matrix_world.to_scale()[0])
        pose[hb.name].location = loc
        pose[hb.name].keyframe_insert('location', frame=out_f + 1)
        out_f += 1
    # Remove the source.
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    return action, out_f

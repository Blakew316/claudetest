"""The 25-second fight, shot by shot (24 fps, frames 1-600): clips, placement, aimed arms, cameras with cuts.
Effects, the arena and the film look come from fx.py, env.py and film.py when they are present."""
import bpy, sys, os, math, importlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector, Euler
import scene as S
import retarget as rt
import anim as A

SP = '/tmp/claude-0/-home-user-claudetest/1ca86f98-efae-51e1-a103-bd6371f97c5d/scratchpad/'
MIX = SP + 'mocap_zip/'
P05 = SP + 'packs/combat/Combat Essentials #U2013 Fight Mocap Pack/'
T05 = SP + 'packs/fight10/Fight Animation Mocap Pack (10 Animations) thumb/'
NEW = SP + 'mixamo_new/'  # the upright Thanos clips (Standing Idle, Walking, Punching) once they arrive


def have(mod):
    try:
        return importlib.import_module(mod)
    except Exception as e:
        print('(no', mod, '-', e, ')')
        return None


def first(*paths):
    for p in paths:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(paths)


def build(preview=True):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 24
    sc.frame_start, sc.frame_end = 1, 600
    env, film, fx, chars = have('env'), have('film'), have('fx'), have('chars')
    (ir, iron, iobjs), (tr, th, tobjs) = S.fighters()
    if chars:
        chars.apply_iron(iobjs)
        chars.apply_thanos(tobjs)
    IM_YAW, TH_YAW = ir.rotation_euler.z, tr.rotation_euler.z
    if env:
        env.build_arena(sc)
        env.arena_lights(sc)
    else:
        S.space(sc)
        bpy.ops.mesh.primitive_plane_add(size=40)
        S.light(sc, 'key', 'SUN', 4.0, (0, 0, 10), (0.75, 0.25, -0.9), (1.0, 0.93, 0.85))
        S.light(sc, 'rim', 'AREA', 1500, (6, 6, 5), (-0.9, 0, 2.4), (0.6, 0.6, 1.0), 4)

    # ---------- motion ----------
    clip = lambda arm, names, path, name, rng=None, rate=1.25, rm=True: A.clip(arm, names, path, name, rng, rate, rm)[0]
    # Thanos.
    th_idle = clip(th, rt.THANOS, first(NEW + 'Standing Idle.fbx', P05 + '05_04_009_single hand idle.fbx'), 'TH_idle', rm=False)
    th_think = clip(th, rt.THANOS, T05 + '05_02_015_Fight taunt think.fbx', 'TH_think', rm=False)
    # (Played a touch slow: heavy and deliberate; 3.8 units a stride cycle of 31/0.8 frames.)
    th_walk = clip(th, rt.THANOS, first(NEW + 'Walking.fbx', MIX + 'Mutant Walking.fbx'), 'TH_walk', rate=0.8, rm=False)
    th_punch = clip(th, rt.THANOS, first(NEW + 'Punching.fbx', MIX + 'Hook Punch.fbx'), 'TH_punch', rm=False)
    # Iron Man.
    im_fly = clip(iron, rt.IRON, MIX + 'Flying.fbx', 'IM_fly', rm=False)
    im_land = clip(iron, rt.IRON, MIX + 'Hard Landing.fbx', 'IM_land')
    im_guard = clip(iron, rt.IRON, P05 + '05_04_003_idle_L.fbx', 'IM_guard', rm=False)
    im_hit = clip(iron, rt.IRON, T05 + '05_01_004_Hit_punch_R_03.fbx', 'IM_hit', (15, 120))
    im_down = clip(iron, rt.IRON, MIX + 'Knocked Down.fbx', 'IM_down')
    im_up = clip(iron, rt.IRON, MIX + 'Getting Up.fbx', 'IM_up')
    im_hover = clip(iron, rt.IRON, MIX + 'Floating.fbx', 'IM_hover', rate=1.0, rm=False)
    im_fall = clip(iron, rt.IRON, MIX + 'Falling Idle.fbx', 'IM_fall', rm=False)

    # Thanos's timeline: idle, the hand-to-chin study, idle, the walk in, the backhand, idle under the beam,
    # the blast, the walk again.
    A.place(th, th_idle, 1, track='th_base', repeat=3)
    A.place(th, th_think, 82, blend_in=6, blend_out=8, track='th_b')
    A.place(th, th_walk, 160, blend_in=8, blend_out=6, track='th_walk', repeat=1.8)
    A.place(th, th_punch, 226, blend_in=4, blend_out=8, track='th_punch')
    A.place(th, th_idle, 270, track='th_idle2', repeat=4)
    A.place(th, th_walk, 520, blend_in=8, blend_out=8, track='th_walk2', repeat=1.4)
    A.place(th, th_idle, 566, blend_in=8, track='th_idle3', repeat=1)
    # Iron Man's: flying in, the hard landing, the guard, the hit, knocked down, up, hovering, falling, up.
    A.place(iron, im_fly, 1, track='im_fly', repeat=2)
    A.place(iron, im_land, 49, track='im_land')
    A.place(iron, im_guard, 92, blend_in=8, track='im_guard', repeat=3)
    A.place(iron, im_hit, 232, blend_in=2, track='im_hit')
    A.place(iron, im_down, 262, blend_in=4, track='im_down')
    A.place(iron, im_up, 296, blend_in=6, track='im_up')
    A.place(iron, im_hover, 330, blend_in=8, track='im_hover', repeat=2)
    A.place(iron, im_fall, 478, blend_in=3, track='im_fall', repeat=2)
    A.place(iron, im_up, 506, blend_in=4, track='im_up2')
    A.place(iron, im_guard, 566, blend_in=8, track='im_guard2')

    # ---------- placement ----------
    K = A.key_root
    # Walking at his stride's own speed (3.8 / (31 / 0.8) units a frame), so his feet stay planted.
    TZ = tr.location.z  # (his root sits off the ground so his feet are on it)
    TH0 = Vector((6.0, 0, TZ))
    v = 3.8 / (31 / 0.8)
    K(tr, 1, TH0, TH_YAW, 'CONSTANT')
    K(tr, 160, TH0, TH_YAW, 'LINEAR')
    K(tr, 228, TH0 + Vector((-v * 68, 0, 0)), TH_YAW, 'CONSTANT')  # in on him, within reach (x ~ -0.65)
    TH1 = TH0 + Vector((-v * 68, 0, 0))
    K(tr, 385, TH1, TH_YAW, 'BEZIER')
    K(tr, 410, TH1 + Vector((1.0, 0, 0)), TH_YAW, 'CONSTANT')  # driven back a step by the beam
    TH2 = TH1 + Vector((1.0, 0, 0))
    K(tr, 520, TH2, TH_YAW, 'LINEAR')
    K(tr, 572, TH2 + Vector((-v * 52, 0, 0)), TH_YAW, 'CONSTANT')
    IM0 = Vector((-3.0, 0, 0))
    # Flying in from far off and high, toward the landing spot.
    fly_from, fly_to = Vector((-30, 9, 9.5)), Vector((-6.5, 1.5, 4.0))
    d = (fly_to - fly_from).normalized()
    K(ir, 1, fly_from, IM_YAW + math.atan2(d.y, d.x), 'LINEAR')
    K(ir, 48, fly_to, IM_YAW + math.atan2(d.y, d.x), 'CONSTANT')
    K(ir, 49, IM0, IM_YAW, 'CONSTANT')
    K(ir, 262, IM0, IM_YAW, 'CONSTANT')  # (knocked down: the clip carries him back)
    K(ir, 326, IM0 + Vector((-2.4, 0, 0)), IM_YAW, 'BEZIER')
    K(ir, 344, IM0 + Vector((-2.4, 0, 4.6)), IM_YAW, 'BEZIER')
    K(ir, 476, IM0 + Vector((-2.4, 0, 4.8)), IM_YAW, 'LINEAR')
    K(ir, 505, IM0 + Vector((-4.6, 0, 0)), IM_YAW + 2.4, 'CONSTANT')  # blasted down, spinning
    K(ir, 506, IM0 + Vector((-4.6, 0, 0)), IM_YAW, 'CONSTANT')

    # ---------- aimed arms ----------
    th_chest = lambda f: th.matrix_world @ th.pose.bones['Chest_M_013'].head + Vector((0, 0, 0.2))
    gaunt = lambda f: th.matrix_world @ th.pose.bones['Wrist_L_083'].head
    im_chest = lambda f: iron.matrix_world @ iron.pose.bones['DEF-spine003'].head
    # Iron Man: both palms on Thanos while he fires (shots 4-6), and down at him from the air (shot 10).
    A.aim_arm(iron, 'iron', 'L', 128, 226, th_chest, ramp=6)
    A.aim_arm(iron, 'iron', 'R', 132, 226, th_chest, ramp=6)
    A.aim_arm(iron, 'iron', 'L', 346, 392, th_chest, ramp=5)
    A.aim_arm(iron, 'iron', 'R', 346, 392, th_chest, ramp=5)
    # Thanos: the gauntlet up into the blasts as he walks in (5-6), and into the beam (10-11), then out at him (12-13).
    to_im = lambda f: (im_chest(f) - gaunt(f)).normalized()
    A.aim_arm(th, 'thanos', 'L', 152, 224, im_chest, upper_dir=lambda f: Vector((-0.75, 0.45, -0.25)),
              fore_dir=lambda f: Vector((-0.2, -0.1, 1.0)), palm_dir=lambda f: Vector((-1, 0, 0.15)), ramp=6)
    A.aim_arm(th, 'thanos', 'L', 352, 418, im_chest, upper_dir=lambda f: Vector((-0.7, 0.4, 0.15)),
              fore_dir=lambda f: Vector((-0.55, 0.0, 0.85)), palm_dir=to_im, ramp=6)
    A.aim_arm(th, 'thanos', 'L', 436, 486, im_chest, ramp=8)

    # ---------- cameras (each bound at its cut, framed on where they actually are) ----------
    cams = []

    def at(arm, bone, f):
        sc.frame_set(f)
        return (arm.matrix_world @ arm.pose.bones[bone].head).copy()

    def sph(az, el, dist):
        az, el = math.radians(az), math.radians(el)
        return Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))) * dist

    def shot(frame, name, loc, target, lens, fstop=2.8, moves=None):
        # (Never below the rock's surface.)
        loc = Vector((loc.x, loc.y, max(loc.z, 0.35)))
        if moves:
            moves = [(f, Vector((l.x, l.y, max(l.z, 0.35))), t) for f, l, t in moves]
        if film:
            cam = film.shot_camera(sc, name, loc, target, lens, fstop, None)
        else:
            cam = S.camera(sc, name, loc, target, lens)
        if moves:
            for f, l, t in moves:
                cam.location = l
                S.look_at(cam, t)
                cam.keyframe_insert('location', frame=f)
                cam.keyframe_insert('rotation_euler', frame=f)
        m = sc.timeline_markers.new(name, frame=frame)
        m.camera = cam
        cams.append((frame, cam))
        return cam

    IMC, IMH, IMS = 'DEF-spine003', 'DEF-spine006', 'DEF-spine'  # Iron Man: chest, head, hips
    THC, THH, THG = 'Chest_M_013', 'Head_M_046', 'Wrist_L_083'  # Thanos: chest, head, gauntlet
    # 1 Wide: Thanos waiting on the rock; Iron Man streaking in from high on the left.
    c = at(th, THC, 24)
    m1, m48 = c.lerp(at(iron, IMC, 1), 0.3), c.lerp(at(iron, IMC, 48), 0.4)
    shot(1, 's01_wide', c + sph(-118, 3, 21), m1, 20,
         moves=[(1, c + sph(-118, 3, 21), m1), (48, c + sph(-115, 3, 19.5), m48)])
    # 2 Low angle on the landing.
    c = at(iron, IMS, 58)
    shot(49, 's02_land', c + sph(-58, -1, 4.6) + Vector((0, 0, -0.5)), c + Vector((0, 0, 0.3)), 26)
    # 3 Close on Thanos, a little below his eye line: imposing.
    c = at(th, THH, 100)
    shot(85, 's03_thanos', c + sph(202, -6, 2.6), c + Vector((0, 0, -0.15)), 85, 2.0)
    # 4 Over Thanos's right shoulder onto Iron Man raising his palms.
    sh, ch = at(th, 'Shoulder_R_015', 140), at(th, THC, 140)
    t = at(iron, IMC, 150)
    back = Vector((sh.x - t.x, sh.y - t.y, 0)).normalized()
    out = Vector((sh.x - ch.x, sh.y - ch.y, 0)).normalized()
    shot(121, 's04_ots', sh + back * 1.6 + out * 0.55 + Vector((0, 0, 0.35)), t, 40, 4.0)
    # 5 Side-on: the blasts striking the gauntlet as he starts in.
    a_, b_ = at(iron, IMC, 180), at(th, THC, 180)
    m_ = (a_ + b_) / 2
    shot(157, 's05_side', m_ + sph(-90, 3, max(8.5, (b_ - a_).length * 1.05)), m_, 35)
    # 6 Tracking alongside him, waist up, as he walks through the fire.
    p0, p1 = at(th, THC, 193), at(th, THC, 228)
    shot(193, 's06_track', p0 + Vector((1.4, -4.2, 0.1)), p0 + Vector((-1.2, 0, 0)), 45,
         moves=[(193, p0 + Vector((1.4, -4.2, 0.1)), p0 + Vector((-1.2, 0, 0))), (228, p1 + Vector((1.4, -4.2, 0.1)), p1 + Vector((-1.2, 0, 0)))])
    # 7 The backhand landing, close.
    a_, b_ = at(iron, IMH, 238), at(th, 'Wrist_R_021', 237)
    m_ = (a_ + b_) / 2
    shot(229, 's07_close', m_ + sph(-72, 2, 4.2), m_, 40, 2.8)
    # 8 Wide: thrown back across the rock.
    c = at(iron, IMS, 285)
    shot(265, 's08_wide', c + sph(-100, 6, 10.5), c + Vector((1.0, 0, 0.6)), 28)
    # 9 Low: up off the ground and lifting off.
    c = at(iron, IMS, 318)
    shot(301, 's09_up', c + sph(-55, -8, 6.2), c + Vector((0, 0, 1.0)), 24)
    # 10 From behind him in the air, down onto Thanos.
    c, t = at(iron, IMC, 362), at(th, THC, 362)
    shot(337, 's10_air', c + Vector((-5.0, -2.6, 2.2)), t, 32)
    # 11 Low in front of Thanos as he takes the beam.
    c = at(th, THC, 400)
    shot(385, 's11_braced', c + sph(235, -8, 5.6), c + Vector((0, 0, 0.3)), 28)
    # 12 Close on the gauntlet: the Power Stone.
    c = at(th, THG, 450)
    shot(421, 's12_stone', c + sph(232, 6, 3.8), c + Vector((0, 0, 0.15)), 70, 2.2)
    # 13 Wide: the blast takes him out of the sky.
    a_, b_ = at(iron, IMC, 482), at(th, THG, 476)
    m_ = (a_ + b_) / 2
    shot(469, 's13_blast', m_ + sph(-95, 6, max(11, (b_ - a_).length * 1.2)), m_, 28)
    # 14 Behind him as he gets up, Thanos walking in.
    c, t = at(iron, IMC, 545), at(th, THC, 545)
    shot(517, 's14_rise', c + Vector((-3.4, -1.5, -0.3)), t, 40)
    # 15 Final wide: face to face.
    a_, b_ = at(iron, IMC, 590), at(th, THC, 590)
    m_ = (a_ + b_) / 2
    shot(565, 's15_final', m_ + sph(-90, 5, 12.5), m_, 30,
         moves=[(565, m_ + sph(-90, 5, 12.5), m_), (600, m_ + sph(-90, 5, 10.8), m_)])
    sc.camera = cams[0][1]

    # ---------- effects ----------
    if fx:
        try:
            fx_moments(sc, fx, iron, th, im_chest, th_chest, gaunt)
        except Exception as e:  # (the effects kit is still being built: keep the animatic going)
            import traceback
            traceback.print_exc()
    if film:
        film.grade(sc)
    S.render_settings(sc, 960, 540, 16) if preview else None
    return sc, (ir, iron), (tr, th)


def fx_moments(sc, fx, iron, th, im_chest, th_chest, gaunt):
    """Where the effects go (see fx.py)."""
    land = Vector((-3.0, 0, 0))
    fx.thrusters(sc, iron, ['DEF-footL', 'DEF-footR', 'DEF-handL', 'DEF-handR'], 1, 56, [(1, 1.0), (48, 1.2), (54, 0.0)])
    fx.dust_burst(sc, land, 55, 2.6)
    fx.ground_crack(sc, land, 55, 1.6)
    fx.repulsor_charge(sc, iron, 'DEF-handL', 128, 148)
    fx.repulsor_charge(sc, iron, 'DEF-handR', 132, 154)
    for i, (h, f) in enumerate((('DEF-handL', 148), ('DEF-handR', 154), ('DEF-handL', 168), ('DEF-handR', 176), ('DEF-handL', 198), ('DEF-handR', 207), ('DEF-handL', 216))):
        fx.repulsor_shot(sc, iron, h, gaunt(f), f, f + 4, 0.8)
    fx.impact(sc, Vector((-1.9, 0, 3.2)), 246, 0.6)
    fx.dust_burst(sc, Vector((-5.0, 0, 0)), 280, 1.4)
    fx.thrusters(sc, iron, ['DEF-footL', 'DEF-footR', 'DEF-handL', 'DEF-handR'], 322, 478, [(322, 0.0), (330, 1.3), (342, 1.0), (470, 0.9), (478, 0.0)])
    fx.repulsor_charge(sc, iron, 'DEF-handL', 346, 360)
    fx.repulsor_shot(sc, iron, 'DEF-handL', th_chest(362), 360, 366, 2.0)
    fx.repulsor_shot(sc, iron, 'DEF-handR', th_chest(362), 361, 367, 2.0)
    fx.ground_crack(sc, Vector((-0.2, 0, 0)), 390, 1.4)
    fx.power_stone(sc, th, 'Wrist_L_083', 421, 486)
    fx.stone_blast(sc, th, 'Wrist_L_083', im_chest(478), 472, 478)
    fx.dust_burst(sc, Vector((-7.6, 0, 0)), 505, 2.2)
    fx.ground_crack(sc, Vector((-7.6, 0, 0)), 505, 1.2)


if __name__ == '__main__':
    sc, _, _ = build()
    bpy.ops.wm.save_as_mainfile(filepath=SP + 'cine/fight.blend')

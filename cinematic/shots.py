"""The fight: 25 s (600 frames at 24 fps) in 23 shots, in the manner of the Titan fight.

 1  1-30    Iron Man streaks in low over the rock, repulsors firing (chase camera).
 2  31-48   Thanos takes the blasts on the gauntlet (close).
 3  49-66   Iron Man lands hard (low wide).
 4  67-90   Thanos leaps (low angle, looking up).
 5  91-112  He crashes down where Iron Man was; Iron Man rolls clear (wide).
 6  113-131 Iron Man up on one knee; the arm cannon forms (close).
 7  132-150 Point-blank cannon blast; Thanos driven back (over the shoulder).
 8  151-176 Thanos comes back swinging: a hook, slipped (two-shot, handheld).
 9  177-198 The second punch lands: Iron Man's head snaps round (close).
10  199-234 A huge overhead swing; the nano shield takes it (low, behind Iron Man).
11  235-252 The nano blade forms (close).
12  253-282 The slash; Thanos catches the blade in the gauntlet and snaps it (tight two-shot).
13  283-300 Thanos's punch to the chest (close).
14  301-330 Iron Man blown back spinning; boosters catch him in the air (wide).
15  331-354 He climbs and turns (from below).
16  355-378 The dive, a hammer fist forming (toward the camera).
17  379-410 The hammer comes down on Thanos (low, tight).
18  411-450 Thanos straightens; the Power Stone flares (close on the gauntlet).
19  451-486 The Stone's blast: the shield breaks, Iron Man thrown across the rock (wide).
20  487-540 Iron Man up, cannons on both arms; Thanos walking in (behind Iron Man).
21  541-556 Iron Man (close).
22  557-572 Thanos (close).
23  573-600 Both charge; the impact flash, then black.

Placement: each character's root empty is keyed per beat (CONSTANT at the cuts, which hide any jump), the clips
carry their own travel within a beat, and each blow is lined up so the fist meets what it hits."""
import bpy, sys, os, math, importlib, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector
import scene as S
import retarget as rt
import anim as A
import paths

SP = paths.CLOUD  # (cloud workspace: where previews are written)
CUTS = [1, 31, 49, 67, 91, 113, 132, 151, 177, 199, 235, 253, 283, 301, 331, 355, 379, 411, 451, 487, 541, 557, 573]


def have(mod):
    try:
        return importlib.import_module(mod)
    except Exception as e:
        print('(no', mod, '-', e, ')')
        return None


def build(preview=True):
    (ir, iron, iobjs), (tr, th, tobjs) = S.fighters()  # (opens Thanos's file as the scene)
    sc = bpy.context.scene
    sc.render.fps = 24
    sc.frame_start, sc.frame_end = 1, 600
    env, film, fx = have('env'), have('film'), have('fx')
    S.live(iobjs + tobjs, False)  # (motion first: only the armatures are evaluated)
    IM_YAW, TH_YAW = ir.rotation_euler.z, tr.rotation_euler.z
    IZ, TZ = ir.location.z, tr.location.z  # (root heights that put their feet on the ground)
    if env:
        env.build_arena(sc)
        env.arena_lights(sc)
    else:
        S.space(sc)
    I, T = rt.IRON, rt.THANOS
    K = A.key_root

    # ---------- clips (30 fps capture at film speed unless said) ----------
    def clip(arm, names, name, label, rng=None, rate=1.25, rm=True):
        return A.clip(arm, names, paths.clip(name), label, rng, rate, rm)[0]

    th_idle = clip(th, T, 'Standing Idle.fbx', 'TH_idle', rm=False)
    th_jump = clip(th, T, 'Mutant Jump Attack.fbx', 'TH_jump')
    th_gut = clip(th, T, 'Big Stomach Hit.fbx', 'TH_gut', rm=False)
    th_hook = clip(th, T, 'Hook Punch.fbx', 'TH_hook', rm=False)
    th_jab = clip(th, T, 'Mutant Punch.fbx', 'TH_jab', rm=False)
    th_swing = clip(th, T, 'Mutant Swiping.fbx', 'TH_swing', rm=False)
    th_cross = clip(th, T, 'Cross Punch.fbx', 'TH_cross', rm=False)
    th_reel = clip(th, T, 'Receiving A Big Uppercut.fbx', 'TH_reel')
    th_walk = clip(th, T, 'Walking.fbx', 'TH_walk', rate=0.8, rm=False)

    im_fly = clip(iron, I, 'Flying.fbx', 'IM_fly', rm=False)
    im_land = clip(iron, I, 'Hard Landing.fbx', 'IM_land')
    im_roll = clip(iron, I, 'RM_Roll_back.fbx', 'IM_roll')
    im_guard = clip(iron, I, '05_04_003_idle_L.fbx', 'IM_guard', rm=False)
    im_cast = clip(iron, I, 'Standing 1H Magic Attack 01.fbx', 'IM_cast', rm=False)
    im_dodge = clip(iron, I, 'Dodging.fbx', 'IM_dodge', rm=False)
    im_headhit = clip(iron, I, 'Head Hit.fbx', 'IM_headhit', rm=False)
    im_block = clip(iron, I, 'Sword And Shield Block.fbx', 'IM_block', rm=False)
    im_blockhold = clip(iron, I, 'Sword And Shield Block Idle.fbx', 'IM_blockhold', rm=False)
    im_slash = clip(iron, I, 'Sword And Shield Slash (2).fbx', 'IM_slash', rm=False)
    im_spin = clip(iron, I, 'Shoved Reaction With Spin.fbx', 'IM_spin')
    im_hover = clip(iron, I, 'Floating.fbx', 'IM_hover', rate=1.0, rm=False)
    im_smash = clip(iron, I, 'Standing Melee Attack Downward.fbx', 'IM_smash', rm=False)
    im_down = clip(iron, I, 'Knocked Down.fbx', 'IM_down')
    im_up = clip(iron, I, 'Getting Up.fbx', 'IM_up', (20, 81))
    im_lunge = clip(iron, I, 'Sword And Shield Attack.fbx', 'IM_lunge', rm=False)

    # ---------- the NLA: what each plays when ----------
    # (A clip that carries him somewhere hands over on a cut, or at a frame where his root takes up its travel.)
    P = A.place
    P(th, th_idle, 1, track='th_base', repeat=8)
    P(th, th_jump, 58, blend_in=4, track='th_jump')
    P(th, th_hook, 156, blend_in=4, blend_out=4, track='th_hook')
    P(th, th_jab, 181, blend_in=3, blend_out=6, track='th_jab')
    P(th, th_swing, 200, blend_in=4, blend_out=8, track='th_swing')
    P(th, th_cross, 276, blend_in=4, blend_out=8, track='th_cross')
    P(th, th_walk, 492, blend_in=8, blend_out=6, track='th_walk', repeat=1.6)
    P(th, th_jab, 576, blend_in=3, track='th_charge')

    P(iron, im_guard, 1, track='im_base', repeat=8)
    P(iron, im_fly, 1, track='im_fly', repeat=1)
    P(iron, im_land, 44, track='im_land')
    s_roll = P(iron, im_roll, 88, track='im_roll')
    cast0 = int(s_roll.frame_end) + 1
    P(iron, im_cast, cast0, blend_out=6, track='im_cast')
    P(iron, im_dodge, 164, blend_in=3, blend_out=3, track='im_dodge')
    P(iron, im_headhit, 187, blend_in=1, blend_out=6, track='im_headhit')
    P(iron, im_block, 208, blend_in=2, track='im_block')
    P(iron, im_blockhold, 224, blend_in=3, blend_out=6, track='im_blockhold', repeat=2)
    P(iron, im_slash, 246, blend_in=4, blend_out=6, track='im_slash')
    P(iron, im_spin, 290, blend_in=1, track='im_spin')
    P(iron, im_hover, 312, blend_in=8, blend_out=6, track='im_hover', repeat=3)
    P(iron, im_fly, 330, blend_in=6, blend_out=4, track='im_fly2', repeat=1)
    P(iron, im_smash, 374, blend_in=4, blend_out=8, track='im_smash')
    P(iron, im_block, 452, blend_in=2, blend_out=2, track='im_block2')
    P(iron, im_down, 463, blend_in=1, track='im_down')
    P(iron, im_up, 487, track='im_up')  # (on the cut: up from partway through getting up)
    P(iron, im_lunge, 574, blend_in=3, track='im_lunge')

    # ---------- where they are ----------
    def bone_at(arm, bone, f):
        sc.frame_set(f)
        return (arm.matrix_world @ arm.pose.bones[bone].head).copy()

    def hips(arm, f):
        return bone_at(arm, (I if arm is iron else T)['hips'], f)

    def carry(root, arm, f, yaw):
        """At a switch of clips at frame f, key his root so his hips don't jump (the outgoing clip's travel
        becomes his new place)."""
        d = hips(arm, f - 1) - hips(arm, f)
        d.z = 0
        K(root, f, root.location.copy() + d, yaw, 'CONSTANT')

    def lowest(arm, f0, f1):
        """The frame his hips are lowest (a landing) between f0 and f1."""
        return min(range(f0, f1 + 1), key=lambda f: hips(arm, f).z)

    def reach_frame(arm, names, f0, f1, side=None):
        """The frame and hand of a blow: the hand furthest out ahead of his chest between f0 and f1."""
        best = (-1e9, f0, 'handR')
        fwd = Vector((1, 0, 0)) if arm is iron else Vector((-1, 0, 0))
        for f in range(f0, f1 + 1):
            sc.frame_set(f)
            ch = arm.matrix_world @ arm.pose.bones[names['chest']].head
            for h in (['handL', 'handR'] if side is None else [side]):
                p = arm.matrix_world @ arm.pose.bones[names[h]].head
                v = (p - ch).dot(fwd)
                if v > best[0]:
                    best = (v, f, h)
        return best[1], best[2]

    def shift(root, f0, f1, d):
        """Move his root's keys between f0 and f1 by d."""
        for fc in A.fcurves_of(root.animation_data.action):
            if fc.data_path == 'location':
                for kp in fc.keyframe_points:
                    if f0 <= kp.co[0] <= f1:
                        kp.co[1] += d[fc.array_index]
                        kp.handle_left[1] += d[fc.array_index]
                        kp.handle_right[1] += d[fc.array_index]
                fc.update()

    def line_up(root, arm, names, f0, f1, target, keys, side=None):
        """Shift his root (keys between keys[0] and keys[1], along x) so his blow lands on target(f); returns the
        frame it lands."""
        f, h = reach_frame(arm, names, f0, f1, side)
        p = bone_at(arm, names[h], f)
        shift(root, keys[0], keys[1], Vector((target(f).x - p.x, 0, 0)))
        return f

    when = {}
    # 1: in fast and low from far off on the left, toward his landing spot.
    TH_A = Vector((1.6, 0.0, TZ))
    K(tr, 1, TH_A, TH_YAW, 'CONSTANT')
    IM_A = Vector((-3.4, 0.0, IZ))
    fly_from, fly_to = Vector((-26, 7.5, 6.5)), Vector((-6.0, 1.0, 2.2))
    d = (fly_to - fly_from).normalized()
    K(ir, 1, fly_from, IM_YAW + math.atan2(d.y, d.x), 'LINEAR')
    K(ir, 43, fly_to, IM_YAW + math.atan2(d.y, d.x), 'CONSTANT')
    K(ir, 44, IM_A, IM_YAW, 'CONSTANT')
    when['im_land'] = lowest(iron, 46, 70)
    # 4-5: Thanos's leap comes down on the spot he landed on; Iron Man rolls back out from under it.
    when['th_land'] = lowest(th, 80, 140)
    p = hips(th, when['th_land'])
    shift(tr, 1, 1, Vector((IM_A.x + 0.4 - p.x, 0, 0)))
    carry(ir, iron, 88, IM_YAW)  # (the landing's travel kept as the roll starts)
    carry(ir, iron, cast0, IM_YAW)  # (where the roll left him)
    # 7: the cannon hits him and drives him back a step and a half.
    when['cannon'] = reach_frame(iron, I, cast0 + 4, cast0 + 40, 'handR')[0]
    P(th, th_gut, when['cannon'], track='th_gut', blend_out=6)
    carry(tr, th, when['cannon'], TH_YAW)  # (where the leap left him)
    th_at = tr.location.copy()
    K(tr, when['cannon'] + 12, th_at + Vector((1.4, 0, 0)), TH_YAW, 'BEZIER')
    # 8-9: back in on him: the hook (slipped), then the second punch lands on his head.
    K(tr, 156, th_at + Vector((1.4, 0, 0)), TH_YAW, 'BEZIER')
    K(tr, 168, th_at + Vector((0.3, 0, 0)), TH_YAW, 'CONSTANT')
    when['jab'] = line_up(tr, th, T, 181, 196, lambda f: bone_at(iron, I['head'], f), (168, 168))
    # 10: the overhead swing onto the shield (on his left forearm).
    K(tr, 199, tr.location.copy(), TH_YAW, 'CONSTANT')
    when['swing'] = line_up(tr, th, T, 205, 240, lambda f: bone_at(iron, I['foreL'], f) + Vector((0, 0, 0.4)), (199, 199))
    # 12: the slash, caught (Iron Man placed on the cut).
    K(ir, 253, ir.location.copy(), IM_YAW, 'CONSTANT')
    when['slash'] = line_up(ir, iron, I, 253, 275, lambda f: bone_at(th, T['handL'], f), (253, 253), 'handR')
    # 13: the punch to his chest.
    K(tr, 283, tr.location.copy(), TH_YAW, 'CONSTANT')
    when['cross'] = line_up(tr, th, T, 283, 305, lambda f: bone_at(iron, I['chest'], f), (283, 283))
    # 14: blown back spinning (the clip carries him), then boosters: up into the air.
    carry(ir, iron, 312, IM_YAW)
    up0 = ir.location.copy()
    K(ir, 314, up0, IM_YAW, 'BEZIER')
    K(ir, 330, up0 + Vector((-1.5, 0, 3.4)), IM_YAW, 'BEZIER')
    # 15-16: the climb, the turn and the dive back down onto Thanos.
    th_now = tr.location.copy()
    K(ir, 352, up0 + Vector((-5.0, 2.5, 8.0)), IM_YAW + 0.6, 'BEZIER')
    K(ir, 366, up0 + Vector((-4.0, 1.2, 6.5)), IM_YAW, 'BEZIER')
    smash_at = Vector((th_now.x - 2.2, 0, IZ))
    K(ir, 378, smash_at + Vector((-0.6, 0, 1.6)), IM_YAW, 'LINEAR')
    K(ir, 386, smash_at, IM_YAW, 'CONSTANT')
    when['smash'] = line_up(ir, iron, I, 380, 405, lambda f: bone_at(th, T['head'], f), (386, 386), 'handR')
    # 17-18: the hammer drives Thanos back (the reel carries him; it runs to the cut at 451).
    reel0 = when['smash']
    s_reel = P(th, th_reel, reel0, track='th_reel')
    s_reel.frame_end = min(s_reel.frame_end, 450)
    carry(tr, th, 451, TH_YAW)
    # 19: the Stone's blast throws Iron Man back across the rock; up again on the cut.
    carry(ir, iron, 463, IM_YAW)
    carry(ir, iron, 487, IM_YAW)
    # 20: Thanos walks in at his stride's own speed (3.8 per 31 frames of the clip at 0.8).
    v = 3.8 / (31 / 0.8)
    t0 = tr.location.copy()
    K(tr, 492, t0, TH_YAW, 'LINEAR')
    K(tr, 548, t0 + Vector((-v * 56, 0, 0)), TH_YAW, 'CONSTANT')
    # 23: both charge; the blows meet between them.
    carry(ir, iron, 536, IM_YAW)  # (where getting up left him)
    t1, i1 = tr.location.copy(), ir.location.copy()
    K(tr, 574, t1, TH_YAW, 'BEZIER')
    K(ir, 574, i1, IM_YAW, 'BEZIER')
    meet = (t1.x + i1.x) / 2
    K(tr, 590, Vector((meet + 1.6, t1.y, t1.z)), TH_YAW, 'CONSTANT')
    K(ir, 590, Vector((meet - 1.4, i1.y, i1.z)), IM_YAW, 'CONSTANT')

    # ---------- arms aimed over the capture ----------
    th_chest = lambda f: bone_at(th, T['chest'], f) + Vector((0, 0, 0.2))
    gaunt = lambda f: bone_at(th, T['handL'], f)
    im_chest = lambda f: bone_at(iron, I['chest'], f)
    to_im = lambda f: (im_chest(f) - gaunt(f)).normalized()
    # Iron Man's palm on the gauntlet as he comes in firing; Thanos's gauntlet up into it.
    A.aim_arm(iron, 'iron', 'L', 6, 36, gaunt, ramp=4)
    A.aim_arm(th, 'thanos', 'L', 26, 50, im_chest, upper_dir=lambda f: Vector((-0.75, 0.45, -0.25)),
              fore_dir=lambda f: Vector((-0.2, -0.1, 1.0)), palm_dir=to_im, ramp=5)
    # The cannon arm (right) on his chest.
    A.aim_arm(iron, 'iron', 'R', 128, 148, th_chest, ramp=5)
    # The blade caught: the gauntlet closes on Iron Man's right hand.
    A.aim_arm(th, 'thanos', 'L', 258, 284, lambda f: bone_at(iron, I['handR'], f), ramp=4)
    # The Stone raised, then turned on him.
    A.aim_arm(th, 'thanos', 'L', 418, 448, im_chest, upper_dir=lambda f: Vector((-0.6, 0.35, 0.3)),
              fore_dir=lambda f: Vector((-0.3, 0.0, 1.0)), palm_dir=to_im, ramp=6)
    A.aim_arm(th, 'thanos', 'L', 452, 470, im_chest, ramp=4)
    # Both cannons on him at the end.
    A.aim_arm(iron, 'iron', 'L', 528, 572, th_chest, ramp=6)
    A.aim_arm(iron, 'iron', 'R', 532, 572, th_chest, ramp=6)

    # ---------- cameras ----------
    cams = []

    def at(arm, bone, f):
        return bone_at(arm, (I if arm is iron else T)[bone], f)

    def sph(az, el, dist):
        az, el = math.radians(az), math.radians(el)
        return Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))) * dist

    def shake(cam, f0, f1, amount):
        """Handheld: noise on the camera's turn (radians) for the length of the shot."""
        if amount <= 0:
            return
        for f in (f0, f1):
            cam.keyframe_insert('rotation_euler', frame=f)
        rnd = random.Random(cam.name)
        for fc in A.fcurves_of(cam.animation_data.action):
            if fc.data_path == 'rotation_euler':
                m = fc.modifiers.new('NOISE')
                m.strength = amount
                m.scale = 5.0
                m.phase = rnd.uniform(0, 100)

    def shot(f0, name, loc, target, lens, fstop=2.8, moves=None, handheld=0.012):
        f1 = next((c for c in CUTS if c > f0), 601) - 1
        loc = Vector((loc.x, loc.y, max(loc.z, 0.35)))  # (never below the rock's surface)
        cam = film.shot_camera(sc, name, loc, target, lens, fstop, None) if film else S.camera(sc, name, loc, target, lens)
        if moves:
            prev = None
            for f, l, t in moves:
                cam.location = Vector((l.x, l.y, max(l.z, 0.35)))
                S.look_at(cam, t)
                if prev is not None:
                    e = cam.rotation_euler.copy()
                    e.make_compatible(prev)  # (no spins through a full turn between keys)
                    cam.rotation_euler = e
                prev = cam.rotation_euler.copy()
                cam.keyframe_insert('location', frame=f)
                cam.keyframe_insert('rotation_euler', frame=f)
        shake(cam, f0, f1, handheld)
        m = sc.timeline_markers.new(name, frame=f0)
        m.camera = cam
        cams.append((f0, cam))
        return cam

    def track(arm, bone, f0, f1, off, lens, name, look_off=Vector((0, 0, 0)), handheld=0.012, step=6):
        """A camera riding along with him at an offset, looking at him."""
        moves = []
        for f in list(range(f0, f1, step)) + [f1]:
            p = at(arm, bone, f)
            moves.append((f, p + off, p + look_off))
        return shot(f0, name, moves[0][1], moves[0][2], lens, moves=moves, handheld=handheld)

    # 1 Chase: behind and beside him as he streaks in.
    track(iron, 'chest', 1, 30, Vector((-4.5, -2.2, 0.9)), 28, 's01_chase', handheld=0.02)
    # 2 Close on the gauntlet taking the blasts.
    g = at(th, 'handL', 40)
    shot(31, 's02_gauntlet', g + sph(205, 4, 3.2), g, 60, 2.0)
    # 3 Low wide: the hard landing.
    a_ = at(iron, 'hips', when['im_land'])
    shot(49, 's03_land', a_ + sph(-70, 4, 9.0), a_ + Vector((0, 0, 0.6)), 24)
    # 4 Low angle, looking up: Thanos leaps.
    track(th, 'chest', 67, 90, sph(-115, -12, 7.5), 22, 's04_leap', handheld=0.018)
    # 5 Wide: the crash down, Iron Man rolling clear.
    m_ = (at(th, 'hips', when['th_land']) + at(iron, 'hips', 100)) / 2
    shot(91, 's05_crash', m_ + sph(-95, 8, 9.5), m_ + Vector((0, 0, 0.8)), 26, handheld=0.02)
    # 6 Close: up on one knee, the cannon forming on his right arm.
    c_ = at(iron, 'chest', 124)
    shot(113, 's06_cannon', c_ + sph(-50, 8, 4.4), c_, 40, 4.0)
    # 7 Over his shoulder: the cannon blast into Thanos.
    s_ = at(iron, 'clavR', when['cannon'])
    shot(132, 's07_blast', s_ + Vector((-1.6, -1.1, 0.5)), at(th, 'chest', when['cannon']), 32, handheld=0.015)
    # 8 Two-shot, handheld: the hook, slipped.
    track(iron, 'chest', 151, 176, Vector((1.3, -7.8, 0.6)), 32, 's08_hook', look_off=Vector((1.3, 0, 0.1)), handheld=0.02)
    # 9 Close: the punch lands on his head.
    h_ = at(iron, 'head', when['jab'])
    shot(177, 's09_headhit', h_ + sph(-60, 2, 2.4), h_, 50, 2.0, handheld=0.03)
    # 10 Low behind Iron Man, up at the swing coming down on the shield.
    b_ = at(iron, 'hips', when['swing'])
    shot(199, 's10_shield', b_ + Vector((-2.2, -1.4, -0.2)), at(th, 'head', when['swing']), 22, handheld=0.02)
    # 11 Close: the blade forming on his right arm.
    r_ = at(iron, 'chest', 245)
    shot(235, 's11_blade', r_ + sph(-60, 10, 4.2), r_, 40, 4.0)
    # 12 Tight two-shot: the slash, caught, snapped.
    c_ = at(th, 'handL', when['slash'])
    shot(253, 's12_catch', c_ + sph(-100, 10, 4.2), c_, 40, 2.2, handheld=0.015)
    # 13 Close: the punch to the chest.
    c_ = at(iron, 'chest', when['cross'])
    shot(283, 's13_punch', c_ + sph(-120, 0, 3.4), c_, 45, handheld=0.03)
    # 14 Wide: blown back spinning; the boosters catch him.
    track(iron, 'chest', 301, 330, sph(-95, 8, 8.0), 30, 's14_boost', handheld=0.015)
    # 15 From below as he climbs and turns.
    track(iron, 'chest', 331, 354, Vector((2.5, -3.5, -4.0)), 24, 's15_climb', handheld=0.015)
    # 16 The dive, toward the camera.
    p_ = at(iron, 'chest', 372)
    shot(355, 's16_dive', p_ + Vector((1.8, -1.2, -0.5)), at(iron, 'chest', 360), 26, moves=[
        (355, p_ + Vector((1.8, -1.2, -0.5)), at(iron, 'chest', 355)), (378, p_ + Vector((2.6, -2.0, -0.4)), at(iron, 'chest', 378))],
        handheld=0.02)
    # 17 Low and tight: the hammer comes down on him.
    t_ = at(th, 'chest', when['smash'])
    shot(379, 's17_smash', t_ + sph(-80, -6, 5.5), t_ + Vector((0, 0, 0.6)), 24, handheld=0.03)
    # 18 Close on the gauntlet: the Power Stone flares.
    g = at(th, 'handL', 435)
    shot(411, 's18_stone', g + sph(230, 6, 4.6), g + Vector((0, 0, 0.1)), 55, 4.0, moves=[
        (411, g + sph(230, 6, 5.2), g), (450, g + sph(230, 6, 4.2), g)])
    # 19 Wide: the blast, the shield breaking, thrown across the rock.
    m_ = (at(th, 'chest', 466) + at(iron, 'chest', 470)) / 2
    shot(451, 's19_stoneblast', m_ + sph(-95, 7, 13.0), m_, 28, handheld=0.02)
    # 20 Behind Iron Man as he gets up, Thanos walking in.
    c_, t_ = at(iron, 'chest', 520), at(th, 'chest', 520)
    shot(487, 's20_rise', c_ + Vector((-3.4, -1.5, -0.3)), t_, 40)
    # 21-22 Close on each.
    h_ = at(iron, 'head', 548)
    shot(541, 's21_iron', h_ + sph(40, 2, 2.8), h_, 50, 2.8)
    h_ = at(th, 'head', 564)
    shot(557, 's22_thanos', h_ + sph(140, -4, 3.4), h_, 50, 2.8)
    # 23 Both charge; the impact.
    m_ = (at(th, 'chest', 586) + at(iron, 'chest', 586)) / 2
    shot(573, 's23_charge', m_ + sph(-90, 3, 7.5), m_, 24, handheld=0.03)
    sc.camera = cams[0][1]

    # ---------- effects ----------
    if fx:
        moments(sc, fx, iron, th, bone_at, when)
    if film:
        film.grade(sc)
    S.render_settings(sc, 960, 540, 16) if preview else None
    S.live(iobjs + tobjs, True)  # (back in the viewport: the saved scene shows them in Blender)
    return sc, (ir, iron), (tr, th)


def moments(sc, fx, iron, th, bone_at, when):
    """Shots, hits, dust and cracks at their frames (each on its own: one failing doesn't stop the rest)."""
    I, T = rt.IRON, rt.THANOS

    def go(fn, *a, **k):
        try:
            fn(*a, **k)
        except Exception as e:
            import traceback
            print('(effect skipped:', fn.__name__, e, ')')
            traceback.print_exc()

    gaunt = lambda f: bone_at(th, T['handL'], f)
    th_chest = lambda f: bone_at(th, T['chest'], f)
    go(fx.thrusters, sc, iron, [I['footL'], I['footR'], I['handR']], 1, 50, [(1, 1.2), (40, 1.2), (48, 0.0)])
    for i, f in enumerate((10, 18, 26, 33)):
        go(fx.repulsor_shot, sc, iron, I['handL'], gaunt(f + 3), f, f + 3, 1.0)
    f = when['im_land']
    go(fx.dust_burst, sc, bone_at(iron, I['hips'], f) * Vector((1, 1, 0)), f, 2.0)
    go(fx.ground_crack, sc, bone_at(iron, I['hips'], f) * Vector((1, 1, 0)), f, 1.4)
    f = when['th_land']
    go(fx.dust_burst, sc, bone_at(th, T['hips'], f) * Vector((1, 1, 0)), f, 3.0, 1.5)
    go(fx.ground_crack, sc, bone_at(th, T['hips'], f) * Vector((1, 1, 0)), f, 2.2)
    f = when['cannon']
    go(fx.repulsor_charge, sc, iron, I['handR'], f - 12, f - 1)
    go(fx.repulsor_shot, sc, iron, I['handR'], th_chest(f + 1), f - 1, f + 1, 2.4)
    go(fx.impact, sc, bone_at(iron, I['head'], when['jab']), when['jab'], 0.7)
    go(fx.impact, sc, bone_at(iron, I['foreL'], when['swing']) + Vector((0, 0, 0.4)), when['swing'], 1.6)
    go(fx.impact, sc, bone_at(th, T['handL'], when['slash']), when['slash'], 1.2)
    go(fx.impact, sc, bone_at(iron, I['chest'], when['cross']), when['cross'], 1.6)
    go(fx.thrusters, sc, iron, [I['footL'], I['footR'], I['handL'], I['handR']], 310, 386,
       [(310, 0.0), (316, 1.4), (360, 1.0), (380, 1.2), (386, 0.0)])
    f = when['smash']
    go(fx.impact, sc, bone_at(th, T['head'], f), f, 2.2)
    go(fx.dust_burst, sc, bone_at(th, T['hips'], f) * Vector((1, 1, 0)), f + 1, 2.4)
    go(fx.power_stone, sc, th, T['handL'], 414, 470)
    go(fx.stone_blast, sc, th, T['handL'], bone_at(iron, I['chest'], 464), 458, 464)
    down = bone_at(iron, I['hips'], 490) * Vector((1, 1, 0))
    go(fx.dust_burst, sc, down, 488, 2.2)
    go(fx.ground_crack, sc, down, 488, 1.2)
    go(fx.impact, sc, (bone_at(th, T['chest'], 590) + bone_at(iron, I['chest'], 590)) / 2, 590, 3.0)


if __name__ == '__main__':
    sc, _, _ = build()
    bpy.ops.wm.save_as_mainfile(filepath=SP + 'cine/fight.blend')

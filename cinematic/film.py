"""The camera and the film look: real-lens cameras (36 mm sensor, depth of field, 180-degree shutter) and the
grade (AgX with a filmic contrast look, gentle split-tone, bloom on hot highlights, faint chromatic
aberration, vignette, fine moving film grain). Works in Blender 4.2+ (tested in 4.2 and 5.2: the compositor
API differs between them and both are handled).

Public:
    shot_camera(scene, name, loc, target, lens=50, fstop=2.8, focus_target=None, ...) -> camera object
    focus_on(cam, target)                      # re-aim the focus (object, or point)
    handheld(cam, frames=(1, 750), amount=1.0, seed=1)  # subtle operator shake on a parent rig
    grade(scene, look=..., exposure=0, bloom=..., vignette=..., grain=..., aberration=...) -> node tree
    render_quality(scene, samples=None, preview=False)  # Cycles settings that suit this look
"""
import bpy, math
from mathutils import Vector, noise

UNIT_M = 0.5      # metres per scene unit (the characters are modelled at 2x real size in units)
SHUTTER = 0.5     # 180-degree shutter


# ----------------------------------------------------------------------------------------------------------
# cameras

def _empty(scene, name, loc):
    e = bpy.data.objects.get(name)
    if e is None:
        e = bpy.data.objects.new(name, None)
        scene.collection.objects.link(e)
    e.empty_display_size = 0.3
    e.location = loc
    return e


def _target(scene, name, t):
    """An object to aim at / focus on: the object itself, or an empty placed at a point."""
    if isinstance(t, bpy.types.Object):
        return t
    return _empty(scene, name, Vector(t))


def shot_camera(scene, name, loc, target, lens=50.0, fstop=2.8, focus_target=None, sensor=36.0, blades=9,
                active=True, shift=(0.0, 0.0)):
    """A cinema camera at loc aimed at target (object or point; a Track To constraint keeps it aimed).
    lens: focal length in mm (35..85 for this film). fstop: the REAL-WORLD f-number: the scene is 1 unit =
    0.5 m, so Blender's value is set to fstop * 0.5 to give the depth of field a real lens would.
    focus_target: object or point to hold in focus (defaults to target). Also turns on motion blur with a
    180-degree shutter. Returns the camera object (aim/focus empties are named <name>_aim/<name>_focus)."""
    c = bpy.data.cameras.get(name) or bpy.data.cameras.new(name)
    c.lens = lens
    c.sensor_fit = 'HORIZONTAL'
    c.sensor_width = sensor
    c.sensor_height = sensor * 9.0 / 16.0
    c.clip_start = 0.05
    c.clip_end = 3000.0
    c.shift_x, c.shift_y = shift
    c.dof.use_dof = True
    c.dof.aperture_fstop = max(0.05, fstop * UNIT_M)
    c.dof.aperture_blades = blades
    c.dof.aperture_rotation = math.radians(12.0)
    c.dof.aperture_ratio = 1.0
    o = bpy.data.objects.get(name)
    if o is None:
        o = bpy.data.objects.new(name, c)
        scene.collection.objects.link(o)
    o.location = loc
    aim = _target(scene, name + '_aim', target)
    for con in list(o.constraints):
        o.constraints.remove(con)
    tr = o.constraints.new('TRACK_TO')
    tr.target = aim
    tr.track_axis = 'TRACK_NEGATIVE_Z'
    tr.up_axis = 'UP_Y'
    focus_on(o, focus_target if focus_target is not None else aim)
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = SHUTTER
    for owner in (scene.render, getattr(scene, 'cycles', None)):
        if owner is not None and hasattr(owner, 'motion_blur_position'):
            owner.motion_blur_position = 'CENTER'
    if active:
        scene.camera = o
    return o


def focus_on(cam, target):
    """Hold focus on an object (follows it) or a fixed point."""
    t = _target(bpy.context.scene, cam.name + '_focus', target)
    cam.data.dof.focus_object = t
    return t


def handheld(cam, frames=(1, 750), amount=1.0, seed=1, step=2):
    """A subtle, smooth operator shake (a fraction of a degree of drift, slower in yaw): keys the rotation of
    a parent empty '<cam>_rig' every `step` frames from deterministic noise, so the camera's own animation
    and constraints stay untouched. amount 1.0 ~ a steady handheld; 2-3 for impacts."""
    scene = bpy.context.scene
    rig = bpy.data.objects.get(cam.name + '_rig')
    if rig is None:
        rig = bpy.data.objects.new(cam.name + '_rig', None)
        scene.collection.objects.link(rig)
        rig.location = cam.location.copy()
        mw = cam.matrix_world.copy()
        cam.parent = rig
        cam.location = (0, 0, 0)
        cam.matrix_world = mw
    fps = scene.render.fps / max(1e-6, scene.render.fps_base)
    off = Vector((seed * 17.3, seed * 5.1, seed * 9.7))
    for f in range(frames[0], frames[1] + 1, step):
        t = f / fps
        rx = 0.22 * noise.noise(off + Vector((t * 0.55, 0, 0))) + 0.06 * noise.noise(off + Vector((t * 2.1, 3, 0)))
        ry = 0.14 * noise.noise(off + Vector((0, t * 0.45, 7))) + 0.04 * noise.noise(off + Vector((5, t * 1.9, 0)))
        rz = 0.30 * noise.noise(off + Vector((9, 0, t * 0.35))) + 0.05 * noise.noise(off + Vector((0, 11, t * 1.7)))
        rig.rotation_euler = (math.radians(rx * amount), math.radians(ry * amount), math.radians(rz * amount))
        rig.keyframe_insert('rotation_euler', frame=f)
    return rig


# ----------------------------------------------------------------------------------------------------------
# the grade (compositor), for both the 4.x and the 5.x compositor APIs

def _set(node, value, *names):
    """Set a node option by input-socket identifier/name (5.x) or by property (4.x); first match wins."""
    for nm in names:
        for s in node.inputs:
            if (s.identifier == nm or s.name == nm) and hasattr(s, 'default_value'):
                try:
                    s.default_value = value
                    return True
                except (TypeError, ValueError):
                    continue
        if hasattr(node, nm):
            for v in (value, value[:3] if isinstance(value, tuple) and len(value) == 4 else None):
                if v is None:
                    continue
                try:
                    setattr(node, nm, v)
                    return True
                except (TypeError, ValueError, AttributeError):
                    continue
    return False


def _inp(node, *names):
    for nm in names:
        for s in node.inputs:
            if s.identifier == nm or s.name == nm:
                return s
    return node.inputs[0]


def _tree(scene):
    """A fresh compositor tree and the socket the finished image goes into."""
    scene.render.use_compositing = True
    if hasattr(scene.render, 'compositor_device'):
        scene.render.compositor_device = 'CPU'
    if hasattr(scene, 'compositing_node_group'):  # Blender 5.0+
        nt = bpy.data.node_groups.get('FilmGrade')
        if nt is None:
            nt = bpy.data.node_groups.new('FilmGrade', 'CompositorNodeTree')
            nt.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        nt.nodes.clear()
        scene.compositing_node_group = nt
        out = nt.nodes.new('NodeGroupOutput')
        return nt, out.inputs[0], True
    scene.use_nodes = True
    nt = scene.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('CompositorNodeComposite')
    nt.nodes.new('CompositorNodeViewer').location = (1800, -300)
    return nt, out.inputs['Image'], False


def _mix(nt, blend, fac, a, b, new):
    """A colour mix (CompositorNodeMixRGB in 4.x, ShaderNodeMix in 5.x). Returns its output socket."""
    if new:
        m = nt.nodes.new('ShaderNodeMix')
        m.data_type = 'RGBA'
        m.blend_type = blend
        sf, sa, sb, out = m.inputs[0], m.inputs[6], m.inputs[7], m.outputs[2]
    else:
        m = nt.nodes.new('CompositorNodeMixRGB')
        m.blend_type = blend
        sf, sa, sb, out = m.inputs[0], m.inputs[1], m.inputs[2], m.outputs[0]
    for s, v in ((sf, fac), (sa, a), (sb, b)):
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, s)
        else:
            s.default_value = v
    return out


def _view(scene, look, exposure, gamma):
    vs = scene.view_settings
    try:
        scene.display_settings.display_device = 'sRGB'
    except TypeError:
        pass
    vs.view_transform = 'AgX'
    for lk in (look, 'AgX - ' + look, look.replace('AgX - ', ''), 'AgX - Medium High Contrast', 'None'):
        try:
            vs.look = lk
            break
        except TypeError:
            continue
    vs.exposure = exposure
    vs.gamma = gamma
    scene.sequencer_colorspace_settings.name = scene.sequencer_colorspace_settings.name


def grade(scene, look='AgX - Medium High Contrast', exposure=0.0, gamma=1.0, bloom=0.18, bloom_threshold=1.6,
          bloom_size=0.55, split=1.0, vignette=0.3, grain=0.07, aberration=0.012, distortion=0.0):
    """The film look. AgX + a contrast look; in the compositor: a soft BLOOM on hot highlights (only what is
    over bloom_threshold in scene-linear), a subtle SPLIT-TONE (cool shadows, warm highlights; split=0 off),
    lens CHROMATIC ABERRATION (+ optional barrel distortion), a soft VIGNETTE, and fine film GRAIN that
    changes every frame (deterministic). Every effect is optional (0 turns it off) and fails soft."""
    _view(scene, look, exposure, gamma)
    nt, final_in, new = _tree(scene)
    N, L = nt.nodes, nt.links
    rl = N.new('CompositorNodeRLayers')
    rl.scene = scene
    img = rl.outputs['Image']

    def guard(fn):
        nonlocal img
        try:
            img = fn(img)
        except Exception as e:  # keep the render going if a node differs in this Blender
            print('[film.grade] skipped', fn.__name__, ':', e)

    def bloom_fx(src):
        if bloom <= 0:
            return src
        g = N.new('CompositorNodeGlare')
        if not _set(g, 'Bloom', 'Type'):
            _set(g, 'BLOOM', 'glare_type') or _set(g, 'FOG_GLOW', 'glare_type')
        _set(g, 'High', 'Quality') or _set(g, 'HIGH', 'quality')
        _set(g, bloom_threshold, 'Highlights Threshold', 'threshold')
        if not _set(g, bloom, 'Strength'):
            _set(g, max(-1.0, min(1.0, 2.0 * bloom - 1.0)), 'mix')   # 4.x: -1 = image only, 1 = glare only
            _set(g, max(1, min(9, int(round(bloom_size * 9)))), 'size')
        else:
            _set(g, bloom_size, 'Size')
            _set(g, 0.85, 'Saturation')
            _set(g, 0.25, 'Highlights Smoothness')
        L.new(src, g.inputs[0])
        return g.outputs[0]

    def split_fx(src):
        if split <= 0:
            return src
        cb = N.new('CompositorNodeColorBalance')
        _set(cb, 'Offset/Power/Slope (ASC-CDL)', 'Type') or _set(cb, 'OFFSET_POWER_SLOPE', 'correction_method')
        # CDL on linear light: power < 1 on blue lifts it in the shadows and lowers it above 1 (warm highlights).
        pw = (1.0 - 0.005 * split, 1.0 - 0.0 * split, 1.0 - 0.035 * split, 1.0)
        sl = (1.0 + 0.02 * split, 1.0, 1.0 - 0.02 * split, 1.0)
        _set(cb, pw, 'Color Power', 'power')
        _set(cb, sl, 'Color Slope', 'slope')
        L.new(src, _inp(cb, 'Image'))
        return cb.outputs[0]

    def lens_fx(src):
        if aberration <= 0 and distortion == 0:
            return src
        ld = N.new('CompositorNodeLensdist')
        _set(ld, distortion, 'Distortion', 'Distort')
        _set(ld, aberration, 'Dispersion')
        _set(ld, True, 'Fit', 'use_fit')
        _set(ld, False, 'Jitter', 'use_jitter')
        L.new(src, _inp(ld, 'Image'))
        return ld.outputs[0]

    def vignette_fx(src):
        if vignette <= 0:
            return src
        if new:
            # 5.x: from the pixel's place in the frame: v = smoothstep(0.35, 1.45, |2*uv - 1| (aspect-weighted)).
            ic = N.new('CompositorNodeImageCoordinates')
            L.new(src, ic.inputs[0])
            vm = N.new('ShaderNodeVectorMath')
            vm.operation = 'MULTIPLY_ADD'
            L.new(ic.outputs['Normalized'], vm.inputs[0])
            vm.inputs[1].default_value = (2.0, 2.0, 0.0)
            vm.inputs[2].default_value = (-1.0, -1.0, 0.0)
            ln = N.new('ShaderNodeVectorMath')
            ln.operation = 'LENGTH'
            L.new(vm.outputs[0], ln.inputs[0])
            mr = N.new('ShaderNodeMapRange')
            mr.interpolation_type = 'SMOOTHSTEP'
            L.new(ln.outputs['Value'], mr.inputs['Value'])
            mr.inputs['From Min'].default_value = 0.45
            mr.inputs['From Max'].default_value = 1.45
            mr.inputs['To Min'].default_value = 1.0
            mr.inputs['To Max'].default_value = 0.0
            return _mix(nt, 'MULTIPLY', vignette, src, mr.outputs['Result'], new)
        # 4.x: a soft ellipse (its size is relative to the frame width) blurred into a falloff.
        em = N.new('CompositorNodeEllipseMask')
        aspect = scene.render.resolution_y / max(1, scene.render.resolution_x)
        em.mask_width = 1.15
        em.mask_height = 1.33 * aspect
        bl = N.new('CompositorNodeBlur')
        if new:
            # Blur size in pixels: a quarter of the frame width (5.x has no relative mode).
            rel = N.new('CompositorNodeRelativeToPixel')
            rel.data_type = 'VECTOR'
            rel.reference_dimension = 'X'
            _set(rel, (0.3, 0.3), 'Vector Value')
            L.new(src, _inp(rel, 'Image'))
            L.new(rel.outputs['Vector Value'], _inp(bl, 'Size'))
            _set(bl, 'Gaussian', 'Type')
        else:
            bl.filter_type = 'FAST_GAUSS'
            bl.use_relative = True
            bl.factor_x = bl.factor_y = 30.0
        L.new(em.outputs['Mask'], _inp(bl, 'Image'))
        # multiply by (1 - v) + v * mask
        return _mix(nt, 'MULTIPLY', vignette, src, bl.outputs[0], new)

    def grain_fx(src):
        if grain <= 0:
            return src
        if new:
            ic = N.new('CompositorNodeImageCoordinates')
            L.new(src, ic.inputs[0])
            wn = N.new('ShaderNodeTexWhiteNoise')
            wn.noise_dimensions = '4D'
            L.new(ic.outputs['Pixel'], wn.inputs['Vector'])
            st = N.new('CompositorNodeSceneTime')
            L.new(st.outputs['Frame'], wn.inputs['W'])
            mono = wn.outputs['Value']
            chroma = wn.outputs['Color']
        else:
            tex = bpy.data.textures.get('FilmGrain') or bpy.data.textures.new('FilmGrain', 'CLOUDS')
            tex.noise_scale = 0.0012
            tex.noise_depth = 0
            tex.noise_basis = 'IMPROVED_PERLIN'
            tx = N.new('CompositorNodeTexture')
            tx.texture = tex
            for i in range(2):  # a new grain every frame
                fc = tx.inputs['Offset'].driver_add('default_value', i)
                fc.driver.expression = 'frame * %.3f' % (7.31 if i == 0 else 3.17)
            mono = tx.outputs['Value']
            chroma = tx.outputs['Color']
        # Mostly luminance grain with a touch of colour; soft-light so it lives in the mid-tones.
        gcol = _mix(nt, 'MIX', 0.2, mono, chroma, new)
        # (the 4.x cloud texture is half as contrasty as white noise: doubled for the same grain)
        return _mix(nt, 'OVERLAY', grain if new else min(1.0, 2.0 * grain), src, gcol, new)

    for fx in (bloom_fx, split_fx, lens_fx, vignette_fx, grain_fx):
        guard(fx)
    L.new(img, final_in)
    # Tidy layout.
    for i, n in enumerate(N):
        n.location = (i * 200, 0)
    return nt


def render_quality(scene, samples=None, preview=False):
    """Cycles settings for this look: adaptive sampling, denoise, clamped indirect light (no fireflies off
    the armour), enough glossy/transparent bounces, filter glossy for clean highlights."""
    cy = scene.cycles
    scene.render.engine = 'CYCLES'
    if samples:
        cy.samples = samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02 if preview else 0.01
    cy.use_denoising = True
    cy.sample_clamp_direct = 0.0
    cy.sample_clamp_indirect = 6.0
    cy.blur_glossy = 0.8
    cy.max_bounces = 8
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 4
    cy.transmission_bounces = 6
    cy.transparent_max_bounces = 8
    cy.volume_bounces = 1
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    scene.render.film_transparent = False
    try:
        cy.denoiser = 'OPENIMAGEDENOISE'
    except TypeError:
        pass
    return scene

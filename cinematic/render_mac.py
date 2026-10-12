"""The final render, on the Mac. From Terminal (Blender's own Python runs it):

  /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- preview
      the whole fight, small and fast (Eevee), straight into ~/Desktop/fight_render/preview.mp4: for checking
      the action, the cuts and the weapons (not the final look)
  ... -- preview-cycles
      the same with Cycles at low quality, if Eevee fails on this Mac (slower)
  ... -- stills
      a bright start and end picture for each shot of AI_SHOTS.txt, at final quality, into
      ~/Desktop/fight_render/stills (for an AI video tool's start/end-frame mode)
  ... -- test
      four frames at final quality: prints seconds per frame and how long the full render will take
  ... -- full
      all 600 frames at final quality into ~/Desktop/fight_render/frames; run it again after a stop and it
      carries on from the frames already done
  ... -- movie
      joins the finished frames into ~/Desktop/fight_render/fight.mp4
  ... -- blend
      saves the built scene as ~/Desktop/fight_render/fight.blend, to open and look around in Blender

It finds Iron Man MK85.blend, Thanos_Armored_V_Tex.blend and the motion clips under ~/Downloads (see paths.py)."""
import bpy
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

OUT = paths.OUT
TEST_FRAMES = [56, 238, 362, 450]
FINAL = (1920, 1080, 128)  # (width, height, samples: adaptive, denoised)
STILLS_EV = 2.5            # (stills are brightened: the AI tool needs to see the fighters clearly)
STILLS = [  # (name, first frame, last frame): one AI video shot each (see AI_SHOTS.txt)
    ('01_flyin', 2, 28), ('02_gauntlet', 32, 46), ('03_leap', 68, 88), ('04_crash', 92, 110),
    ('05_cannon_forms', 114, 130), ('06_cannon_blast', 133, 149), ('07_head_punch', 178, 196),
    ('08_shield_block', 200, 233), ('09_sword_snap', 254, 281), ('10_boost', 302, 329),
    ('11_dive_fist', 356, 377), ('12_smash', 380, 409), ('13_power_stone', 412, 449),
    ('14_stone_blast', 452, 485), ('15_rise_cannons', 488, 539), ('16_ironman_close', 542, 555),
    ('17_thanos_close', 558, 571), ('18_charge', 574, 599)]


def gpu(sc):
    """Render on the GPU when there is one (Apple silicon: Metal)."""
    try:
        cp = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
            try:
                cp.compute_device_type = kind
            except TypeError:
                continue
            cp.get_devices()
            if any(d.type == kind for d in cp.devices):
                for d in cp.devices:
                    d.use = d.type == kind
                sc.cycles.device = 'GPU'
                return kind
    except Exception as e:
        print('(no GPU set-up:', e, ')')
    sc.cycles.device = 'CPU'
    return 'CPU'


def quality(sc, w, h, samples, blur=True):
    sc.render.engine = 'CYCLES'
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = int(os.environ.get('CINE_PERCENT', 100))  # (smaller for a dry run)
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.cycles.use_denoising = True
    sc.render.use_persistent_data = True  # (the scene kept from frame to frame instead of rebuilt each time)
    if not (blur and vector_blur(sc)):
        sc.render.use_motion_blur = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'


def _put(node, value, *names):
    """Set a compositor node's setting: an input socket (Blender 5) or a property (4.x), whichever it has."""
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = value
            return True
        if hasattr(node, n):
            setattr(node, n, value)
            return True
    return False


def vector_blur(sc):
    """Motion blur put on in the compositor from the speed pass, with the film's shutter: far cheaper than
    rendering it. Returns False (and leaves the render's own blur) where the compositor has no render layer."""
    nt = getattr(sc, 'compositing_node_group', None) or (getattr(sc, 'node_tree', None) if getattr(sc, 'use_nodes', False) else None)
    rl = next((n for n in nt.nodes if n.bl_idname == 'CompositorNodeRLayers'), None) if nt else None
    if rl is None:
        return False
    shutter = sc.render.motion_blur_shutter
    sc.render.use_motion_blur = False  # (Cycles writes the speed pass only without its own blur)
    for vl in sc.view_layers:
        vl.use_pass_vector = True
        vl.use_pass_z = True
    img = rl.outputs['Image']
    to = [ln.to_socket for ln in nt.links if ln.from_socket == img]
    vb = nt.nodes.new('CompositorNodeVecBlur')
    vb.location = (rl.location.x + 250, rl.location.y - 300)
    nt.links.new(img, vb.inputs['Image'])
    nt.links.new(rl.outputs['Vector'], vb.inputs['Speed'])
    depth = rl.outputs.get('Depth') or rl.outputs.get('Z')
    nt.links.new(depth, vb.inputs.get('Depth') or vb.inputs.get('Z'))
    _put(vb, 64, 'Samples', 'samples')
    _put(vb, shutter, 'Shutter', 'factor')
    for t in to:
        nt.links.new(vb.outputs[0], t)
    return True


def mp4(sc, path, crf='HIGH'):
    """Render output straight to an H.264 movie."""
    if hasattr(sc.render.image_settings, 'media_type'):  # (Blender 5: video is a media type of its own)
        sc.render.image_settings.media_type = 'VIDEO'
    sc.render.image_settings.file_format = 'FFMPEG'
    sc.render.ffmpeg.format = 'MPEG4'
    sc.render.ffmpeg.codec = 'H264'
    sc.render.ffmpeg.constant_rate_factor = crf
    sc.render.filepath = path


def preview(sc, eevee=True):
    """All 600 frames at 960x540 into preview.mp4 (kept small enough to upload): Eevee, or Cycles at 16
    samples. No motion blur."""
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    sc.render.resolution_percentage = 100
    sc.render.use_motion_blur = False
    engine = None
    for e in (('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE') if eevee else ()):  # (4.2-4.4: _NEXT; 5.x: plain)
        try:
            sc.render.engine = e
            engine = e
            break
        except TypeError:
            continue
    if engine:
        sc.eevee.taa_render_samples = 16
        if hasattr(sc.eevee, 'use_raytracing'):
            sc.eevee.use_raytracing = True  # (the armour's reflections)
    else:
        quality(sc, 960, 540, 16, blur=False)
        engine = 'CYCLES'
    sc.frame_start, sc.frame_end = 1, 600
    mp4(sc, os.path.join(OUT, 'preview.mp4'), 'LOW')
    print('preview with', engine, '- rendering 600 frames', flush=True)
    progress(600)
    t = time.time()
    bpy.ops.render.render(animation=True)
    print(f'preview done in {(time.time() - t) / 60:.0f} min:', os.path.join(OUT, 'preview.mp4'))


def progress(total):
    """A line after every finished frame: 'frame 12 of 600 done'."""
    def post(scene, *_):
        print(f'frame {scene.frame_current - scene.frame_start + 1} of {total} done', flush=True)
    bpy.app.handlers.render_post.append(post)


def build():
    import shots
    print('Building the fight: loading the models and the motion clips (a few minutes)...', flush=True)
    t = time.time()
    sc, _, _ = shots.build(preview=False)
    print(f'built in {time.time() - t:.0f} s; rendering on', gpu(sc))
    return sc


def movie():
    frames = sorted(f for f in os.listdir(os.path.join(OUT, 'frames')) if f.endswith('.png'))
    if not frames:
        sys.exit('no frames yet: run with "full" first')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 24
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    ed = sc.sequence_editor_create()
    strips = ed.strips if hasattr(ed, 'strips') else ed.sequences  # (Blender 5: strips)
    st = strips.new_image('fight', os.path.join(OUT, 'frames', frames[0]), 1, 1)
    for f in frames[1:]:
        st.elements.append(f)
    sc.frame_start, sc.frame_end = 1, len(frames)
    sc.render.use_sequencer = True
    mp4(sc, os.path.join(OUT, 'fight.mp4'))
    bpy.ops.render.render(animation=True)
    print('movie:', sc.render.filepath)


def main():
    mode = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv and len(sys.argv) > sys.argv.index('--') + 1 else 'test'
    os.makedirs(OUT, exist_ok=True)
    if mode == 'movie':
        return movie()
    sc = build()
    if mode == 'blend':
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'fight.blend'))
        print('saved', os.path.join(OUT, 'fight.blend'))
    elif mode == 'stills':
        quality(sc, *FINAL, blur=False)
        sc.view_settings.exposure += STILLS_EV
        n = 0
        for name, f0, f1 in STILLS:
            for tag, f in (('start', f0), ('end', f1)):
                sc.frame_set(f)
                sc.render.filepath = os.path.join(OUT, 'stills', f'{name}_{tag}.png')
                bpy.ops.render.render(write_still=True)
                n += 1
                print(f'still {n} of {2 * len(STILLS)}: {name}_{tag}.png', flush=True)
        print('stills in', os.path.join(OUT, 'stills'), '- now follow AI_SHOTS.txt')
    elif mode in ('preview', 'preview-cycles'):
        preview(sc, eevee=mode == 'preview')
    elif mode == 'test':
        quality(sc, *FINAL)
        took = []
        for f in TEST_FRAMES:
            sc.frame_set(f)
            sc.render.filepath = os.path.join(OUT, 'test', f'f{f:03d}.png')
            t = time.time()
            bpy.ops.render.render(write_still=True)
            took.append(time.time() - t)
            print(f'frame {f}: {took[-1]:.0f} s')
        per = sum(took[1:]) / len(took[1:])  # (the first frame also loads the scene)
        print('test frames in', os.path.join(OUT, 'test'))
        print(f'FULL RENDER ESTIMATE: about {per:.0f} s a frame, {per * 600 / 3600:.1f} hours for all 600 frames')
    elif mode == 'full':
        quality(sc, *FINAL)
        sc.frame_start, sc.frame_end = 1, 600
        sc.render.filepath = os.path.join(OUT, 'frames', 'f')
        sc.render.use_overwrite = False  # (a re-run skips frames already rendered)
        sc.render.use_placeholder = True
        progress(600)
        bpy.ops.render.render(animation=True)
        print('frames in', os.path.join(OUT, 'frames'), '- now run with "movie"')
    else:
        sys.exit(f'unknown mode {mode}: use stills, preview, preview-cycles, test, full, movie or blend')


main()

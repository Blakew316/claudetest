"""The final render, on the Mac. From Terminal (Blender's own Python runs it):

  /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- test
      four frames at reduced quality, to check the full-detail models (prints seconds per frame)
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
    sc.render.use_motion_blur = blur
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'


def build():
    import shots
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
    if hasattr(sc.render.image_settings, 'media_type'):  # (Blender 5: video is a media type of its own)
        sc.render.image_settings.media_type = 'VIDEO'
    sc.render.image_settings.file_format = 'FFMPEG'
    sc.render.ffmpeg.format = 'MPEG4'
    sc.render.ffmpeg.codec = 'H264'
    sc.render.ffmpeg.constant_rate_factor = 'HIGH'
    sc.render.filepath = os.path.join(OUT, 'fight.mp4')
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
    elif mode == 'test':
        quality(sc, 1280, 720, 64)
        for f in TEST_FRAMES:
            sc.frame_set(f)
            sc.render.filepath = os.path.join(OUT, 'test', f'f{f:03d}.png')
            t = time.time()
            bpy.ops.render.render(write_still=True)
            print(f'frame {f}: {time.time() - t:.0f} s')
        print('test frames in', os.path.join(OUT, 'test'))
    elif mode == 'full':
        quality(sc, 1920, 1080, 256)
        sc.frame_start, sc.frame_end = 1, 600
        sc.render.filepath = os.path.join(OUT, 'frames', 'f')
        sc.render.use_overwrite = False  # (a re-run skips frames already rendered)
        sc.render.use_placeholder = True
        bpy.ops.render.render(animation=True)
        print('frames in', os.path.join(OUT, 'frames'), '- now run with "movie"')
    else:
        sys.exit(f'unknown mode {mode}: use test, full, movie or blend')


main()

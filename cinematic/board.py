"""Storyboard: one frame from each shot, small and quick, on one sheet."""
import bpy, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shots
SP = shots.SP
sc, _, _ = shots.build()
bpy.ops.wm.save_as_mainfile(filepath=SP + 'cine/fight.blend')
sc.render.resolution_x, sc.render.resolution_y = 480, 270
sc.cycles.samples = 6
frames = [int(a) for a in sys.argv[sys.argv.index('--') + 1:]] if '--' in sys.argv else [30, 56, 100, 150, 180, 215, 238, 285, 325, 362, 400, 450, 480, 545, 590]
for f in frames:
    sc.frame_set(f)
    sc.render.filepath = SP + f'cine/board/f{f:03d}.png'
    bpy.ops.render.render(write_still=True)
print('board done')

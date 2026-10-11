import bpy, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shots
SP = shots.SP
sc, _, _ = shots.build()
sc.render.resolution_x, sc.render.resolution_y = 480, 270
sc.cycles.samples = 4
sc.render.use_motion_blur = False
sc.render.filepath = SP + 'cine/animatic/f'
sc.render.image_settings.file_format = 'JPEG'
bpy.ops.render.render(animation=True)
print('animatic done')

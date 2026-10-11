"""Scene pieces: the two fighters, their materials, space, lights, cameras."""
import bpy, math, os
from mathutils import Vector, Euler
import retarget as rt

ASSETS = '/home/user/claudetest/assets/ironman-mk/'
HERE = os.path.dirname(os.path.abspath(__file__))
IRON_H = 3.585  # model units (his height); Thanos is drawn 1.12x


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = [o for o in new if o.type == 'ARMATURE'][0]
    # One root to place and turn him by.
    root = bpy.data.objects.new(os.path.basename(path) + '_root', None)
    bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    return root, arm, new


def img(path, srgb=True):
    im = bpy.data.images.load(path, check_existing=True)
    if not srgb:
        im.colorspace_settings.name = 'Non-Color'
    return im


def principled(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    return m, nt, b


def iron_materials(objs):
    """The suit's look (world/ironman-model.js): candy red under clear coat, brushed gold, gunmetal, hot lights."""
    mats = {}
    m, nt, b = principled('IM_Red')
    b.inputs['Base Color'].default_value = (0.234, 0.0017, 0.0019, 1)
    b.inputs['Metallic'].default_value = 0.7
    b.inputs['Roughness'].default_value = 0.36
    b.inputs['Coat Weight'].default_value = 1.0
    b.inputs['Coat Roughness'].default_value = 0.06
    mats['Red'] = m
    for key, tex, tint, rough, an in (('Gold', 'gold_color.webp', (1.0, 0.86, 0.68), 0.32, 0.45), ('Silver', 'silver_color.webp', (0.7, 0.72, 0.76), 0.38, 0.6)):
        m, nt, b = principled('IM_' + key)
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img(ASSETS + tex)
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[7].default_value = (*tint, 1)
        nt.links.new(t.outputs['Color'], mix.inputs[6])
        bright = nt.nodes.new('ShaderNodeBrightContrast')
        bright.inputs['Bright'].default_value = 0.25
        nt.links.new(mix.outputs[2], bright.inputs['Color'])
        nt.links.new(bright.outputs['Color'], b.inputs['Base Color'])
        b.inputs['Metallic'].default_value = 1.0
        b.inputs['Roughness'].default_value = rough
        b.inputs['Anisotropic'].default_value = an
        mats[key] = m
    m, nt, b = principled('IM_Light')
    b.inputs['Base Color'].default_value = (0.002, 0.004, 0.005, 1)
    b.inputs['Roughness'].default_value = 0.15
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = img(ASSETS + 'light_emissive.webp')
    nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 12.0
    mats['Light'] = m
    for o in objs:
        if o.type != 'MESH':
            continue
        for slot in o.material_slots:
            if slot.material:
                for key, m in mats.items():
                    if slot.material.name.startswith(key):
                        slot.material = m


def posed_height(objs):
    """Lowest and highest point of his meshes as posed now (world z)."""
    dg = bpy.context.evaluated_depsgraph_get()
    zs = []
    for o in objs:
        if o.type != 'MESH':
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        mw = o.matrix_world
        for i in range(0, len(me.vertices), 7):
            zs.append((mw @ me.vertices[i].co).z)
        ev.to_mesh_clear()
    return min(zs), max(zs)


def height_of(objs):
    zs = [(o.matrix_world @ Vector(c)).z for o in objs if o.type == 'MESH' for c in o.bound_box]
    return min(zs), max(zs)


def fighters():
    """Iron Man and Thanos, his size times 1.12, each with a root empty (Iron Man faces +x, Thanos -x)."""
    iron_root, iron_arm, iron_objs = import_glb(os.path.join(HERE, 'ironman.glb'))
    # (A stray sphere ships in his file.)
    for o in [o for o in iron_objs if o.name.startswith('Icosphere')]:
        iron_objs.remove(o)
        bpy.data.objects.remove(o, do_unlink=True)
    iron_materials(iron_objs)
    th_root, th_arm, th_objs = import_glb(os.path.join(HERE, 'thanos.glb'))
    # His file plays a stray animation ('Loser'): drop it, and stand him in his bind pose.
    if th_arm.animation_data:
        th_arm.animation_data.action = None
    for pb in th_arm.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    lo, hi = posed_height(th_objs)
    s = IRON_H * 1.12 / (hi - lo)
    th_root.scale = (s, s, s)
    bpy.context.view_layer.update()
    lo, hi = posed_height(th_objs)
    th_root.location.z -= lo
    bpy.context.view_layer.update()
    # Face them: the rest pose forward (toes) onto +x for Iron Man, -x for Thanos.
    bpy.context.view_layer.update()
    for root, arm, names, want in ((iron_root, iron_arm, rt.IRON, Vector((1, 0, 0))), (th_root, th_arm, rt.THANOS, Vector((-1, 0, 0)))):
        f = Vector((0, 0, 0))
        for s_ in 'LR':
            f += arm.matrix_world @ arm.pose.bones[names['toe' + s_]].head - arm.matrix_world @ arm.pose.bones[names['foot' + s_]].head
        f.z = 0
        f.normalize()
        ang = f.to_2d().angle_signed(want.to_2d())
        root.rotation_euler.z = -ang
    bpy.context.view_layer.update()

    return (iron_root, iron_arm, iron_objs), (th_root, th_arm, th_objs)


def space(scene):
    """Deep space: a dark backdrop with a dense field of small stars and a faint violet-blue haze."""
    w = scene.world or bpy.data.worlds.new('World')
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    coord = nt.nodes.new('ShaderNodeTexCoord')
    vor = nt.nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'F1'
    vor.inputs['Scale'].default_value = 420
    nt.links.new(coord.outputs['Generated'], vor.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    ramp.color_ramp.elements[1].position = 0.035
    ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(vor.outputs['Distance'], ramp.inputs['Fac'])
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 2.2
    noise.inputs['Detail'].default_value = 6
    nt.links.new(coord.outputs['Generated'], noise.inputs['Vector'])
    haze = nt.nodes.new('ShaderNodeValToRGB')
    haze.color_ramp.elements[0].position = 0.45
    haze.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1)
    haze.color_ramp.elements[1].position = 0.85
    haze.color_ramp.elements[1].color = (0.018, 0.012, 0.045, 1)
    nt.links.new(noise.outputs['Fac'], haze.inputs['Fac'])
    add = nt.nodes.new('ShaderNodeMix')
    add.data_type = 'RGBA'
    add.blend_type = 'ADD'
    add.inputs['Factor'].default_value = 1.0
    nt.links.new(haze.outputs['Color'], add.inputs[6])
    sm = nt.nodes.new('ShaderNodeMath')
    sm.operation = 'MULTIPLY'
    sm.inputs[1].default_value = 1.6
    nt.links.new(ramp.outputs['Color'], sm.inputs[0])
    nt.links.new(sm.outputs[0], add.inputs[7])
    nt.links.new(add.outputs[2], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 1.0
    nt.links.new(bg.outputs[0], out.inputs[0])


def light(scene, name, kind, energy, loc, rot, color=(1, 1, 1), size=1.0):
    l = bpy.data.lights.new(name, kind)
    l.energy = energy
    l.color = color
    if kind == 'AREA':
        l.size = size
    o = bpy.data.objects.new(name, l)
    scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    return o


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def camera(scene, name, loc, target, lens=45):
    c = bpy.data.cameras.new(name)
    c.lens = lens
    o = bpy.data.objects.new(name, c)
    scene.collection.objects.link(o)
    o.location = loc
    look_at(o, target)
    return o


def render_settings(scene, w, h, samples=24):
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.fps = 30
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - High Contrast'

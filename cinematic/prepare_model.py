"""Run on the Mac, once per purchased model. It never changes the purchased file.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python prepare_model.py -- <model file> <name>

<model file> is the purchased .blend (or .fbx / .glb / .gltf / .obj). <name> is a short label: ironman, thanos.
It writes two things to ~/Desktop/for_claude/:
  <name>_report.txt  what the model is made of: rig, face, fingers, helmet, armour pieces, textures, sliders.
  <name>_proxy.blend a light copy (same rig and meshes, small textures) under ~25 MB, for uploading to Claude.
The full-detail file stays on the Mac for the final render."""
import bpy
import os
import re
import shutil
import sys

LIMIT_MB = float(os.environ.get('PROXY_LIMIT_MB', 25))
OUT = os.path.expanduser('~/Desktop/for_claude')
FACE = re.compile(r'jaw|eye|lid|lip|brow|cheek|mouth|teeth|tongue|nose|chin|smile|blink|squint|sneer|frown|pucker|funnel', re.I)
FINGER = re.compile(r'finger|thumb|index|middle|ring|pinky|pinkie|f_', re.I)
HELMET = re.compile(r'helm|helmet|mask|faceplate|visor', re.I)


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(argv) < 2:
        sys.exit('usage: Blender -b --python prepare_model.py -- <model file> <name>')
    return os.path.abspath(os.path.expanduser(argv[0])), argv[1]


def load(path):
    """Open the model: a .blend as itself, anything else imported into an empty scene."""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    else:
        sys.exit(f'unsupported file type: {ext}')


def side(name):
    """L, R or ? from a bone name (hand.L, index01L, Finger1_L_084, LeftHandIndex1, thumb_r ...)."""
    n = name.lower()
    for s_, word in (('L', 'left'), ('R', 'right')):
        c = s_.lower()
        if word in n or re.search(rf'(^|[._\-\s]){c}([._\-\s\d]|$)|\d{c}$', n):
            return s_
    return '?'


def mb(n):
    return f'{n / 1e6:.1f} MB'


def report(path, name):
    L = []
    w = L.append
    folder = os.path.dirname(path)
    folder_size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(folder) for f in fs)
    w(f'# {name}: {os.path.basename(path)}')
    w(f'Blender {bpy.app.version_string}; file {mb(os.path.getsize(path))}; folder {mb(folder_size)}')
    sc = bpy.context.scene
    w(f'Units: {sc.unit_settings.system}, scale {sc.unit_settings.scale_length}; fps {sc.render.fps}')
    w(f'Collections: ' + ', '.join(f'{c.name}{" (hidden)" if c.hide_render else ""}' for c in bpy.data.collections))

    w('\n## Armatures')
    for ob in bpy.data.objects:
        if ob.type != 'ARMATURE':
            continue
        bones = ob.data.bones
        deform = [b for b in bones if b.use_deform]
        prefixes = sorted({b.name.split('-')[0] + '-' for b in bones if '-' in b.name and b.name.split('-')[0].isupper()})
        cons = [pb.name for pb in ob.pose.bones if pb.constraints]
        zs = [(ob.matrix_world @ b.head_local).z for b in bones] + [(ob.matrix_world @ b.tail_local).z for b in bones]
        w(f'{ob.name}: {len(bones)} bones ({len(deform)} deform), {len(cons)} with constraints, '
          f'rest height {max(zs) - min(zs):.2f}, prefixes {prefixes or "-"}, action '
          f'{ob.animation_data.action.name if ob.animation_data and ob.animation_data.action else "-"}')
        props = [k for k in ob.keys() if not k.startswith('_')] + [f'{pb.name}.{k}' for pb in ob.pose.bones for k in pb.keys() if not k.startswith('_')]
        if props:
            w(f'  sliders/custom properties ({len(props)}): ' + ', '.join(props[:60]))
        if ob.animation_data and ob.animation_data.drivers:
            w(f'  drivers: {len(ob.animation_data.drivers)}')
        face = [b.name for b in deform if FACE.search(b.name)]
        w(f'  face deform bones ({len(face)}): ' + (', '.join(face[:80]) or 'none'))
        fing = {'L': [], 'R': [], '?': []}
        for b in deform:
            if FINGER.search(b.name) and not FACE.search(b.name):
                fing[side(b.name)].append(b.name)
        for s in ('L', 'R', '?'):
            if fing[s]:
                w(f'  finger deform bones {s} ({len(fing[s])}): ' + ', '.join(fing[s][:40]))
        w('  all bones: ' + ', '.join(b.name for b in bones)[:12000])

    w('\n## Meshes')
    tot_v = tot_f = 0
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        me = ob.data
        tot_v += len(me.vertices)
        tot_f += len(me.polygons)
        mods = [m.type + (f'({m.levels}/{m.render_levels})' if m.type == 'SUBSURF' else f'({m.object.name})' if m.type == 'ARMATURE' and m.object else '') for m in ob.modifiers]
        sk = me.shape_keys.key_blocks if me.shape_keys else []
        par = f'{ob.parent.name}' + (f' bone {ob.parent_bone}' if ob.parent_type == 'BONE' else f' ({ob.parent_type})') if ob.parent else '-'
        flags = (' HIDDEN' if ob.hide_render else '') + (' HELMET?' if HELMET.search(ob.name) or any(m and HELMET.search(m.name) for m in me.materials) else '')
        w(f'{ob.name}{flags}: {len(me.vertices)} v, {len(me.polygons)} f, groups {len(ob.vertex_groups)}, '
          f'parent {par}, mods {mods or "-"}, mats {[m.name for m in me.materials if m][:6]}')
        if len(sk) > 1:
            w(f'  shape keys ({len(sk) - 1}): ' + ', '.join(k.name for k in sk[1:])[:3000])
    w(f'Total: {tot_v} vertices, {tot_f} faces')

    w('\n## Materials')
    for m in bpy.data.materials:
        if not m.node_tree:
            w(f'{m.name}: no nodes')
            continue
        types = sorted({n.type for n in m.node_tree.nodes})
        emit = any(n.type == 'EMISSION' or (n.type == 'BSDF_PRINCIPLED' and n.inputs.get('Emission Strength') is not None
                   and n.inputs['Emission Strength'].default_value > 0) for n in m.node_tree.nodes)
        w(f'{m.name}: {", ".join(types)}{" EMISSIVE" if emit else ""}')

    w('\n## Images')
    for im in bpy.data.images:
        if im.type != 'IMAGE':
            continue
        fp = bpy.path.abspath(im.filepath) if im.filepath else ''
        state = 'packed' if im.packed_file else ('ok' if fp and os.path.exists(fp) else 'MISSING')
        w(f'{im.name}: {im.size[0]}x{im.size[1]} {state} {os.path.basename(fp)}')

    w('\n## Other')
    w('Actions: ' + (', '.join(a.name for a in bpy.data.actions) or '-'))
    w('Text blocks: ' + (', '.join(t.name for t in bpy.data.texts) or '-'))
    w('Cameras/lights: ' + (', '.join(f'{o.name}({o.type})' for o in bpy.data.objects if o.type in ('CAMERA', 'LIGHT')) or '-'))
    return '\n'.join(L)


def shrink_images(max_side, tmp):
    """Every texture down to max_side on its longer edge, packed into the file as JPEG (a proxy only: normal
    maps and alpha cut-outs lose some precision, the full-detail file keeps them)."""
    for i, im in enumerate(bpy.data.images):
        if im.type != 'IMAGE':
            continue
        try:
            w, h = im.size
            if w == 0 or h == 0:
                continue
            k = max_side / max(w, h)
            if k >= 1 and im.packed_file and im.file_format == 'JPEG':
                continue
            if k < 1:
                im.scale(max(1, int(w * k)), max(1, int(h * k)))
            fp = os.path.join(tmp, f'{i}_{max_side}.jpg')
            im.file_format = 'JPEG'
            try:
                im.save(filepath=fp, quality=85)
            except TypeError:  # (older Blender: no filepath argument)
                im.filepath_raw = fp
                im.save()
            if im.packed_file:
                im.unpack(method='REMOVE')
            im.filepath = fp
            im.reload()
            im.pack()
        except Exception as e:
            print('skip image', im.name, e)


def proxy(name):
    out = os.path.join(OUT, f'{name}_proxy.blend')
    tmp = os.path.join(OUT, f'_textures_{name}')
    os.makedirs(tmp, exist_ok=True)
    try:
        for side_px in (1024, 512, 256, 128):
            shrink_images(side_px, tmp)
            if os.path.exists(out):
                os.remove(out)
            bpy.ops.wm.save_as_mainfile(filepath=out, compress=True, copy=True)
            size = os.path.getsize(out)
            print(f'proxy at {side_px}px textures: {mb(size)}')
            if size <= LIMIT_MB * 1e6:
                break
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if os.path.exists(out + '1'):
            os.remove(out + '1')
    return out, side_px, size


def main():
    path, name = args()
    os.makedirs(OUT, exist_ok=True)
    load(path)
    text = report(path, name)
    out, px, size = proxy(name)
    text += f'\n\nProxy: {os.path.basename(out)} {mb(size)} (textures {px}px)'
    if size > LIMIT_MB * 1e6:
        text += ' - STILL OVER THE UPLOAD LIMIT: the meshes themselves are large; tell Claude.'
    rp = os.path.join(OUT, f'{name}_report.txt')
    with open(rp, 'w') as f:
        f.write(text)
    print(f'\nDone. Upload these two files to Claude:\n  {rp}\n  {out}')


main()

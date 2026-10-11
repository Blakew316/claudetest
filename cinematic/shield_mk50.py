"""The Mark 50 nano shield's shape, after the Hot Toys figure: its panels as outlines (shield_mk50.json: traced by
hand on a photo of the figure, the left half mirrored) built as solid pieces with rounded edges, standing off a dark
backing in the shield's outline that shows between them as the seams; the whole bowed across and along.

  build(bm, height)   # into bm: upright in XY (y up, facing +z), centred, `height` tall
  aspect()            # its height over its width

Material slots: RED, GOLD, GLASS, PANEL (the darker gold set in the centre frame), BACKING."""
import bmesh, bpy, json, math, os

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shield_mk50.json')
RED, GOLD, GLASS, PANEL, BACKING = range(5)
SLOT = {0: RED, 1: GOLD, 2: GLASS, 4: PANEL}       # (the traced classes)
BEVEL = {0: 0.0055, 1: 0.0025, 2: 0.0015, 4: 0.002}  # (rounding of each piece's edges)
UNIT = 0.015                                        # (a piece's height above the backing, per unit of its 'h')
BULGE, VBULGE = 0.14, 0.04                          # (bow across and along)
DUPES = {}
SPLIT = 0.05                                        # (longest edge left unsplit, so pieces follow the bow)
# (all of these in shield widths: the outlines are traced at width 1)


def _data():
    with open(DATA) as f:
        return json.load(f)


def aspect():
    return _data()['height']


def _curve(name, rings, top, bottom, bev):
    """A flat piece in the outline `rings` (outer, then holes) from z=bottom to z=top, its edges rounded by bev."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '2D'
    cu.fill_mode = 'BOTH'
    for ring in rings:
        pts = ring[:-1] if ring[0] == ring[-1] else ring
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for p, (x, y) in zip(sp.points, pts):
            p.co = (x, y, 0, 1)
        sp.use_cyclic_u = True
    e = max(0.0005, (top - bottom - 2 * bev) / 2)
    cu.extrude = e
    cu.bevel_depth = bev
    cu.bevel_resolution = 3
    cu.offset = -bev  # (the rounding inside the outline, so the seams keep their width)
    ob = bpy.data.objects.new(name, cu)
    ob['lift'] = bottom + e + bev  # (its curve is centred on z=0)
    return ob


def build(bm, height):
    D = _data()
    h = D['height']
    width = height / h
    pieces = [('backing', [D['silhouette']], 0.0, -0.035, 0.004, BACKING)]
    for p in D['panels']:
        pieces.append((p['name'], [p['outer']] + p['holes'], p['h'] * UNIT, -0.006, BEVEL[p['cls']], SLOT[p['cls']]))
    coll = bpy.context.scene.collection
    obs = []
    for name, rings, top, bottom, bev, slot in pieces:
        ob = _curve('shield_' + name, rings, top, bottom, bev)
        coll.objects.link(ob)
        obs.append((ob, slot))
    dg = bpy.context.evaluated_depsgraph_get()
    for ob, slot in obs:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        pb = bmesh.new()
        pb.from_mesh(me)
        bpy.data.meshes.remove(me)
        bmesh.ops.triangulate(pb, faces=pb.faces[:])
        for _ in range(8):  # (long edges split so the piece follows the bow)
            long = [ed for ed in pb.edges if ed.calc_length() > SPLIT]
            if not long:
                break
            bmesh.ops.subdivide_edges(pb, edges=long, cuts=1, use_grid_fill=False)
            bmesh.ops.triangulate(pb, faces=[f for f in pb.faces if len(f.verts) > 3])
        lift = ob['lift']
        pb.verts.index_update()
        vs = []
        for v in pb.verts:
            x, y = v.co.x, v.co.y
            z = v.co.z + lift + BULGE * (1 - (2 * x) ** 2) + VBULGE * (1 - (2 * y / h) ** 2)
            vs.append(bm.verts.new((x * width, y * width, z * width)))
        for f in pb.faces:
            try:
                nf = bm.faces.new([vs[v.index] for v in f.verts])
            except ValueError:  # (a doubled face: the curve's fill can give one)
                DUPES[ob.name] = DUPES.get(ob.name, 0) + 1
                continue
            nf.material_index = slot
            nf.smooth = True
        pb.free()
        cu = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.curves.remove(cu)
    bm.normal_update()
    for ed in bm.edges:  # (smooth over the rounded edges, sharp at the corners)
        if len(ed.link_faces) == 2 and ed.calc_face_angle(0) > math.radians(40):
            ed.smooth = False

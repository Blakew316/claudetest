# Iron Man vs Thanos — Blender cinematic (work in progress)

A 25-second, 15-shot fight on a floating rock in the stardust, built entirely by Python scripts for Blender
(4.2 or newer; developed against Blender 5.2 as a Python module). Rendered with Cycles.

## Files
- `scene.py` — imports both characters (sizes, ground, facing), the suit materials, space, lights, cameras.
- `retarget.py` — copies humanoid FBX motion (Mixamo and similar) onto the Iron Man and Thanos rigs.
- `anim.py` — places clips on the NLA, keys the characters' placement, and aims arms in world space over the
  motion capture (repulsor palms, the raised gauntlet).
- `shots.py` — the fight itself: clips, placement, aimed arms, 15 cameras with cuts, and the effects' timing.
- `env.py`, `film.py` — the floating-rock arena, the lighting, the camera and colour grade (in progress).
- `fx.py` — repulsor charge/shot, impacts, Power Stone, thrusters, dust and ground cracks (in progress).
- `board.py` — renders one still per shot (a storyboard); `animatic.py` — a fast low-res render of all 600 frames.
- `decompress-models.mjs` — writes Blender-readable copies of `assets/ironman-mk/ironman.glb` and
  `assets/thanos/thanos.glb` (the app's copies are meshopt-compressed, which Blender cannot read).

## Not in the repository
The motion-capture clips (your Mixamo downloads and the purchased/free packs) are not committed: their licences
do not allow redistributing the raw files. The scripts expect them in a scratch folder (the `SP` paths at the
top of `shots.py`, to be pointed at a local folder when this moves to a Mac):
- Mixamo: Flying, Floating, Falling Idle, Hard Landing, Knocked Down, Getting Up, Hook Punch, Standing Idle,
  Walking, Punching.
- "Combat Essentials – Fight Mocap Pack" and "Fight Animation Mocap Pack (10 Animations)" (the 05_xx clips).

## Status
Shot layout, retargeting and arm aiming work; arena, effects, materials and the film look are being built;
no full-quality render yet.

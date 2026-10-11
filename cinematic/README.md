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
- `nano.py` — the nanotech weapons growing out of the suit (cannon, shield, blade, wings, energy shield, giant fist).
- `shield_mk50.py`, `shield_mk50.json` — the Mark 50 shield's shape after the Hot Toys figure: its panel outlines,
  traced by hand, built as separate solid pieces.
- `board.py` — renders one still per shot (a storyboard); `animatic.py` — a fast low-res render of all 600 frames.
- `paths.py` — finds the models and motion clips: the cloud copies here, or by file name under ~/Downloads on the
  Mac (inside the downloaded zips too).
- `render_mac.py` and `README_MAC.txt` — the final render on the Mac: test frames, all 600 frames (resumable), the
  movie, or the built scene saved to open in Blender.
- `prepare_model.py` — run on the Mac against a purchased model: writes a report of its rig, face, fingers,
  helmet, armour pieces and textures, and a light proxy copy (small textures, under ~25 MB) for uploading.
- `decompress-models.mjs` — writes Blender-readable copies of `assets/ironman-mk/ironman.glb` and
  `assets/thanos/thanos.glb` (the app's copies are meshopt-compressed, which Blender cannot read).

## Not in the repository
The motion-capture clips (your Mixamo downloads and the purchased/free packs) and the purchased models are not
committed: their licences do not allow redistributing them. `paths.py` finds them by file name (see above).

## Status
Shot layout, retargeting and arm aiming work; arena, effects, materials and the film look are being built;
no full-quality render yet.

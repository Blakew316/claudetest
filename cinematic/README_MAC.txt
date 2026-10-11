FIGHT RENDER ON THE MAC

1. Unzip cinematic.zip onto your Desktop. You get a folder: Desktop/cinematic
2. Leave your downloads where they are, in Downloads:
   Iron Man MK85.blend (with its textures folder), the Thanos folder
   (thanos-from-avengers-infinity-war-armor-version), and the motion clips
   (the Mixamo files and the zips you downloaded them in; zipped is fine).
3. Open Terminal and paste ONE of these lines, then press Enter.

   PREVIEW (10-20 minutes: the whole fight, small and fast, to check the action):
   /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- preview
   Result: Desktop/fight_render/preview.mp4 (small enough to upload to Claude).
   If it stops with an error, use the same line ending in   -- preview-cycles   (slower, same result).

   TEST (a few minutes, 4 frames at final quality):
   /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- test
   Pictures appear in Desktop/fight_render/test. The last line says how long the full render will take.

   FULL RENDER (all 600 frames, final quality):
   /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- full
   If it stops, run the same line again: it carries on from where it stopped.

   MOVIE (after the full render, joins the frames into one video):
   /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- movie
   Result: Desktop/fight_render/fight.mp4

   OPEN IN BLENDER (optional, to look around the scene):
   /Applications/Blender.app/Contents/MacOS/Blender -b --python ~/Desktop/cinematic/render_mac.py -- blend
   Then open Desktop/fight_render/fight.blend in Blender.

When Claude sends a newer cinematic.zip, delete the old Desktop/cinematic folder and unzip the new one.

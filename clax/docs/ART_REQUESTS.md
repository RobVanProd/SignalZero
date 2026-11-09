# Art requests (for whoever draws next)

Clax currently animates as a cut-out rig built from the single approved 3/4 illustration. That gets stride, squash, claw
strike and secondary motion, but it cannot do anything the drawing does not contain. In order of how much each would improve
the game:

1. **Clean layered Clax, same pose as now, parts fully painted where they overlap.** Transparent PNGs, about 650px tall, registered
   on one canvas: torso (with the ring arms complete behind the gauge and the dome), head/dome, shrimp pilot *without* water,
   upper claw arm, upper pincer, lower pincer, hose arm in two segments, glove, two spring shafts, two boots.
   The current cut leaves small unpainted notches behind the claw arm and the neck that only show at large rotations.
2. **Shrimp expressions** inside the dome, same size and registration: smug (current), panicked, furious, determined, dazed.
   The rig can swap these on hurt, dash, float and victory. The water is drawn by code, so the pilot layer should have none.
3. **A true side-on run pose set** (contact, passing, drive, airborne) if the run should read as a side view rather than a
   3/4 shuffle. This is the one thing a rig cannot fake.
4. **Open-claw pincer pair** painted open, so the strike does not rely on rotating the closed jaw away from the shell.
5. **Enemies as two or three parts each** (body + the one thing that moves: crab claw, drone rotor, eel head, warden arm,
   puffer megaphone). They currently squash and bob as single images.
6. **Survivor characters** to replace the placeholder pods: nine small portraits (see docs/STORY.md) and one "in pod" body.
7. **Dot**: a portrait for the radio and dialogue box.
8. **Terrain trims** per district, tileable at 64px: top cap, wall face, interior back wall, deck. The current terrain is drawn
   by code over the three supplied metal textures.

The two sheets in `docs/reference/` were used as pose and water-behaviour targets. They are too small to cut parts from
(each part is roughly 100px) and their line style differs from the in-game painting, so nothing in the build is taken from them.

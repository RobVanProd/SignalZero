# CLAX — The Unsinkable (build 0.2)

A 2D action platformer: a tiny shrimp steals a rescue suit and has to rescue a harbor from its own safety bureau.
One self-contained HTML file, no dependencies at runtime, works offline.

**Play:** open `dist/Clax_Play.html` in a browser. The untouched 0.1 prototype is kept in `prototype/` for comparison.

| | |
|---|---|
| Move | `A` / `D`, arrows, left stick |
| Jump → vent-hop → float | `Space` / `W` / `Z`, pad A. Press again in the air to hop; keep holding after the hop to inflate and float (spends pressure) |
| Snap claw / grab a ring | `J` / `X`, pad X. In mid-air near an overhead ring the claw grabs it: steer the swing with left/right, jump to let go. Hold up to snap upward |
| Vent-dash | `K` / `Shift` / `C`, pad B |
| Wall slide / wall kick | push into a wall while falling, then jump |
| Crouch / drop through a deck | down · down + jump |
| Overpressure burst | `Q` / `L` / `E`, pad Y |
| Pause · mute · fullscreen | `Esc` / `P` · `M` · `F` |

## What changed from 0.1

- **Levels are places now.** 0.1 was a flat strip of ground with floating ledges placed by a loop. 0.2 is real 2D terrain on a 64px grid:
  slopes, cliffs, interiors with back walls, shafts, one-way decks, bounce floors, spikes, a scrolling camera on both axes.
  Each district is five named areas with its own idea (a ship you enter, descend and climb out of; a tower climbed floor by floor;
  a coaster you ride down into a trench and a wheel you ride back out). See `docs/LEVEL_DESIGN.md`.
- **Movement kit.** Wall slide and kick, hold-to-float, claw swing on rings (fixed and crane-carried), crouch, launch pads,
  momentum on slopes, falling off the world costs one hull point instead of a life.
- **Clax is a jointed rig**, cut from the approved illustration (`tools/cut_rig.py`): torso, head, claw arm, pincer, jaw, hose hand,
  two spring shafts and two boots. Poses are blended every frame, so the legs stride and compress, the claw winds up, lunges and
  snaps, the body squashes on landing, and the helmet water sloshes with acceleration.
- **Backgrounds** are drawn at full strength (0.1 drew them at 76% under two gradients and a layer of translucent boxes).
- **Story.** A through-line (the Incident Log), a reason the rescues matter, a turn in Act II, a real ending for Clax, radio chatter
  during play, nine named survivors. See `docs/STORY.md`.

## Build and test

```bash
node tools/build.js        # src/ + assets/ -> dist/Clax_Play.html
node tests/logic.js        # 30 physics checks (run speed, jump heights, slopes, walls, float, swing, platforms ...)
node tests/reach.js        # searches every level with the real physics: exit, checkpoints, survivors reachable; no soft-locks
node tests/browser.js      # headless Chromium: menus, input, random-input tours, bosses, results, touch, draw cost
python3 tools/cut_rig.py   # only if the character art changes (needs Pillow + numpy)
```

No npm install is needed. `tests/browser.js` expects Playwright with Chromium to be available.

## Layout

```
src/phys.js        player physics and tile collision (pure; shared by the game and the tests)
src/world.js       level builder DSL, the three levels, cast, script
src/game/*.js      fragments of the game loop, concatenated in name order (core, sim, tiles, rig, draw)
src/shell.html     page, menus and CSS      src/audio.js   synth soundtrack and effects
src/rig.json       part rectangles and pivots written by tools/cut_rig.py
assets/            WebP art (enemies, backgrounds, textures, rig_* parts)
tools/dump.js      ASCII map of a level: node tools/dump.js 0
docs/              story, level design notes, art requests, reference sheets
```

## Honest status

Verified by the tests above: the physics does what the numbers say, every level can be finished and every survivor reached
with the real movement code, nothing throws under random input, bosses and the results flow work.

Not verified by anything: whether it *feels* good. Timing, difficulty, enemy placement, how readable the swing is at speed
and whether the walk reads as weight are judgement calls that need a person with a controller. Not tested on physical
phones, physical gamepads, Safari or Firefox. Enemies and bosses still use single-image cut-outs with squash and stretch;
only Clax is rigged. `docs/ART_REQUESTS.md` lists the drawings that would help most.

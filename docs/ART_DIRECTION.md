# Art direction — "Night Ink"

## Thesis

**Signal is light.** The district is drawn as an ink illustration printed in a handful of flat inks. Nothing in the world glows unless it is live signal: link LEDs, packets in flight, screens, the windows of districts whose services work. A broken network is a dark drawing; fixing it puts the light back. The title is the moment before that happens.

The rule is also diagnostic. Every glow means something, so a player can read state from the scene: a dark district, an amber LED, a red pulse on a cable in a storm, a terminal still lit on a dead floor.

## Rules

1. **Only signal emits.** Emitted light must clear the signal threshold (peak ≥ ~1.3 in linear HDR). Everything else is reflected light and is capped at paper white (`PAPER_MAX` in `src/world/style.js`), so a brightly lit surface can never be mistaken for a light source. Decorative glow strips were removed or demoted to printed trim.
2. **Five inks for the world.** Shadow-to-light ramp: ink `#0a0d1f` → night `#18204a` → slate `#34437e` → haze `#8a8fb4` → paper `#f0e6cf`. Surfaces keep about a third of their own hue, so cable colours, wood and plants still read.
3. **Four inks for meaning.** Phosphor `#3dffb4` = healthy, sodium `#ffa53b` = attention or action (and the city's streetlight colour), fault `#ff3d5a` = failure, data `#5cc8ff` = traffic. The same four mean the same thing in the 3D world, on in-world screens and in the UI.
4. **Scratchboard line.** Every silhouette and crease is outlined. In shadow the line is scratched out in a light ink; in light it is drawn in dark ink. Lines fade with distance so the skyline stays clean.
5. **Halftone, not gradients.** Tone steps through five bands with a rotated dot screen between them. The sky and the UI use the same dot language.
6. **Print, not glass.** UI panels are printed work orders: flat fills, 1.5 px rules, hard offset shadows, perforated edges, rubber stamps. No blur and no glassmorphism.
7. **Civic type.** Big Shoulders Display (condensed signage) for headings and signs, IBM Plex Mono for anything a device says, IBM Plex Sans Condensed for prose. All OFL, embedded so the game stays one offline file.

## How it is rendered (`src/world/style.js`, `renderer.js`)

Scene (cel-shaded toon materials, paper-capped) → **Ink pass** (outline + palette + halftone + signal pass-through) → bloom (medium/high only, so only signal blooms) → **Print pass** (plate misregistration, paper grain in display space, ink vignette, alarm wash, highlight shoulder) → sRGB → FXAA.

- Outlines use the screen-space Laplacian of 1/z from the depth buffer. For any plane, 1/z is affine in screen space, so the Laplacian is zero on flat surfaces and fires only at silhouettes and creases. No normal buffer and no second scene render are needed. The depth texture is 32-bit float.
- All three quality tiers draw the same style. Low drops bloom and FXAA and renders at 1× pixel ratio.

## Verified vs not

- Verified with SwiftShader (software WebGL 2) screenshots at 1280×720 medium and 412×860 low: lines, palette, halftone, signal pass-through, embedded fonts in canvas textures and DOM, no page errors.
- **Not verified:**
  - Frame rate on real GPUs and phones. The ink pass adds 9 depth taps and 1 colour tap per pixel on every tier.
  - Whether players find the style readable over a full shift, and whether "glow means signal" actually helps them diagnose. Both belong in the playtest. Watch for players misreading halftone as noise and for eye strain from the dot screen.

## Adding content

- New light sources that are not signal (lamps, signs) must stay under the paper cap: emissive ≤ ~0.6.
- New status lights use the four meaning inks, scaled into HDR (`ink(INK.phosphor, 1.7)` in `world.js`).
- New in-world screens draw light glyphs on `SCR.bg` with `FONT.*` from `src/world/screens.js`.

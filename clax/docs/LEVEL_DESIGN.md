# Level design notes

## Why 0.1 felt flat, specifically

`world.js` in 0.1 built every stage the same way: seven or eight ground slabs at almost the same height (y 600–626 on a
720px screen), ledges at three fixed offsets above them, one enemy every 390px from a rotating list, tags on everything.
The camera never moved vertically. There were no walls, slopes, ceilings or interiors, so nothing could be *entered*,
*climbed* or *descended*, and one screen was interchangeable with the next.

## What a level is made of now

64px tiles, authored with a small DSL in `src/world.js` (`node tools/dump.js <n>` prints the result as ASCII):

| Call | Meaning |
|---|---|
| `T(c, r, 'F8 d3 U2 G4 O3 S-2 ...')` | terrain profile walking right: `F` flat, `U`/`D` 45° up/down, `u`/`d` gentle up/down, `G` gap (pit), `O` bounce floor, `S±n` cliff |
| `R` / `C` / `BK` | fill a solid rectangle / carve a room / paint interior back wall |
| `deck`, `spikes` | one-way decks, hazard tiles |
| `hook`, `mover`, `crumble`, `wheel`, `spring` | rings (fixed or travelling), platforms, crumbling platforms, ferris-wheel gondolas, springs and launch pads |
| `E`, `npc`, `cp`, `tags`, `arc`, `trail`, `item`, `crate`, `vent` | enemies, survivors, checkpoints, pickups, hazards |
| `area`, `radio`, `hint`, `sign`, `deco` | title cards, story beats, tutorial prompts, set dressing |

Movement budget to design against (measured by `tests/logic.js`): jump 168px (2 tiles), vent-hop total 304px (4 tiles),
spring 275px, flat jump about 4.5 tiles, float and dash extend that a lot. Any wall can be kicked up, so vertical gates
are ceilings, not heights.

## The districts, area by area

**01 Sunken Rescue Yard** — teaches the kit, mostly horizontal with one big vertical detour.
Slipway Nine (downhill start, first gap) → The Heap (rolling scrap hills, first ring swing, high decks) →
The S.S. Caution (enter through a hull breach; hatch down to the bilge for Mabel; boiler room; climb the funnel by decks or
wall kicks; out onto the top deck; slide down the bow) → Gantry Line (travelling crane rings over a long pit, with a slow
platform underneath as the fallback) → The Pump House (boss).

**02 The Inflatable Fortress** — vertical. You gain about 40 tiles of height.
Visitor Processing (stepped terraces, first bounce floors) → The Bouncy Bailey (bounce courtyard, turret, spring up the
inner wall) → The Tower of Forms (interior, four storeys, lifts and decks or wall kicks) → The Ramparts (crenellations,
rings over the gaps, a launch pad) → The Director's Office (boss).

**03 Pressure Trench Carnival** — down, through, and up again.
The Midway (stalls and crumbling platforms) → The Coaster of Liabilities (a long slope run into the trench with launch pads) →
The Hall of Refunds (fun-house interior; the mirror shaft is an optional climb) → The Big Wheel (ride a gondola out of the
trench) → The Refund Department (boss).

Rules used throughout: the main road never requires the hardest technique (every swing gap has a platform fallback, every
wall climb has decks or a lift); survivors are always off the main road; each area introduces one idea and has a title card.

## Known weak spots (design, not bugs)

- Enemy placement was authored blind against the map, not tuned by play. Expect some unfair or dull spots.
- Boss arenas are flat floors with two decks; boss behaviour is unchanged from 0.1.
- No mid-level set-piece is scripted (nothing collapses, chases or floods). The S.S. Caution wants one.
- Interiors share one wall treatment per district.

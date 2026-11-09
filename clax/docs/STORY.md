# CLAX — story bible, revision 2

Revision 1 had a premise and jokes but no engine: the rescues did not matter to the plot, the villain did not change,
and Clax ended exactly where he started. This revision keeps the cast and the voice and adds a spine.

## The spine: the Incident Log

Port Flounder's Bureau of Guaranteed Safety has nine years of **zero recorded incidents**, achieved by not recording them.
When the public air pumps fail, Director Drydock classifies it as an "unapproved emergency" and locks the pumps pending review.

ADA, the suit's assessor, is a Bureau machine and plays by Bureau rules: *an emergency exists once witnesses are entered in the
Incident Log, three per district.* So every survivor Clax reaches is not a collectible, it is a signature. Each one makes the
Bureau's clean record harder to keep, and the HUD counts them as **witnesses**.

The log has one more line: **Rescuer**. It needs a licensed name. Clax, Barnacle Scraper Third Class, forty-one rejected
applications to the Rescue Corps, wants that line more than anything.

## Three acts

**I. Unauthorized Departure — Sunken Rescue Yard.** Clax takes the decommissioned Unsinkable off Slipway Nine. Dot, the
harbor courier, knows everyone who is missing by name. The yard is a monument to the Bureau's logic: lifeboats scrapped
because boats imply sinking, an evacuation ship that never sailed because it was too risky. Foreman Clampright guards the
pump coupler. Clax wants it carved on something expensive.

**II. Safety Is Mandatory — The Inflatable Fortress.** The Bureau's keep is built from flotation gear and paperwork.
People who came to complain were processed and never released. Drydock is beaten in his own office, and the turn lands:
**the relief valve is not there.** He outsourced the air to the carnival's Refund Department, which promised zero incidents,
guaranteed. "Leased. With an option to regret." The villain of Act II is the hostage of Act III.

**III. No Refunds. No Escape — Pressure Trench Carnival.** The Refund Department owns the air and sells it by the breath.
Drydock, locked out of his own system, is forced onto Clax's radio to read the fine print, because he is the only licensed
official in range. Dot finally says why this one is personal: her gran, Tilly, is at the top of the big wheel.
Clax's line from revision 1 now has a reason: "No speeches this time. Everybody gets out."

**Ending.** Clause nine: a logged rescue voids the lease, but the Rescuer line needs a licensed name. Drydock offers to sign,
and the Bureau gets the credit. ADA offers to enter Clax, which makes the log invalid. Clax has wanted the line for the
whole game. He gives it away: "Put down Pip. And Mabel. Gus. Tilly. All of them. They did the hard part. They waited."
The witnesses become the rescuers of record, the lease is void, the pumps restart. ADA: "License: denied. Rescuer: confirmed."
He asks for a plaque. "I have logged that as a no."

## Cast rules (unchanged unless noted)

- **Clax** claims competence; the joke is the gap between the claim and the landing. He is vain, not cruel. New: he has a
  specific grievance (41 rejections) and a specific want (the Rescuer line), so the ending costs him something.
- **ADA** reports what happened, never insults. "I have logged that as a landing." New: she is the keeper of the log, so
  her procedure is the plot rather than commentary on it.
- **Dot** gives the emergency names and faces. New: she holds back about Tilly until Act III.
- **Drydock** confuses a clean report with a safe town. New: he is not the final villain; he is a man who signed something
  and cannot admit it. In Act III he helps, badly, in character: "They are participation awards. I participated in giving them to myself."
- **The Refund Department** never changes its cheerful wording. It is what the Bureau's system produces when nobody is in it.

## Survivors (witnesses)

| District | Name | Who | Where |
|---|---|---|---|
| Yard | Pip | the lamp-keeper's kid | up on the Heap's high decks |
| Yard | Mabel | cook of a ship that never left | the bilge of the S.S. Caution |
| Yard | Gus | crane operator, up there since Tuesday | on the hanging gantry cab |
| Fortress | Otto | filed a complaint in person | above the Bouncy Bailey |
| Fortress | Nell | queue number 4,000,112 | third floor of the Tower of Forms |
| Fortress | Brine | former safety inspector | a deck over the rampart gap |
| Carnival | Lulu | grand prize winner (it was a bill) | on the Midway stall roofs |
| Carnival | Fitz | ride operator | top of the mirror shaft in the Hall of Refunds |
| Carnival | Tilly | Dot's gran | the little deck above the hub of the Big Wheel |

## Where it lives in the build

Intro and outro scenes, radio beats (non-blocking, triggered by position), area title cards, signs, banners and survivor
lines are all data in `src/world.js`. Not implemented: voice, a Dot sprite, any cutscene art, consequences for missing witnesses
(the ending plays the same with 0 of 9; a short variant where the log is thin would be the obvious next step).

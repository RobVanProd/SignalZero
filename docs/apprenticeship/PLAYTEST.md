# Playtest guide: does Lesson 1 close the knowledge gap?

The automated tests show the lesson can be completed and that its network behaves like real Linux. They cannot show that a person understands anything afterwards, or enjoys it. This guide is for finding that out before any further lessons are built.

## Claim being tested

After Lesson 1, a player who could not do this before can (a) explain how a host decides where to send a packet, and (b) diagnose an unfamiliar default-gateway or return-path fault, using evidence, without step-by-step help.

## Agree these thresholds before the session

Proposed. Change them before you play, not after.

| Measure | Source | Pass |
|---|---|---|
| Transfer case (step 10) fixed **without** "I'm stuck: show me" | log: `lesson-giveup` absent | Yes |
| Explanation names the cause **and** cites evidence (rubric below) | log: `lesson-explain` text | Score ≥ 2 of 3 |
| Delayed check (48–72 h, the *other* transfer fault, link below) fixed without help | facilitator notes + log | Yes |
| Predictions right in steps 3–7 | log: `lesson-predict` | Not a gate. Record it to see which ideas were new. |
| Where you got stuck or could not find a control | your notes | Each such moment is an interface defect, not a learning failure |

Decision rule: if the transfer case or the delayed check fails, change this lesson before building Lesson 2. If both pass but the explanation scores below 2, the lesson teaches procedure without understanding: fix the explain-back and prediction steps first.

Explanation rubric (score 0–3, one point each):
1. Names the faulty setting and the device (e.g. "PC-A's default gateway was PC-B's address"; "the server had no default route").
2. Cites observed evidence (e.g. `ip route` showed …; `ip neigh` showed PC-B's MAC; no error lines, only loss).
3. States the mechanism (e.g. "PC-B is not a router, so it drops packets for other addresses"; "the reply had no route back").

## Session (about 35 minutes)

1. Fresh start: Settings → Reset → Delete all local data, or use a private browser window.
2. Before playing, write one sentence: "When my PC sends a packet to a server on another network, what does it do?" Keep it for later comparison.
3. Title screen → **Apprenticeship · Lesson 1**. Play normally. Do **not** use the placement check the first time.
4. Note every moment you were unsure what to do next, or knew what to change but not where.
5. At step 10, work it out yourself. Use "show me" only if you would otherwise quit; it is recorded.
6. Afterwards, answer the same question as in point 2 again, without looking.
7. Settings → Playtest log → **Export JSON**. The `lesson-*` events contain predictions, answers, hints, refreshers, commands and step times.

## Delayed check (48–72 hours later)

Open the transfer case with the fault you did **not** get. The log's `lesson-finished` event says which one you got (`transferFault`); the lesson's summary card also names it.

- Gateway pointed at another PC: `<game URL>?lesson=L01&start=transfer&fault=gateway-is-host`
- Server without a return route: `<game URL>?lesson=L01&start=transfer&fault=no-return`

Live build: `https://robvanprod.github.io/SignalZero/?lesson=L01&start=transfer&fault=no-return`.

No hints, no lesson text before it. Record: fixed (yes/no), minutes, used "show me" (yes/no), and the explanation score.

## Optional: does it transfer outside the game?

On any Ubuntu or Debian machine (a VM is fine), `sudo bash docs/apprenticeship/lab/bench-lab.sh` builds the same network from real kernels. To use it as an exercise, comment out the scenario section, then break one thing by hand (for example `ip netns exec pca ip route replace default via 192.168.10.254`). Diagnose it with `ip netns exec pca …` commands. If the game taught the mechanism, the real network should feel familiar.

## What to send back

The exported JSON, your before/after sentences, the delayed-check record, and your list of stuck moments.

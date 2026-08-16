# Vanishing Point Hunt 🔭

A perspective drill for [Art Daily](https://artdaily.sadeali.com/). Every scene is a
city block seen through a **real camera**: a level pinhole with a sampled focal
length, principal point and yaw, solid 3D blocks standing on the ground plane, and
every vertex divided by its own depth. The two vanishing points are then simply the
projections of the two horizontal directions, so `(vpL − pu)(vpR − pu) = −f²` holds
by construction — every scene is a city a real lens could have photographed, and the
ground truth for scoring is exact rather than approximately right. Eye height is the
unit, so a base sitting δ below the horizon is at depth `f/δ` and a roof τ above it
is `1 + τ/δ` eye heights tall: the artist's eye-level rule, enforced by geometry.

Two ways to hunt, both scored the same way:

- **Drag** the dashed guide onto the hidden horizon and park a ⊕ marker on each VP.
  A press anywhere with nothing under it drops the guide right there and keeps
  dragging, so the first thing you try is never a no-op. The ⊕s ride the line — slide
  one sideways to move that VP, pull it up or down and the horizon comes with it.
  Arrow keys nudge (shift = fine), space swaps ⊕, enter locks.
- **Trace edges** — the easel habit. Draw along two receding edges of the same wall
  and where your strokes cross *is* that vanishing point; two strokes per VP, and the
  horizon falls out of the two crossings. Strokes are fitted by total least squares,
  a too-short stroke or a parallel pair is refused for free, and undo pops the last one.

Three scenes per round, ramping up: smaller blocks, shorter edges, one VP hugging the
frame. Scoring is pure distance — horizon 40%, each VP 30% — with full credit inside a
small bullseye (1.5% of the height, 2% of the width) so an honest 100 is earnable,
fading to zero at 12% of the height for the horizon and 15% of the width for a VP. The
round score is the mean of three, reported the moment the third scene locks. After each
lock the reveal draws the true horizon, both VPs, every construction edge extended to
them, and a connector from each of your ⊕s to the VP it was scored against.

Run it: `python3 -m http.server 8080` in this folder. No build step, no dependencies.

Part of [Art Daily](https://artdaily.sadeali.com/) · a [sadeali.com](https://sadeali.com/) experiment

## What changed in the input-fairness pass

Scene 1 is scored gently and tightens by scene 3 — before this the
geometry ramped while the bands did not, so difficulty compounded twice.
Both bands carry an absolute pixel floor (a phone was being held to half
a desktop's tolerance) and are eased per hardware. In trace mode the
near-parallel guard moved from 3° to 11.5° and says why a pair was
refused, the first and last tenth of a stroke are dropped before fitting
(every mouse drag has an acceleration hook), the minimum stroke is
longer, and the line you are drawing is extended live so you can steer
it. "VPs" and "the accent" are gone from player-facing copy.

## Input fairness

Scores are only ever compared against your own history, so the drill
eases its tolerances for the hardware in your hand and says which one it
eased for (the "scoring for…" chip in the HUD). A pen keeps the strict
reference; a mouse or trackpad, which pivots at the wrist and cannot
creep, gets roughly double the room; a finger sits between. Start and
grab zones move the other way — a screenless tablet needs the *biggest*
targets, because the hand is out of sight. Relative tolerances carry an
absolute pixel floor so a phone is never held to a stricter standard
than a desktop for the same drill.


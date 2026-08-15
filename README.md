# Vanishing Point Hunt 🔭

A perspective drill for [Art Daily](https://artdaily.sadeali.com/). Every scene is a
flat-shaded city block rendered from a hidden horizon and two on-canvas vanishing
points. Drag the dashed guide onto the horizon, park a ⊕ marker on each VP, lock it
in — the reveal overlays the true geometry so you see exactly how far off you were.

Three scenes per round, ramping up: smaller boxes, shorter edges, one VP hugging the
frame. Scoring is pure distance — horizon 40% (zero at 12% of canvas height off),
each VP 30% (zero at 15% of canvas width off); the round score is the mean of three.

Run it: `python3 -m http.server 8080` in this folder. No build step, no dependencies.

Part of [Art Daily](https://artdaily.sadeali.com/) · a [sadeali.com](https://sadeali.com/) experiment

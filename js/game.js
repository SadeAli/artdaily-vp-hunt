/* ============================================================
   game.js — Vanishing Point Hunt. Each round shows three city
   scenes photographed by a REAL camera: a level pinhole with a
   sampled focal length, principal point and yaw, boxes built as
   solid 3D blocks on the ground plane, every vertex divided by its
   own depth. The two vanishing points are then the projections of
   the two horizontal directions — (vpL−P)·(vpR−P) = −f² holds by
   construction, so every scene is a city a real lens could have
   seen, and the ground truth for scoring is exact.

   Two ways to hunt: drag the dashed guide onto the horizon and a ⊕
   onto each VP, or press "trace edges" and do it the way you would
   at the easel — draw along two receding edges of the same wall and
   where your strokes cross IS the vanishing point.

   Scene geometry is stored in normalized 0–1 coords so resizes
   never change the puzzle. Scoring lives in pure functions at the
   top — inputs in, 0–100 out.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'vp-hunt';
  var SCENES_PER_ROUND = 3;
  var ASPECT = 0.62;          /* canvas height ÷ canvas width */
  var LOCK_MS = 350;          /* a double-tap must never skip a reveal */

  /* ============ pure scoring (px in, 0–100 out) ============ */

  /* Full credit inside a small bullseye, nothing past the outer ring —
     both as fractions of the canvas. The plateau is what makes 100
     earnable: sub-pixel luck should not decide 100 vs 97. */
  var H_FULL = 0.015, H_ZERO = 0.12;   /* fractions of canvas height */
  var V_FULL = 0.02, V_ZERO = 0.15;    /* fractions of canvas width  */

  /* Scene 1 is where the words "vanishing point" and "horizon" are still
     being learned, so its bands open wide and tighten to the values above
     by scene 3. Before this the GEOMETRY ramped (scene 3 shoves a VP to
     the frame edge) while the bands did not, so difficulty compounded
     twice and a first-timer's honest read scored 20-40. */
  var BAND_EASE = [1.5, 1.2, 1.0];
  function bandEase(sceneIdx) {
    var k = BAND_EASE[sceneIdx];
    return (typeof k === 'number' && isFinite(k)) ? k : 1;
  }

  /* A relative band collapses on a small screen: 0.015·H is 6.5px on a
     desktop sheet and 3px on a phone, i.e. the least precise device gets
     the strictest standard for the identical drill. Floor both bands in
     absolute pixels, and ease that floor for the hardware in hand — a
     trackpad cannot creep the way a mouse on a desk can. */
  var H_FULL_PX = 8, H_ZERO_PX = 40;
  var V_FULL_PX = 10, V_ZERO_PX = 48;

  function clampRange(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  /* NaN-safe: any non-comparable input falls to 0. clampRange cannot be,
     because a NaN there has to stay visible as a broken coordinate, but
     the scoring path must not be able to hand one on: NaN fails BOTH
     comparisons in a clamp written as a pair of ternaries, so it sails
     straight through and 100 × NaN is NaN. */
  function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }

  /* The bands themselves are checked, not just the distance. A band that
     is not a finite width apart makes (zero − dist) / (zero − full) come
     out Infinity/Infinity = NaN for the ONE input that ought to score
     best — a dead-centre guess — and that NaN then reaches the HUD, the
     score stamp and the permanent best as literal text. A band that is
     not a band scores nothing instead. With the drill's own constants
     zero is always comfortably greater than full, on every sheet size
     and through every ease, so this is the identity in real play. */
  function bandScore(dist, full, zero) {
    if (!isFinite(dist) || !isFinite(full) || !isFinite(zero) || !(zero > full)) return 0;
    return 100 * clamp01((zero - dist) / (zero - full));
  }

  /* Full marks within H_FULL of the line, zero at H_ZERO of the canvas
     height away. Degenerate input (zero/NaN size or coords) scores 0,
     never NaN. */
  function horizonScore(guessY, trueY, H, ease, slop) {
    if (!isFinite(guessY) || !isFinite(trueY) || !(H > 0)) return 0;
    var e = (typeof ease === 'number' && isFinite(ease) && ease > 0) ? ease : 1;
    var s = (typeof slop === 'number' && isFinite(slop) && slop > 0) ? slop : 1;
    var full = Math.max(H_FULL * H, H_FULL_PX * s) * e;
    var zero = Math.max(H_ZERO * H, H_ZERO_PX * s) * e;
    return bandScore(Math.abs(guessY - trueY), full, zero);
  }

  /* Full marks within V_FULL of the point, zero at V_ZERO of the canvas
     width away — with the same pixel floor and per-hardware ease. */
  function vpScore(gx, gy, tx, ty, W, ease, slop) {
    if (!isFinite(gx) || !isFinite(gy) || !isFinite(tx) || !isFinite(ty) || !(W > 0)) return 0;
    var e = (typeof ease === 'number' && isFinite(ease) && ease > 0) ? ease : 1;
    var s = (typeof slop === 'number' && isFinite(slop) && slop > 0) ? slop : 1;
    var full = Math.max(V_FULL * W, V_FULL_PX * s) * e;
    var zero = Math.max(V_ZERO * W, V_ZERO_PX * s) * e;
    return bandScore(Math.hypot(gx - tx, gy - ty), full, zero);
  }

  /* Match each guess to a distinct true VP — never both to the same
     one. Of the two possible pairings, the better-scoring one wins;
     `swapped` says the left ⊕ was read against the right VP, so the
     reveal can draw honest connectors. */
  function vpPairing(g1, g2, t1, t2, W, ease, slop) {
    var a = [vpScore(g1.x, g1.y, t1.x, t1.y, W, ease, slop), vpScore(g2.x, g2.y, t2.x, t2.y, W, ease, slop)];
    var b = [vpScore(g1.x, g1.y, t2.x, t2.y, W, ease, slop), vpScore(g2.x, g2.y, t1.x, t1.y, W, ease, slop)];
    return (a[0] + a[1] >= b[0] + b[1])
      ? { scores: a, swapped: false }
      : { scores: b, swapped: true };
  }

  /* horizonScore/vpScore can only hand these finite 0–100 values, but a
     scoring function that can emit NaN is one refactor away from writing
     "NaN" into the HUD and the permanent best, so it refuses to — and it
     refuses a finite number outside 0–100 for exactly the same reason,
     because "3e+307 / 100" on the score stamp is no better than "NaN".
     Clamping is the identity on every value this drill has ever produced. */
  function finiteScore(v) {
    return (typeof v === 'number' && isFinite(v)) ? clampRange(v, 0, 100) : 0;
  }

  function sceneScore(h, v1, v2) {
    return 0.4 * finiteScore(h) + 0.3 * finiteScore(v1) + 0.3 * finiteScore(v2);
  }

  /* ---- reveal coaching: WHICH WAY the guess was off ----
     The first reveal a beginner ever sees used to be four numbers
     ("62/100 (eye level 71 · vanishing points 55, 60)") — and those same
     four numbers are already stamped on the sheet, under their own labels,
     where the eyes are. Repeating them in the hint spent the one sentence
     the drill gets on arithmetic instead of on the lesson. Direction is the
     lesson: "too low", "left of it" is a thing you can DO differently next
     scene. Pure — pixel deltas in, English out, NaN-safe. */
  function offBy(d, neg, pos) {
    if (!isFinite(d)) return 'off the sheet';
    return Math.round(Math.abs(d)) + 'px ' + (d < 0 ? neg : pos);
  }

  /* A ⊕ RIDES THE GUIDE, so its vertical error IS the line's error — and
     this used to be judged on the horizontal miss alone. Park the guide
     90px above the true eye level with both ⊕s in perfectly the right
     columns and the first reveal a beginner ever reads said "the left ⊕
     landed right on its point, the right ⊕ right on its point" next to a
     score of 40, because both marks in fact scored near zero. The one
     sentence the reveal gets may not contradict the number beside it:
     sideways-aligned but riding a missed line is now said out loud. */
  function markPhrase(dx, dy) {
    if (!isFinite(dx)) return 'off the sheet';
    if (Math.abs(dx) >= 6) return offBy(dx, 'left of it', 'right of it');
    if (isFinite(dy) && Math.abs(dy) >= 6) return 'straight ' + (dy < 0 ? 'above' : 'below') + ' it';
    return 'right on its point';
  }

  /* dy > 0 means the guide sat lower on the sheet than the true eye level;
     dx > 0 means a ⊕ sat right of the vanishing point it was read against.
     Both VPs sit ON the true eye level and both ⊕s sit ON the guide, so
     the same dy is every mark's vertical miss. */
  function coachLine(dy, dxL, dxR) {
    return (isFinite(dy) && Math.abs(dy) < 4
      ? 'your line was right on the eye level'
      : 'your line sat ' + offBy(dy, 'too high', 'too low')) +
      '; the left ⊕ landed ' + markPhrase(dxL, dy) +
      ', the right ⊕ ' + markPhrase(dxR, dy) + '.';
  }

  function roundScore(scores) {
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += finiteScore(scores[i]);
    return scores.length ? sum / scores.length : 0;
  }

  /* ---- stroke geometry: a traced edge becomes an infinite line ----
     Total-least-squares fit (the dominant eigenvector of the 2×2
     scatter matrix), so a stroke drawn steeply is fitted as fairly as
     a flat one. Returns null for anything too short to mean an edge —
     a stray tap must cost nothing. */
  /* Every mouse and trackpad drag opens with an acceleration hook and
     closes with a deceleration hook, and a total-least-squares fit
     weights those end samples exactly as much as the honest middle. On a
     short stroke they dominate. Drop the first and last tenth before
     fitting — the middle is the part the hand actually meant. */
  function trimHooks(pts) {
    var n = pts.length;
    if (n < 12) return pts;
    var cut = Math.floor(n * 0.1);
    return pts.slice(cut, n - cut);
  }

  function fitStrokeLine(raw, minLen) {
    var pts = trimHooks(raw || []);
    var n = pts.length, i, sx = 0, sy = 0, dx, dy;
    if (n < 2) return null;
    for (i = 0; i < n; i++) { sx += pts[i].x; sy += pts[i].y; }
    var mx = sx / n, my = sy / n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      dx = pts[i].x - mx; dy = pts[i].y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (!isFinite(sxx) || !isFinite(syy) || !isFinite(sxy)) return null;
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var ux = Math.cos(th), uy = Math.sin(th);
    var lo = Infinity, hi = -Infinity, t;
    for (i = 0; i < n; i++) {
      t = (pts[i].x - mx) * ux + (pts[i].y - my) * uy;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (!(hi - lo >= minLen)) return null;
    return {
      x: mx, y: my, ux: ux, uy: uy, len: hi - lo,
      a: { x: mx + ux * lo, y: my + uy * lo },
      b: { x: mx + ux * hi, y: my + uy * hi },
    };
  }

  /* Where two fitted edges cross — null when they are too near parallel
     for the crossing to mean anything.
     The guard used to sit at |sin θ| < 0.05, i.e. 3°. But between 3° and
     ~12° the crossing is wildly unstable: 3° of wobble in one line moves
     it by ~0.3× the distance to it, so 60px at 200px out. The drill
     accepted that silently and then WROTE it into the player's answer, so
     a beginner tracing two near-parallel roof lines with a mouse got
     garbage handed back as their own construction. 0.20 ≈ 11.5°, and the
     caller now says out loud why a pair was refused. */
  var PARALLEL_SIN = 0.20;
  function intersectFits(l1, l2) {
    if (!l1 || !l2) return null;
    var d = l1.ux * l2.uy - l1.uy * l2.ux;
    if (!isFinite(d) || Math.abs(d) < PARALLEL_SIN) return null;
    var t = ((l2.x - l1.x) * l2.uy - (l2.y - l1.y) * l2.ux) / d;
    if (!isFinite(t)) return null;
    return { x: l1.x + l1.ux * t, y: l1.y + l1.uy * t };
  }

  /* ============ chrome refs + SDK ============ */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnLock = document.getElementById('btnLock');
  var btnTrace = document.getElementById('btnTrace');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks ----
     getComputedStyle() on the root forces the style engine to resolve, and
     this used to run at the top of EVERY repaint — i.e. once per pointer
     sample while a ⊕ is under the finger, plus five string reads and, via
     readable(), a hex parse and an rgb() string build per marker. The
     tokens only move when the sheet flips theme, so cache them against
     data-theme: the cache invalidates itself the moment the attribute
     changes, whoever changed it, so onTheme still repaints in the new
     colours without needing to be told. */
  var inkCache = null, inkKey = null;
  function inks() {
    var key = document.documentElement.dataset.theme || '';
    if (inkCache && inkKey === key) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var c = {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      line: cs.getPropertyValue('--line').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sky').trim(),
    };
    var m = hexRgb(c.muted), i = hexRgb(c.ink);
    c.soft = (m && i) ? mixColor(m, i, 0.45) : c.ink;
    inkKey = key;
    inkCache = c;
    return c;
  }

  function hexRgb(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixColor(f, t, k) {
    return 'rgb(' + Math.round(f[0] + (t[0] - f[0]) * k) + ',' +
      Math.round(f[1] + (t[1] - f[1]) * k) + ',' +
      Math.round(f[2] + (t[2] - f[2]) * k) + ')';
  }

  /* --muted alone sits just under 4.5:1 on the paper card, so anything
     meaning-bearing (the player's own guide, the score stamp) gets inked
     toward graphite until it clears AA on both sheets. Mixed once per
     theme in inks(), not once per stroked marker. */
  function readable(c) { return c.soft || c.ink; }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     Returns true only when the sheet actually changed size. Assigning
     canvas.width reallocates and clears the backing store, and on a phone
     `resize` fires on every address-bar nudge — re-fitting for a frame
     that is identical to the one already there is pure cost, and it is
     also what let an ordinary scroll drop a gesture in flight. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var dpr = window.devicePixelRatio || 1;
    if (w === W && dpr === fitDpr) return false;
    W = w;
    H = Math.round(W * ASPECT);
    fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---- one repaint per frame ----
     A pointermove can arrive two or three times per displayed frame (and
     with coalesced samples, far more), and every one of them used to
     repaint the whole sheet: washes, five solid blocks, their facades,
     the strokes, a live total-least-squares refit. Only the last of those
     frames is ever shown, so the rest is work done to be thrown away —
     and on a phone it is exactly the work that makes a drag feel like it
     is being dragged through treacle. Fold them into one rAF: the paint
     still lands on the same vsync, the frames in between are simply not
     painted twice. */
  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
  }

  /* ============================================================
     scene generation — a real level pinhole camera

     Eye at the origin, optical axis down +Z, world Y up, no roll and
     no tilt: verticals stay vertical and the horizon is exactly the
     row through the principal point. Image coords are in units of the
     canvas WIDTH (u across, v down):

         u = pu + f·X/Z          v = pv − f·Y/Z

     Two perpendicular horizontal directions
         A = ( cos φ, 0, sin φ)   →  vpR = pu + f·cot φ
         B = (−sin φ, 0, cos φ)   →  vpL = pu − f·tan φ
     give (vpR − pu)(vpL − pu) = −f². Sampling f and φ FIRST — instead
     of dropping two VPs on a line and hoping — is what guarantees a
     plausible focal length exists for every scene.

     Eye height is the unit, so a base sitting δ below the horizon is
     at depth Z = f/δ, and a top τ above it is 1 + τ/δ eye heights
     tall. That is the artist's eye-level rule, enforced by geometry.
     ============================================================ */

  var VP_EDGE = 0.05;               /* keep VPs this far inside the frame */
  var VP_CORE = 0.20;               /* …and this far off the optical axis */
  var MIN_FACE = 0.015;             /* no visible face thinner than this */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Difficulty ramp within a round. `t` slides the camera's yaw across
     the whole legal window: 0.5 is a balanced two-point view, the ends
     push one VP out to the frame edge. base/top are the image offsets
     of a block's base below and roof above the horizon (canvas widths),
     depth is how far along the way to a VP a face runs. */
  var DIFF = [
    { boxes: 3, f: [0.30, 0.38], t: [0.36, 0.64], base: [0.13, 0.26], top: [0.18, 0.34], depth: [0.30, 0.46], low: 0.2, lw: 2 },
    { boxes: 4, f: [0.28, 0.36], t: [0.18, 0.82], base: [0.09, 0.18], top: [0.11, 0.22], depth: [0.18, 0.32], low: 0.25, lw: 1.7 },
    { boxes: 5, f: [0.26, 0.34], t: [0.02, 0.14], base: [0.05, 0.12], top: [0.06, 0.14], depth: [0.09, 0.18], low: 0.3, lw: 1.4, edge: true },
  ];

  /* Camera whose two VPs are both on the sheet, both clear of the
     optical axis, and derived from a single real (f, φ). */
  function makeCamera(d) {
    var pu = rand(0.44, 0.56);
    var pv = rand(0.26, 0.58) * ASPECT;
    var f, dLmin, dLmax, guard = 0;
    do {
      f = rand(d.f[0], d.f[1]);
      dLmin = Math.max(VP_CORE, f * f / (1 - VP_EDGE - pu));
      dLmax = Math.min(pu - VP_EDGE, f * f / VP_CORE);
    } while (dLmin > dLmax && guard++ < 24);
    if (dLmin > dLmax) { dLmin = dLmax = (dLmin + dLmax) / 2; }
    var t = d.t[0] + Math.random() * (d.t[1] - d.t[0]);
    if (d.edge && Math.random() < 0.5) t = 1 - t;   /* mirror the hard scene */
    var dL = lerp(dLmin, dLmax, t);
    var dR = f * f / dL;
    return {
      f: f, pu: pu, pv: pv,
      phi: Math.atan2(dL, f),        /* tan φ = dL / f */
      vpL: pu - dL, vpR: pu + dR,
    };
  }

  /* world → image, in canvas-width units */
  function projectW(cam, X, Y, Z) {
    return { u: cam.pu + cam.f * X / Z, v: cam.pv - cam.f * Y / Z };
  }

  /* image units → stored normalized coords (x over W, y over H) */
  function store(p) { return { x: p.u, y: p.v / ASPECT }; }

  function makeBox(cam, d, slot) {
    var sinP = Math.sin(cam.phi), cosP = Math.cos(cam.phi);
    var u0 = lerp(cam.vpL, cam.vpR, slot);

    /* base below the horizon → depth; roof above it → height. Both are
       clamped so the block stays on the sheet whatever the horizon. */
    var delHi = Math.min(d.base[1], ASPECT - 0.03 - cam.pv);
    var delLo = Math.min(d.base[0], delHi - 0.015);
    var del = rand(delLo, delHi);
    var tau;
    if (Math.random() < d.low) {
      tau = -rand(0.15, 0.5) * del;                 /* shorter than the eye */
    } else {
      var tauHi = Math.min(d.top[1], cam.pv - 0.03);
      var tauLo = Math.min(d.top[0], tauHi - 0.02);
      tau = rand(tauLo, tauHi);
    }

    var Z = cam.f / del;                            /* eye height = 1 unit */
    var X = (u0 - cam.pu) * Z / cam.f;
    var hgt = 1 + tau / del;                        /* in eye heights */

    /* Face widths are sampled as image fractions of the way to their VP
       (t = a·sinφ/(Z + a·sinφ) for the A face) and converted back to
       world extents, so the tuned look survives the 3D rebuild. The
       floor keeps small blocks from degenerating into slivers. */
    var tA = rand(d.depth[0], d.depth[1]);
    var tB = rand(d.depth[0], d.depth[1]);
    tA = Math.max(tA, Math.min(0.5, MIN_FACE / Math.max(0.02, cam.vpR - u0)));
    tB = Math.max(tB, Math.min(0.5, MIN_FACE / Math.max(0.02, u0 - cam.vpL)));
    var a = Z * tA / ((1 - tA) * sinP);
    var b = Z * tB / ((1 - tB) * cosP);

    /* eight real corners: P is the near vertical edge, +a runs to the
       right VP, +b to the left VP, both away from the eye */
    var yB = -1, yT = -1 + hgt;
    function corner(ka, kb, y) {
      return projectW(cam,
        X + ka * a * cosP - kb * b * sinP,
        y,
        Z + ka * a * sinP + kb * b * cosP);
    }

    /* facade: window rows converge to the VPs, mullions stay vertical —
       real 3D lines, so the clues they give are exact */
    var facade = [], i, k, nRows = 2 + Math.floor(rand(0, 3)), nCols = 1 + Math.floor(rand(0, 2));
    for (i = 1; i <= nRows; i++) {
      k = lerp(yB, yT, i / (nRows + 1));
      facade.push({ a: store(corner(0, 0, k)), b: store(corner(1, 0, k)) });
      facade.push({ a: store(corner(0, 0, k)), b: store(corner(0, 1, k)) });
    }
    for (i = 1; i <= nCols; i++) {
      k = i / (nCols + 1);
      facade.push({ a: store(corner(k, 0, yT)), b: store(corner(k, 0, yB)) });
      facade.push({ a: store(corner(0, k, yT)), b: store(corner(0, k, yB)) });
    }

    return {
      nT: store(corner(0, 0, yT)), nB: store(corner(0, 0, yB)),
      rT: store(corner(1, 0, yT)), rB: store(corner(1, 0, yB)),
      lT: store(corner(0, 1, yT)), lB: store(corner(0, 1, yB)),
      back: store(corner(1, 1, yT)),
      hasTop: hgt < 1,          /* roof visible only below eye level */
      facade: facade,
      depth: Z,
    };
  }

  function makeScene(diffIdx) {
    var d = DIFF[diffIdx];
    var cam = makeCamera(d);
    var boxes = [], i, s0, s1;
    for (i = 0; i < d.boxes; i++) {
      s0 = 0.26 + 0.48 * (i / d.boxes);
      s1 = 0.26 + 0.48 * ((i + 1) / d.boxes);
      boxes.push(makeBox(cam, d, rand(s0 + 0.02, s1 - 0.02)));
    }
    /* painter's algorithm: far blocks first, so near ones occlude */
    boxes.sort(function (p, q) { return q.depth - p.depth; });
    return {
      ty: cam.pv / ASPECT,
      vpL: { x: cam.vpL, y: cam.pv / ASPECT },
      vpR: { x: cam.vpR, y: cam.pv / ASPECT },
      boxes: boxes, lw: d.lw, sunLeft: Math.random() < 0.5,
      /* the camera that took the photograph, kept so the scene can be
         checked against (vpL−pu)(vpR−pu) = −f² */
      f: cam.f, pu: cam.pu,
    };
  }

  /* ============ round state ============ */

  var round = 0, sceneIdx = 0, sceneScores = [], scene = null;
  var phase = 'idle'; /* 'guess' → 'reveal' (per scene) → 'done' */
  var guess = { y: 0.8, v1: 0.3, v2: 0.7 };
  var selMarker = 1;  /* keyboard-selected ⊕ */
  var lastPair = null, lastParts = null;
  var lastFlip = 0;   /* time of the last phase change */

  /* traced-edge mode */
  var mode = 'drag';  /* 'drag' | 'trace' */
  var strokes = [];   /* fitted edges { a, b }, normalized — 2 per VP */
  var traceVP = [];   /* the crossings, normalized */
  var rawPts = null;  /* the stroke under the finger, in px */

  /* "recedes" was in all four prompts and explained nowhere. Say what a
     receding edge IS instead: one that runs away from you into the
     picture and gets smaller. */
  var TRACE_PROMPT = [
    'drag along a box edge that runs away from you toward the LEFT — one of the long edges going into the distance (1 of 2).',
    'now a second edge heading the same way, but higher or lower in the picture (2 of 2).',
    'good — now an edge running away toward the RIGHT (1 of 2).',
    'one more RIGHT-going edge, at a different height (2 of 2).',
  ];

  /* SCENE 1 TEACHES; SCENES 2 AND 3 GET OUT OF THE WAY.
     The same definition was re-read at the top of every scene, so two
     thirds of the sentences this drill gets were spent explaining a term
     the player had already been scored on twice — while scene 1 itself
     still never answered the two questions a beginner actually has on
     sight. WHY ARE THERE TWO MARKERS: two ⊕s appear on the sheet and the
     old wording ("slide a ⊕ onto each vanishing point") assumed you
     already knew there were two of them, and why. WHICH LINE AM I AIMING
     AT: "drop the dashed guide on the eye level" reads as though the eye
     level is something you can see, when the whole drill is that it is
     hidden and the dashed line is only your guess at it. And "a set of
     parallel edges" named nothing on the screen — the edges meant are the
     long ones running away from you, which is a thing you can point at.
     Answer all three once, on the screen where they are asked, then hand
     the sheet over. */
  function guessHint() {
    var n = 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — ';
    if (sceneIdx !== 0) {
      return n + 'drop the dashed guide on the hidden eye level, park a ⊕ on each vanishing point, then lock it in.';
    }
    return n + 'the long edges running away from you appear to meet at one spot: a vanishing point.' +
      ' this view has two, and they both sit on the hidden eye level. press anywhere to drop the dashed' +
      ' guide on that level, then slide a ⊕ onto each point. the ⊕s ride the line — pull one up or down' +
      ' and the line follows. this first one is scored gently.';
  }

  function syncLockButton() {
    /* Locking mid-trace scored a faded guess the player was not even
       looking at. The button comes back the moment the four strokes
       resolve (applyTrace flips the mode back to 'drag'). */
    if (phase !== 'guess') return;
    btnLock.disabled = (mode === 'trace' && strokes.length > 0);
    btnLock.textContent = btnLock.disabled ? 'finish the trace first' : 'lock it in';
  }

  function setTraceButton() {
    syncLockButton();
    if (mode !== 'trace') {
      btnTrace.textContent = 'trace edges ✎';
      btnTrace.setAttribute('aria-pressed', 'false');
    } else {
      btnTrace.textContent = strokes.length ? 'undo stroke ↺' : 'stop tracing ✕';
      btnTrace.setAttribute('aria-pressed', 'true');
    }
    btnTrace.disabled = (phase !== 'guess');
  }

  function startScene() {
    scene = makeScene(sceneIdx);
    guess = { y: 0.8, v1: 0.3, v2: 0.7 };
    drag = null;    /* a pointer held across scenes must not move the fresh guess */
    rawPts = null;
    strokes = [];
    traceVP = [];
    mode = 'drag';
    lastPair = null;
    lastParts = null;
    phase = 'guess';
    btnLock.textContent = 'lock it in';
    btnLock.disabled = false;
    setTraceButton();
    hint.textContent = guessHint();
    draw();
  }

  function newRound() {
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    lastFlip = 0;
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    startScene();
  }

  /* Abandoning a half-finished round throws away every scene locked so
     far (an unfinished round is never reported), so a stray tap on "new
     round" has to ask first. Once the third scene locks the round is
     already in the books — no question then, the button just deals
     another one. */
  var abandonArmed = false, abandonTimer = null;
  /* The question goes stale the moment the player does something else. It
     used to stay armed for its whole four seconds no matter what happened
     in between, so "new round" → change your mind → lock another scene →
     "new round" again binned a live round on a SINGLE press, with the
     confirmation silently spent on a question asked several seconds and one
     scene ago. Anything that moves the round on disarms it. */
  function disarmAbandon() {
    clearTimeout(abandonTimer);
    abandonTimer = null;
    abandonArmed = false;
  }
  function requestNewRound() {
    if (sceneScores.length && sceneScores.length < SCENES_PER_ROUND && !abandonArmed) {
      abandonArmed = true;
      showToast('press again to drop this round', false);
      clearTimeout(abandonTimer);
      abandonTimer = setTimeout(function () { abandonArmed = false; }, 4000);
      return;
    }
    disarmAbandon();
    newRound();
  }

  function lockScene() {
    disarmAbandon();   /* a scene just landed — any pending "sure?" is stale */
    var g1 = { x: guess.v1 * W, y: guess.y * H };
    var g2 = { x: guess.v2 * W, y: guess.y * H };
    var t1 = { x: scene.vpL.x * W, y: scene.vpL.y * H };
    var t2 = { x: scene.vpR.x * W, y: scene.vpR.y * H };
    var ease = bandEase(sceneIdx);
    var slop = ArtDaily.ease(1); /* pen 1.0, finger 1.5, mouse/trackpad 2.0 */
    var h = horizonScore(guess.y * H, scene.ty * H, H, ease, slop);
    var pair = vpPairing(g1, g2, t1, t2, W, ease, slop);
    var s = sceneScore(h, pair.scores[0], pair.scores[1]);
    sceneScores.push(s);
    lastPair = pair;
    lastParts = { total: s, h: h, v: pair.scores };
    mode = 'drag';
    rawPts = null;
    phase = 'reveal';
    /* the ⊕ each guess was actually read against — the pairing can swap */
    var tL = pair.swapped ? t2 : t1;
    var tR = pair.swapped ? t1 : t2;
    hint.textContent = 'scene ' + (sceneIdx + 1) + ' — ' + Math.round(s) + '/100. ' +
      coachLine(guess.y * H - scene.ty * H, g1.x - tL.x, g2.x - tR.x) +
      ' the coloured line and rings are the real answer' +
      (sceneIdx === 0 ? ' — both points always sit ON the eye level, which is why the ⊕s ride it.' : '.');
    hudScore.textContent = String(Math.round(roundScore(sceneScores)));
    var isLast = sceneIdx === SCENES_PER_ROUND - 1;
    btnLock.textContent = isLast ? 'finish round' : 'next scene →';
    setTraceButton();
    /* The round is complete the moment the third scene locks — report
       right here, exactly once, so pressing "new round" during the last
       reveal can never drop a finished round's score. */
    if (isLast) reportRound();
    else showToast('scene ' + (sceneIdx + 1) + ': ' + Math.round(s) + ' / 100', false);
    draw();
  }

  function reportRound() {
    var res = ArtDaily.report(roundScore(sceneScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  function advance() {
    sceneIdx += 1;
    if (sceneIdx < SCENES_PER_ROUND) { startScene(); return; }
    phase = 'done';
    btnLock.disabled = true;
    btnLock.textContent = 'locked';
    setTraceButton();
    hint.textContent = 'round done — press “new round” to hunt again.';
    draw();
  }

  /* ============ painting ============ */

  function px(p) { return { x: p.x * W, y: p.y * H }; }

  function poly(pts) {
    var p = px(pts[0]), i;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (i = 1; i < pts.length; i++) { p = px(pts[i]); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
  }

  function seg(a, b) {
    var p = px(a), q = px(b);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }

  /* face = card paper (opaque, so overlaps occlude) + graphite tint */
  function face(pts, c, tint) {
    poly(pts);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.card;
    ctx.fill();
    ctx.globalAlpha = tint;
    ctx.fillStyle = c.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* soft stepped washes; fixed fractions so they never betray the
     hidden horizon */
  function drawWashes(c) {
    var i;
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.03;
    for (i = 1; i <= 3; i++) ctx.fillRect(0, 0, W, H * 0.14 * i);
    ctx.fillStyle = c.ink;
    ctx.globalAlpha = 0.025;
    for (i = 1; i <= 3; i++) ctx.fillRect(0, H - H * 0.1 * i, W, H * 0.1 * i);
    ctx.globalAlpha = 1;
  }

  /* ---- THE CITY IS A STILL LIFE ----
     Nothing in the washes or the blocks moves while a ⊕ is under the
     finger: they are a function of the scene, the fitted sheet and the
     theme, and of nothing else. They were being painted again for every
     frame of every drag anyway — six full-width alpha fills (1.4 sheets of
     blending), sixty polygon fills, and a hundred-odd hairlines and edges,
     all pixel-identical to the frame before. The parts that actually MOVE
     are one dashed line and two 13px markers.
     So paint the still life once onto an offscreen sheet and blit it. The
     cache keys itself on the scene object, the fitted size, the dpr and the
     ink object — inks() hands back a NEW object the moment data-theme
     changes — so a new scene, a resize, a dpr change and a theme flip each
     invalidate it without being told, and onTheme still repaints in the new
     colours. If the offscreen sheet cannot be made at all, the old direct
     path is still right there. */
  var still = null, stillCtx = null;
  var stillScene = null, stillW = 0, stillH = 0, stillDpr = 0, stillInks = null;

  function stillFresh(c) {
    return !!still && stillScene === scene && stillW === W && stillH === H &&
      stillDpr === fitDpr && stillInks === c;
  }

  function drawStill(c) {
    if (!stillFresh(c)) {
      if (!still) {
        try {
          still = document.createElement('canvas');
          stillCtx = still.getContext('2d');
        } catch (e) { stillCtx = null; }
        if (!stillCtx) { still = null; }
      }
      var dpr = fitDpr || 1;
      var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
      /* a zero-sized offscreen sheet is not a drawable image — drawImage
         throws on one, and a throw inside draw() takes the drill with it */
      if (!still || !(pw > 0) || !(ph > 0)) { drawWashes(c); drawBoxes(c); return; }
      still.width = pw;                     /* also clears the backing store */
      still.height = ph;
      /* every painter below draws into `ctx` by name, so lend it to the
         offscreen sheet for the duration — synchronously, so nothing else
         can observe the swap. The `finally` is what makes the loan safe: a
         painter that threw with the loan outstanding would leave `ctx`
         pointing at the offscreen sheet for the rest of the session, and the
         drill would go on painting perfectly into a canvas nobody can see. */
      var sheet = ctx;
      try {
        ctx = stillCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawWashes(c);
        drawBoxes(c);
      } finally {
        ctx = sheet;
      }
      stillScene = scene; stillW = W; stillH = H; stillDpr = fitDpr; stillInks = c;
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(still, 0, 0, W, H);
  }

  function drawBoxes(c) {
    var i, j, b, aL, aR;
    for (i = 0; i < scene.boxes.length; i++) {
      b = scene.boxes[i];
      aL = scene.sunLeft ? 0.07 : 0.15;
      aR = scene.sunLeft ? 0.15 : 0.07;
      face([b.nT, b.lT, b.lB, b.nB], c, aL);
      face([b.nT, b.rT, b.rB, b.nB], c, aR);
      if (b.hasTop) face([b.nT, b.lT, b.back, b.rT], c, 0.04);

      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      for (j = 0; j < b.facade.length; j++) seg(b.facade[j].a, b.facade[j].b);
      ctx.globalAlpha = 1;

      ctx.lineWidth = scene.lw;
      seg(b.nT, b.nB);
      seg(b.lT, b.lB);
      seg(b.rT, b.rB);
      seg(b.nT, b.lT); seg(b.nB, b.lB);
      seg(b.nT, b.rT); seg(b.nB, b.rB);
      if (b.hasTop) { seg(b.lT, b.back); seg(b.rT, b.back); }
    }
  }

  function drawMarker(c, x, y, selected, faded) {
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    if (!faded) { ctx.fillStyle = c.card; ctx.fill(); }
    ctx.strokeStyle = faded ? readable(c) : c.ink;
    ctx.lineWidth = faded ? 1.5 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
    ctx.stroke();
    if (selected && !faded) {
      ctx.strokeStyle = readable(c);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, 19, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawGuess(c, faded) {
    var gy = guess.y * H;
    ctx.save();
    ctx.globalAlpha = faded ? 0.55 : 1;
    ctx.strokeStyle = readable(c);
    ctx.lineWidth = faded ? 1.5 : 2;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
    ctx.setLineDash([]);
    drawMarker(c, guess.v1 * W, gy, selMarker === 1 && mode === 'drag', faded);
    drawMarker(c, guess.v2 * W, gy, selMarker === 2 && mode === 'drag', faded);
    ctx.restore();
  }

  /* the player's own construction: the stroke as drawn, plus the line
     it implies, run right across the sheet — the whole point of the
     easel habit is seeing the edge extended */
  function drawStrokes(c) {
    var i, s, a, b, dx, dy, k;
    ctx.save();
    for (i = 0; i < strokes.length; i++) {
      s = strokes[i];
      a = px(s.a); b = px(s.b);
      dx = b.x - a.x; dy = b.y - a.y;
      k = 4000 / Math.max(1e-6, Math.hypot(dx, dy));
      ctx.strokeStyle = readable(c);
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x - dx * k, a.y - dy * k);
      ctx.lineTo(b.x + dx * k, b.y + dy * k);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = c.ink;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (rawPts && rawPts.length > 1) {
      /* extend the LIVE stroke too, not only the committed ones: a mouse
         user watching the ray sweep toward the vanishing point can
         correct mid-drag, which turns trace mode from a shot in the dark
         into something you can steer */
      var live = fitStrokeLine(rawPts, 0);
      if (live) {
        dx = live.b.x - live.a.x; dy = live.b.y - live.a.y;
        k = 4000 / Math.max(1e-6, Math.hypot(dx, dy));
        ctx.strokeStyle = readable(c);
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(live.a.x - dx * k, live.a.y - dy * k);
        ctx.lineTo(live.b.x + dx * k, live.b.y + dy * k);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = c.ink;
      ctx.beginPath();
      ctx.moveTo(rawPts[0].x, rawPts[0].y);
      for (i = 1; i < rawPts.length; i++) ctx.lineTo(rawPts[i].x, rawPts[i].y);
      ctx.stroke();
    }
    for (i = 0; i < traceVP.length; i++) {
      a = px(traceVP[i]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Accent on the bare card is 3.5:1 — fine — but the reveal's lines run
     right across the blocks' shaded faces, where the same accent drops
     near 2:1. Anything the reveal actually MEANS is therefore stroked
     twice: a fat card halo first, the accent on top, so the line reads
     against card wherever it lands, on paper and at night alike.
     Stroking leaves the path intact, so the two passes line up exactly —
     dashes and all. (The faint construction rays are decoration and keep
     their single hairline.) */
  function truthStroke(c, halo, w) {
    ctx.strokeStyle = c.card;
    ctx.lineWidth = halo;
    ctx.stroke();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  function drawReveal(c) {
    var i, b, vp, gy = guess.y * H, hy = scene.ty * H;
    ctx.save();
    /* construction edges extended to their VPs */
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    for (i = 0; i < scene.boxes.length; i++) {
      b = scene.boxes[i];
      seg(b.lT, scene.vpL); seg(b.lB, scene.vpL);
      seg(b.rT, scene.vpR); seg(b.rB, scene.vpR);
    }
    /* true horizon */
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(W, hy);
    truthStroke(c, 6, 2.5);
    /* which ⊕ was read against which VP — the pairing can swap */
    if (lastPair) {
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      for (i = 0; i < 2; i++) {
        vp = px(lastPair.swapped
          ? (i === 0 ? scene.vpR : scene.vpL)
          : (i === 0 ? scene.vpL : scene.vpR));
        ctx.moveTo((i === 0 ? guess.v1 : guess.v2) * W, gy);
        ctx.lineTo(vp.x, vp.y);
      }
      truthStroke(c, 4, 1.5);
      ctx.setLineDash([]);
    }
    /* true VPs */
    for (i = 0; i < 2; i++) {
      vp = px(i === 0 ? scene.vpL : scene.vpR);
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = c.card;
      ctx.fill();
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = c.accent;
      ctx.fill();
    }
    ctx.restore();
  }

  /* the score, on the sheet where the eyes already are */
  function drawStamp(c) {
    if (!lastParts) return;
    var l1 = Math.round(lastParts.total) + ' / 100';
    var l2 = 'horizon ' + Math.round(lastParts.h) + ' · vps ' +
      Math.round(lastParts.v[0]) + ', ' + Math.round(lastParts.v[1]);
    ctx.save();
    ctx.font = '700 15px Caveat, cursive';
    var w1 = ctx.measureText(l1).width;
    ctx.font = '600 11px "Cascadia Code", Menlo, Consolas, monospace';
    var w2 = ctx.measureText(l2).width;
    var w = Math.max(w1, w2) + 20, h = 44;
    var x = 10, y = H - h - 10;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
    ctx.fillStyle = c.card;
    ctx.fill();
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = c.ink;
    ctx.font = '700 15px Caveat, cursive';
    ctx.fillText(l1, x + 10, y + 4);
    ctx.fillStyle = readable(c);
    ctx.font = '600 11px "Cascadia Code", Menlo, Consolas, monospace';
    ctx.fillText(l2, x + 10, y + 25);
    ctx.restore();
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;
    drawStill(c);
    drawStrokes(c);
    if (phase === 'guess') {
      /* While tracing, the sheet belongs to the strokes — but the guide
         may not VANISH, because "lock it in" stays live the whole time
         and locking must never score something the player cannot see.
         So it steps back to the faded treatment instead, and returns to
         full weight the moment the four strokes resolve into two
         crossings (applyTrace flips mode back to 'drag'). */
      drawGuess(c, mode !== 'drag');
    } else {
      drawGuess(c, true);
      drawReveal(c);
      drawStamp(c);
    }
  }

  /* ============ input ============ */

  /* getBoundingClientRect() is a layout read, and this used to run once
     per pointer sample — the single most expensive thing in the move
     handler. The sheet cannot move under a gesture without a scroll or a
     resize, and the hint line above it can only re-wrap between gestures,
     so the rect is measured afresh at every pointerdown and whenever the
     page scrolls or resizes, and reused for the rest of the stroke. */
  var canvasRect = null;
  function dropRect() { canvasRect = null; }
  window.addEventListener('scroll', dropRect, true);

  function pointerPos(ev) {
    var r = canvasRect || (canvasRect = canvas.getBoundingClientRect());
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /* SAMPLING FIDELITY ON A FAST EDGE. One pointermove is one sample, but
     the digitizer under it reports at 120–240Hz and the browser hands
     over only what it could deliver in time — on a quick trace that is
     most of the stroke thrown away, and under twelve survivors trimHooks
     stops trimming, so the acceleration hooks it exists to remove are
     back in the fit. Ask for the merged samples.
     They are then thinned to a minimum spacing, because a
     total-least-squares fit weights every sample alike: without it the
     slow patch where the hand hesitated (fifty samples in ten pixels)
     outvotes the whole confident rest of the edge. Evenly spaced samples
     fit the line the hand drew, not the places it lingered. */
  /* Reports whether anything was actually kept, so a move whose samples all
     fell inside the 2px filter — a hand resting still, or creeping the last
     pixel onto an edge — does not schedule a repaint of a frame identical to
     the one already on the sheet. (perspective's twin already does this;
     during a trace the live fit below is the whole per-frame cost.) */
  var SAMPLE_MIN_PX = 2;
  function pushSamples(ev, arr) {
    var list = null, added = false;
    try { list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null; } catch (e) { list = null; }
    if (!list || !list.length) list = [ev];
    for (var i = 0; i < list.length; i++) {
      var p = pointerPos(list[i]);
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      var last = arr.length ? arr[arr.length - 1] : null;
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= SAMPLE_MIN_PX) {
        arr.push(p);
        added = true;
      }
    }
    return added;
  }

  /* hit areas: markers 26px radius (52px wide), line ±22px (44px) */
  var drag = null; /* { id, kind: 'line'|'v1'|'v2', off } */

  function finishStroke() {
    /* Short strokes are the dominant source of angular error: a 42px
       drag with 3px of wobble at its ends carries ~8° of tilt, which is
       ~42px of crossing error 300px out. Refusing them costs nothing —
       the refusal is free and friendly — so ask for a real one. */
    var fit = fitStrokeLine(rawPts, 0.12 * W);
    rawPts = null;
    if (!fit) {
      showToast('drag further along the edge', false);
      hint.textContent = 'that stroke was too short to read an angle from — run it most of the way along the edge. ' +
        TRACE_PROMPT[strokes.length];
      draw();
      return;
    }
    /* the second stroke of a pair must actually cross the first */
    if (strokes.length % 2 === 1) {
      var prev = strokes[strokes.length - 1];
      var cross = intersectFits(fitFromStored(prev), fit);
      if (!cross) {
        showToast('those two edges are too close in angle', false);
        hint.textContent = 'those two edges are too close in angle for the crossing to mean anything — ' +
          'a hair of wobble would move it right across the picture. pick edges further apart in height. ' +
          TRACE_PROMPT[strokes.length];
        draw();
        return;
      }
      traceVP.push({ x: cross.x / W, y: cross.y / H });
    }
    strokes.push({
      a: { x: fit.a.x / W, y: fit.a.y / H },
      b: { x: fit.b.x / W, y: fit.b.y / H },
    });
    if (strokes.length >= 4) applyTrace();
    else hint.textContent = TRACE_PROMPT[strokes.length];
    setTraceButton();
    draw();
  }

  /* a stored (normalized) stroke back to a px-space fit */
  function fitFromStored(s) {
    var a = px(s.a), b = px(s.b);
    var dx = b.x - a.x, dy = b.y - a.y, m = Math.hypot(dx, dy) || 1;
    return { x: a.x, y: a.y, ux: dx / m, uy: dy / m };
  }

  function applyTrace() {
    var L = px(traceVP[0]), R = px(traceVP[1]);
    if (L.x > R.x) { var t = L; L = R; R = t; }
    guess.v1 = clampRange(L.x / W, 0.02, 0.98);
    guess.v2 = clampRange(R.x / W, 0.02, 0.98);
    guess.y = clampRange((L.y + R.y) / 2 / H, 0.04, 0.96);
    mode = 'drag';
    hint.textContent = 'your strokes cross there — and the eye level is the flat line ' +
      'through both crossings. nudge the ⊕s if you like, then lock it in.';
  }

  function undoStroke() {
    if (!strokes.length) { setTraceMode(false); return; }
    strokes.pop();
    if (traceVP.length > Math.floor(strokes.length / 2)) traceVP.pop();
    hint.textContent = TRACE_PROMPT[strokes.length];
    setTraceButton();
    draw();
  }

  function setTraceMode(on) {
    if (phase !== 'guess') return;
    mode = on ? 'trace' : 'drag';
    rawPts = null;
    if (on) {
      strokes = [];
      traceVP = [];
      hint.textContent = TRACE_PROMPT[0];
    } else {
      hint.textContent = guessHint();
    }
    setTraceButton();
    draw();
  }

  /* One pointer at a time, in either mode: a second finger landing mid-
     drag used to steal the gesture and leave the first one's capture
     dangling. */
  var lastPenAt = 0;
  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'guess') return;
    /* palm rejection: a pen always beats a palm that landed first */
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    else if (ev.pointerType === 'touch' && Date.now() - lastPenAt < 500) return;
    if (drag) return;
    ev.preventDefault();
    canvas.focus({ preventScroll: true });
    dropRect();                 /* a fresh gesture re-measures the sheet */
    var p = pointerPos(ev);
    /* The press now WRITES to the guess (see the dead-press branch below),
       and clampRange is a pair of ternaries that NaN sails straight
       through — so one non-finite sample would put NaN in guess.y with no
       gesture that brings it back. Drop it, as pointermove already does. */
    if (!isFinite(p.x) || !isFinite(p.y)) return;

    if (mode === 'trace') {
      drag = { id: ev.pointerId, kind: 'stroke', off: 0 };
      rawPts = [p];
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      draw();
      return;
    }

    var gy = guess.y * H;
    var d1 = Math.hypot(p.x - guess.v1 * W, p.y - gy);
    var d2 = Math.hypot(p.x - guess.v2 * W, p.y - gy);
    var kind = null, off = 0;
    /* Away from the markers the guide wins, and a held ⊕ carries the
       whole line with it vertically — so a pull upward always raises the
       horizon instead of silently sliding a marker sideways, and the
       lesson (the ⊕s ride the line) is in the hand, not just the hint. */
    /* Grab zones scale with the hardware: a screenless tablet cannot see
       its own hand, so acquiring a small target is the hardest thing it
       does, and it needs the biggest zones despite being the most
       precise instrument. */
    var markR = ArtDaily.startRadius(26);
    var lineR = ArtDaily.startRadius(22);
    if (Math.abs(p.y - gy) <= lineR && Math.min(d1, d2) > markR) {
      kind = 'line';
      off = gy - p.y;
    } else if (d1 <= markR || d2 <= markR) {
      kind = (d1 <= d2) ? 'v1' : 'v2';
      selMarker = (kind === 'v1') ? 1 : 2;
      off = (kind === 'v1' ? guess.v1 : guess.v2) * W - p.x;
    } else {
      /* DEAD PRESS. The guide opens at 0.8 of the sheet and the true eye
         level is never lower than 0.58, so a beginner's very first move —
         press where the horizon looks like it is — landed on neither the
         guide nor a ⊕, and the drill did NOTHING: no ink, no toast, no
         sentence. That reads as a broken page rather than as a miss, on
         the one action the first screen asks for. A press with nothing
         under it now drops the guide there and keeps dragging, exactly as
         the sibling horizon drill has always done. It cannot steal a ⊕:
         both are further than markR away or the branch above would have
         taken it, and nothing is scored until "lock it in". */
      kind = 'line';
      guess.y = clampRange(p.y / H, 0.04, 0.96);
      gy = guess.y * H;
      off = gy - p.y;   /* 0 unless the press was outside the clamp band */
    }
    drag = { id: ev.pointerId, kind: kind, off: off, offY: gy - p.y };
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    /* phase guard: locking in mid-drag (Enter) must freeze the guess */
    if (!drag || ev.pointerId !== drag.id || phase !== 'guess') return;
    ev.preventDefault();
    if (drag.kind === 'stroke') {
      if (rawPts && pushSamples(ev, rawPts)) requestDraw();
      return;
    }
    var p = pointerPos(ev);
    /* clampRange is a pair of ternaries, and NaN fails both — a single
       non-finite sample would write NaN into the guess, the ⊕ would
       leave the sheet and there would be no gesture that brings it
       back. Drop the sample instead; the next one is 4ms away. */
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    if (drag.kind === 'line') {
      guess.y = clampRange((p.y + drag.off) / H, 0.04, 0.96);
    } else {
      if (drag.kind === 'v1') guess.v1 = clampRange((p.x + drag.off) / W, 0.02, 0.98);
      else guess.v2 = clampRange((p.x + drag.off) / W, 0.02, 0.98);
      guess.y = clampRange((p.y + drag.offY) / H, 0.04, 0.96);
    }
    requestDraw();
  });

  function endDrag(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var wasStroke = drag.kind === 'stroke';
    drag = null;
    if (wasStroke && phase === 'guess' && mode === 'trace') finishStroke();
    else { rawPts = null; draw(); }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* A release the canvas never sees — off-window, or iOS dropping the
     capture with lostpointercapture and no pointerup — used to leave
     `drag` set for the rest of the scene, and pointerdown returns early
     while one is in flight: the ⊕s and the guide froze and the scene
     was scored on an untouched guess. */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  /* keyboard: arrows nudge (shift = fine), space swaps the active ⊕,
     enter locks in / advances, escape leaves trace mode */
  canvas.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); lockOrNext(); return; }
    if (phase !== 'guess') return;
    if (ev.key === 'Escape' || ev.key === 'Backspace') {
      if (mode === 'trace') { ev.preventDefault(); undoStroke(); }
      return;
    }
    if (mode === 'trace') return;
    var step = ev.shiftKey ? 0.002 : 0.012;
    if (ev.key === 'ArrowUp') guess.y = clampRange(guess.y - step, 0.04, 0.96);
    else if (ev.key === 'ArrowDown') guess.y = clampRange(guess.y + step, 0.04, 0.96);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      var dx = (ev.key === 'ArrowLeft') ? -step : step;
      if (selMarker === 1) guess.v1 = clampRange(guess.v1 + dx, 0.02, 0.98);
      else guess.v2 = clampRange(guess.v2 + dx, 0.02, 0.98);
    } else if (ev.key === ' ') selMarker = (selMarker === 1) ? 2 : 1;
    else return;
    ev.preventDefault();
    /* a held arrow auto-repeats faster than the screen refreshes */
    requestDraw();
  });

  /* one debounced door between phases: on a phone "lock it in" and
     "next scene" share a spot, and a routine double-tap used to skip
     the reveal the drill exists to give */
  function lockOrNext() {
    var now = Date.now();
    if (now - lastFlip < LOCK_MS) return;
    if (phase === 'guess') { lastFlip = now; lockScene(); }
    else if (phase === 'reveal') { lastFlip = now; advance(); }
  }

  btnLock.addEventListener('click', lockOrNext);
  btnTrace.addEventListener('click', function () {
    if (phase !== 'guess') return;
    if (mode !== 'trace') setTraceMode(true);
    else undoStroke();
  });

  /* ============ chrome wiring ============ */

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  document.getElementById('btnRound').addEventListener('click', requestNewRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () {
    dropRect();
    /* A gesture in flight is held in px: a half-drawn stroke, or a grab
       offset measured against the old sheet. A sheet that really did
       change size would fit a line the player never drew, or snap a ⊕
       sideways, so that gesture is let go — nothing is scored until "lock
       it in", so nothing is lost.
       But `resize` also fires when a phone's address bar slides away
       during an ordinary scroll, and the sheet's width — which is all
       this drill's geometry depends on — has not moved a pixel. Dropping
       the stroke there is the drill flinching at nothing: the ⊕ under the
       finger goes dead mid-drag for no reason the player can see. So the
       gesture is only abandoned when fitCanvas says the sheet actually
       changed. */
    if (fitCanvas()) {
      drag = null;
      rawPts = null;
    }
    draw();
  });

  /* ============ boot ============ */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();

/* ============================================================
   game.js — Vanishing Point Hunt. Each round shows three
   procedurally built two-point-perspective city scenes. The
   scene is rendered from KNOWN geometry (hidden horizon + two
   on-canvas VPs), so scoring is exact: drag the dashed guide
   onto the horizon, slide a ⊕ marker onto each VP, lock it in.
   The reveal overlays the true horizon, both VPs and every
   construction edge extended to them, in the game accent.
   Scene geometry is stored in normalized 0–1 coords so resizes
   never change the puzzle. Scoring lives in pure functions at
   the top — inputs in, 0–100 out.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'vp-hunt';
  var SCENES_PER_ROUND = 3;

  /* ============ pure scoring (px in, 0–100 out) ============ */

  function clampRange(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return clampRange(v, 0, 1); }

  /* Full marks on the line, zero at 12% of canvas height away.
     Degenerate input (zero/NaN size or coords) scores 0, never NaN. */
  function horizonScore(guessY, trueY, H) {
    if (!isFinite(guessY) || !isFinite(trueY) || !(H > 0)) return 0;
    return 100 * clamp01(1 - Math.abs(guessY - trueY) / (0.12 * H));
  }

  /* Full marks on the point, zero at 15% of canvas width away.
     Degenerate input (zero/NaN size or coords) scores 0, never NaN. */
  function vpScore(gx, gy, tx, ty, W) {
    if (!isFinite(gx) || !isFinite(gy) || !isFinite(tx) || !isFinite(ty) || !(W > 0)) return 0;
    return 100 * clamp01(1 - Math.hypot(gx - tx, gy - ty) / (0.15 * W));
  }

  /* Match each guess to a distinct true VP — never both to the same
     one. Of the two possible pairings, the better-scoring one wins. */
  function vpPairScores(g1, g2, t1, t2, W) {
    var a = [vpScore(g1.x, g1.y, t1.x, t1.y, W), vpScore(g2.x, g2.y, t2.x, t2.y, W)];
    var b = [vpScore(g1.x, g1.y, t2.x, t2.y, W), vpScore(g2.x, g2.y, t1.x, t1.y, W)];
    return (a[0] + a[1] >= b[0] + b[1]) ? a : b;
  }

  function sceneScore(h, v1, v2) { return 0.4 * h + 0.3 * v1 + 0.3 * v2; }

  function roundScore(scores) {
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    return scores.length ? sum / scores.length : 0;
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

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sky').trim(),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ============ scene generation (normalized 0–1 coords) ============ */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpP(p, q, t) { return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) }; }

  /* Intersection of infinite lines p1→p2 and p3→p4 (null if parallel). */
  function lineIntersect(p1, p2, p3, p4) {
    var d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(d) < 1e-9) return null;
    var a = p1.x * p2.y - p1.y * p2.x;
    var b = p3.x * p4.y - p3.y * p4.x;
    return {
      x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
      y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
    };
  }

  /* Ramp within the round: scene 1 = few big boxes, long strong
     edges; scene 3 = many small boxes, short edges, one VP hugging
     the frame. base/hgt are offsets from the horizon, depth is the
     fraction of the way to a VP a face extends. */
  var DIFF = [
    { boxes: 3, vpL: [0.12, 0.28], vpR: [0.72, 0.88], base: [0.16, 0.32], hgt: [0.26, 0.52], depth: [0.30, 0.46], edge: false, lw: 2 },
    { boxes: 4, vpL: [0.07, 0.30], vpR: [0.70, 0.93], base: [0.10, 0.26], hgt: [0.15, 0.32], depth: [0.18, 0.32], edge: false, lw: 1.7 },
    { boxes: 5, vpL: [0.16, 0.42], vpR: [0.58, 0.86], base: [0.05, 0.16], hgt: [0.08, 0.18], depth: [0.09, 0.18], edge: true,  lw: 1.4 },
  ];

  function makeBox(d, vpL, vpR, slot) {
    var x0 = lerp(vpL.x, vpR.x, slot);
    var yB = Math.min(0.94, vpL.y + rand(d.base[0], d.base[1]));
    var yT = Math.max(0.05, yB - rand(d.hgt[0], d.hgt[1]));
    var nT = { x: x0, y: yT }, nB = { x: x0, y: yB };
    /* keep every face at least ~2.5% of the width wide so small
       scene-3 boxes never degenerate into slivers */
    var tL = rand(d.depth[0], d.depth[1]);
    var tR = rand(d.depth[0], d.depth[1]);
    tL = Math.max(tL, Math.min(0.4, 0.025 / Math.max(0.01, Math.abs(vpL.x - x0))));
    tR = Math.max(tR, Math.min(0.4, 0.025 / Math.max(0.01, Math.abs(vpR.x - x0))));
    var lT = lerpP(nT, vpL, tL), lB = lerpP(nB, vpL, tL);
    var rT = lerpP(nT, vpR, tR), rB = lerpP(nB, vpR, tR);
    var back = lineIntersect(lT, vpR, rT, vpL);

    /* facade lines: window rows converge to the VPs, mullions stay
       vertical — subtle extra clues */
    var facade = [], i, f, a;
    var nRows = 2 + Math.floor(rand(0, 3));
    for (i = 1; i <= nRows; i++) {
      a = { x: x0, y: lerp(yT, yB, i / (nRows + 1)) };
      facade.push({ a: a, b: lerpP(a, vpL, tL) });
      facade.push({ a: a, b: lerpP(a, vpR, tR) });
    }
    var nCols = 1 + Math.floor(rand(0, 2));
    for (i = 1; i <= nCols; i++) {
      f = tL * i / (nCols + 1);
      facade.push({ a: lerpP(nT, vpL, f), b: lerpP(nB, vpL, f) });
      f = tR * i / (nCols + 1);
      facade.push({ a: lerpP(nT, vpR, f), b: lerpP(nB, vpR, f) });
    }

    return {
      nT: nT, nB: nB, lT: lT, lB: lB, rT: rT, rB: rB, back: back,
      hasTop: yT > vpL.y, facade: facade,
    };
  }

  function makeScene(diffIdx) {
    var d = DIFF[diffIdx];
    var ty = rand(0.26, 0.58);
    var lx, rx;
    if (d.edge) {
      /* one VP near the frame edge (still on-canvas, middle 90%) */
      if (Math.random() < 0.5) { lx = rand(0.05, 0.09); rx = rand(0.55, 0.82); }
      else { rx = rand(0.91, 0.95); lx = rand(0.18, 0.45); }
    } else {
      lx = rand(d.vpL[0], d.vpL[1]);
      rx = rand(d.vpR[0], d.vpR[1]);
    }
    var L = { x: lx, y: ty }, R = { x: rx, y: ty };
    var boxes = [], i, s0, s1;
    for (i = 0; i < d.boxes; i++) {
      s0 = 0.26 + 0.48 * (i / d.boxes);
      s1 = 0.26 + 0.48 * ((i + 1) / d.boxes);
      boxes.push(makeBox(d, L, R, rand(s0 + 0.02, s1 - 0.02)));
    }
    /* far buildings (bases nearer the horizon) paint first */
    boxes.sort(function (a, b) { return a.nB.y - b.nB.y; });
    return { ty: ty, vpL: L, vpR: R, boxes: boxes, lw: d.lw, sunLeft: Math.random() < 0.5 };
  }

  /* ============ round state ============ */

  var round = 0, sceneIdx = 0, sceneScores = [], scene = null;
  var phase = 'idle'; /* 'guess' → 'reveal' (per scene) → 'done' */
  var guess = { y: 0.8, v1: 0.3, v2: 0.7 };
  var selMarker = 1; /* keyboard-selected ⊕ */

  function startScene() {
    scene = makeScene(sceneIdx);
    guess = { y: 0.8, v1: 0.3, v2: 0.7 };
    drag = null; /* a pointer held across scenes must not move the fresh guess */
    phase = 'guess';
    btnLock.textContent = 'lock it in';
    hint.textContent = 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
      ' — drag the dashed guide onto the horizon, a ⊕ onto each vanishing point.';
    draw();
  }

  function newRound() {
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    btnLock.disabled = false;
    startScene();
  }

  function lockScene() {
    var g1 = { x: guess.v1 * W, y: guess.y * H };
    var g2 = { x: guess.v2 * W, y: guess.y * H };
    var t1 = { x: scene.vpL.x * W, y: scene.vpL.y * H };
    var t2 = { x: scene.vpR.x * W, y: scene.vpR.y * H };
    var h = horizonScore(guess.y * H, scene.ty * H, H);
    var v = vpPairScores(g1, g2, t1, t2, W);
    var s = sceneScore(h, v[0], v[1]);
    sceneScores.push(s);
    phase = 'reveal';
    hint.textContent = 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — ' +
      Math.round(s) + '/100 (horizon ' + Math.round(h) +
      ' · vps ' + Math.round(v[0]) + ', ' + Math.round(v[1]) + ')';
    btnLock.textContent = (sceneIdx < SCENES_PER_ROUND - 1) ? 'next scene →' : 'finish round';
    draw();
  }

  function advance() {
    sceneIdx += 1;
    if (sceneIdx < SCENES_PER_ROUND) { startScene(); return; }
    finishRound();
  }

  function finishRound() {
    phase = 'done';
    btnLock.disabled = true;
    btnLock.textContent = 'locked';
    var res = ArtDaily.report(roundScore(sceneScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press “new round” to hunt again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
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

  function drawBoxes(c) {
    var i, j, b, aL, aR;
    for (i = 0; i < scene.boxes.length; i++) {
      b = scene.boxes[i];
      aL = scene.sunLeft ? 0.07 : 0.15;
      aR = scene.sunLeft ? 0.15 : 0.07;
      face([b.nT, b.lT, b.lB, b.nB], c, aL);
      face([b.nT, b.rT, b.rB, b.nB], c, aR);
      if (b.hasTop && b.back) face([b.nT, b.lT, b.back, b.rT], c, 0.04);

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
      if (b.hasTop && b.back) { seg(b.lT, b.back); seg(b.rT, b.back); }
    }
  }

  function drawMarker(c, x, y, selected, faded) {
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    if (!faded) { ctx.fillStyle = c.card; ctx.fill(); }
    ctx.strokeStyle = faded ? c.muted : c.ink;
    ctx.lineWidth = faded ? 1.5 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
    ctx.stroke();
    if (selected && !faded) {
      ctx.strokeStyle = c.muted;
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
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = faded ? 1.5 : 2;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
    ctx.setLineDash([]);
    drawMarker(c, guess.v1 * W, gy, selMarker === 1, faded);
    drawMarker(c, guess.v2 * W, gy, selMarker === 2, faded);
    ctx.restore();
  }

  function drawReveal(c) {
    var i, b, vp;
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
    ctx.lineWidth = 2.5;
    seg({ x: 0, y: scene.ty }, { x: 1, y: scene.ty });
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

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;
    drawWashes(c);
    drawBoxes(c);
    if (phase === 'guess') {
      drawGuess(c, false);
    } else if (phase === 'reveal' || phase === 'done') {
      drawGuess(c, true);
      drawReveal(c);
    }
  }

  /* ============ input ============ */

  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /* hit areas: markers 26px radius (52px wide), line ±22px (44px) */
  var drag = null; /* { id, kind: 'line'|'v1'|'v2', off } */

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'guess') return;
    ev.preventDefault();
    canvas.focus();
    var p = pointerPos(ev);
    var gy = guess.y * H;
    var d1 = Math.hypot(p.x - guess.v1 * W, p.y - gy);
    var d2 = Math.hypot(p.x - guess.v2 * W, p.y - gy);
    var kind = null, off = 0;
    if (d1 <= 26 || d2 <= 26) {
      kind = (d1 <= d2) ? 'v1' : 'v2';
      selMarker = (kind === 'v1') ? 1 : 2;
      off = (kind === 'v1' ? guess.v1 : guess.v2) * W - p.x;
    } else if (Math.abs(p.y - gy) <= 22) {
      kind = 'line';
      off = gy - p.y;
    }
    if (!kind) return;
    drag = { id: ev.pointerId, kind: kind, off: off };
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    /* phase guard: locking in mid-drag (Enter) must freeze the guess */
    if (!drag || ev.pointerId !== drag.id || phase !== 'guess') return;
    ev.preventDefault();
    var p = pointerPos(ev);
    if (drag.kind === 'line') guess.y = clampRange((p.y + drag.off) / H, 0.04, 0.96);
    else if (drag.kind === 'v1') guess.v1 = clampRange((p.x + drag.off) / W, 0.02, 0.98);
    else guess.v2 = clampRange((p.x + drag.off) / W, 0.02, 0.98);
    draw();
  });

  function endDrag(ev) {
    if (drag && ev.pointerId === drag.id) drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* keyboard: arrows nudge (shift = fine), space swaps the active ⊕,
     enter locks in / advances */
  canvas.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); btnLock.click(); return; }
    if (phase !== 'guess') return;
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
    draw();
  });

  btnLock.addEventListener('click', function () {
    if (phase === 'guess') lockScene();
    else if (phase === 'reveal') advance();
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

  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ============ boot ============ */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();

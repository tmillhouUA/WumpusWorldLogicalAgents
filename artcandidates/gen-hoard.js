/* gen-hoard.js — procedurally generates the golden-hoard SVG.

   A heaped pile of coins + gems (hoard-06 style) crowned with a radial corona
   of light rays. Run it to (re)write hoard-09-heaped-pile.svg next to this file:

       node artcandidates/gen-hoard.js          (from the project root)
       node gen-hoard.js                         (from inside artcandidates/)

   Everything is a knob — tweak the `rows` (mound shape), the gem spots/colors,
   or the ray corona constants below, then re-run. Uses Math.random, so each run
   reshuffles the scatter; run until you like the layout. Node only (no deps). */

const fs = require('fs');
const path = require('path');

function rnd(a, b) { return a + Math.random() * (b - a); }

// --- coin mound: rows from a wide base up to a narrow peak, back rows first ---
// y = baseline of the row, hw = half-width (spread), n = coins in the row.
const rows = [
  { y: 84,   hw: 33, n: 13 },
  { y: 79.5, hw: 29, n: 12 },
  { y: 75,   hw: 25, n: 11 },
  { y: 70,   hw: 21, n: 9  },
  { y: 65,   hw: 17, n: 7  },
  { y: 60,   hw: 13, n: 6  },
  { y: 55,   hw: 9,  n: 4  },
  { y: 50,   hw: 5,  n: 3  },
];

let coins = '', coinCount = 0;
const coinList = [];        // {x,y,rx,ry} — kept so rays can find where they exit the pile
const sparkles = [];
for (const row of rows) {
  for (let i = 0; i < row.n; i++) {
    const t = row.n === 1 ? 0.5 : i / (row.n - 1);
    const x = 50 + (t * 2 - 1) * row.hw + rnd(-2.5, 2.5);
    const y = row.y + rnd(-1.5, 1.5);
    const rx = rnd(5, 6.2);
    const ry = rx * rnd(0.45, 0.52);
    coins += `    <ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"/>\n`;
    coinList.push({ x, y, rx, ry });
    coinCount++;
    if (Math.random() < 0.12) sparkles.push([x + rnd(-2, 2), y - rnd(0.5, 1.5)]);
  }
}

// --- gems nestled up the mound (fill, stroke) at fixed spots ---
const gemColors = [
  ['#3a9ad0', '#2a6a9a'], ['#c0392b', '#8a2418'], ['#2a8a4a', '#1a5a30'],
  ['#3a9ad0', '#2a6a9a'], ['#c0392b', '#8a2418'], ['#8a4ac0', '#5a2a8a'], ['#2a8a4a', '#1a5a30'],
];
const gemSpots = [[34, 80], [66, 78], [44, 72], [58, 66], [40, 60], [60, 58], [50, 52]];
let gems = '';
gemSpots.forEach((p, i) => {
  const [gx, gy] = p; const [f, s] = gemColors[i]; const r = 3.4;
  const pts = [[gx, gy - r], [gx + r * 0.95, gy - r * 0.2], [gx + r * 0.6, gy + r * 0.8], [gx - r * 0.6, gy + r * 0.8], [gx - r * 0.95, gy - r * 0.2]]
    .map(q => q.map(v => v.toFixed(1)).join(',')).join(' ');
  gems += `  <polygon points="${pts}" fill="${f}" stroke="${s}" stroke-width="0.6"/>\n`;
  sparkles.push([gx - 1, gy - 1]);
});
const sparkleStr = sparkles.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rnd(0.7, 1.0).toFixed(1)}"/>`).join('');

// --- radial corona of rays ---
// All rays emanate from one hidden origin O (just above the base center),
// evenly spaced across the UPPER arc, and all share the SAME OUTER radius. But
// each ray's INNER start is computed PER RAY: march outward from O along the
// ray's direction and find the farthest point where it still passes through a
// coin (i.e. where it exits the pile), then begin the drawn ray a few px beyond
// that. So rays over the tall center start higher up and rays over the low
// edges start closer in — the corona hugs the pile's actual silhouette.
const O = [50, 80];            // hidden common origin (just above the base center)
const N = 13;                  // number of rays across the arc
const arc = 220 * Math.PI / 180; // total angular spread (upper corona)
const startA = -Math.PI / 2 - arc / 2; // centered on straight-up
const rOuter = 50;             // shared outer radius (all rays end here)
const gap = 4;                 // px past the pile before a ray begins
const stepPx = 0.5;            // marching resolution when finding the pile exit

// Does point (px,py) lie inside any coin (treated as its ellipse)?
function inPile(px, py) {
  for (const c of coinList) {
    const dx = (px - c.x) / (c.rx + 1);   // +1 slight inflation so edges count
    const dy = (py - c.y) / (c.ry + 1);
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

let rays = '';
for (let i = 0; i < N; i++) {
  const ang = startA + (i / (N - 1)) * arc;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  // March outward; record the farthest distance that still hits a coin.
  let exit = 0;
  for (let d = 0; d <= rOuter; d += stepPx) {
    if (inPile(O[0] + cos * d, O[1] + sin * d)) exit = d;
  }
  const r1 = exit + gap;                 // per-ray inner start, just past the pile
  if (r1 >= rOuter) continue;            // fully buried — skip (shouldn't happen)
  const x1 = (O[0] + cos * r1).toFixed(2);
  const y1 = (O[1] + sin * r1).toFixed(2);
  const x2 = (O[0] + cos * rOuter).toFixed(2);
  const y2 = (O[1] + sin * rOuter).toFixed(2);
  rays += `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>\n`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <!-- Generated by gen-hoard.js. A heaped pile of coins + gems (hoard-06 style)
       with a radial corona of light rays: even angular spacing + shared outer
       radius from one hidden origin above the base center; each ray's inner end
       is computed per-ray so it begins just beyond the pile it would cross. -->
  <title>Hoard — heaped pile with ray corona</title>

  <g stroke="#ffe9a0" stroke-linecap="round" stroke-width="1.6" opacity="0.5">
    <!-- the corona slowly pulses in opacity (~3s cycle) — a glinting shimmer.
         SMIL so it runs when the SVG is loaded as an <img>. -->
    <animate attributeName="opacity" dur="3s" repeatCount="indefinite"
      values="0.3;0.62;0.3" calcMode="spline" keyTimes="0;0.5;1"
      keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
${rays}  </g>

  <ellipse cx="50" cy="86" rx="42" ry="7" fill="#000" opacity="0.28"/>

  <g fill="#f0c040" stroke="#a8822e" stroke-width="0.7">
${coins}  </g>

${gems}
  <g fill="#fff6d8">${sparkleStr}</g>
</svg>
`;

const out = path.join(__dirname, 'hoard-09-heaped-pile.svg');
fs.writeFileSync(out, svg);
console.log(`wrote ${out}\n  coins: ${coinCount}  gems: ${gemSpots.length}  rays: ${N}`);

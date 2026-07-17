/* ui.js — everything that touches the DOM.

   Owns the Game (WW.Game) on the main thread and renders the four panels. The
   expensive agent (KB + resolution) lives in worker.js; this file talks to it
   by message. Each action runs game.act and re-renders immediately — the
   avatar moves at once — then posts the new percept to the worker, which
   replies with the inference map (the fog catches up a moment later). Requires
   serving over http (workers don't load from file://).

   The grid shows the TRUE world but dims (0.25 opacity) any attribute not yet
   observed or inferred; proven-absent hazards show a green "no …" label. The
   avatar's position comes from the game (user play); the agent's own
   self-localization is a later step. */

document.addEventListener('DOMContentLoaded', () => {
  const gamePanel = document.getElementById('game-panel');
  const controlPanel = document.getElementById('control-panel');
  const kbPanel = document.getElementById('kb-panel');
  const solverPanel = document.getElementById('solver-panel');
  const askPanel = document.getElementById('ask-panel');

  let game;                 // ground truth + mechanics (cheap, on main thread)
  let reveal = {};          // latest inference map from the worker
  let beliefs = {};         // agent's inferred fluents (arrow, wumpusAlive)
  let snapshots = {};       // agent's KB snapshots (label -> grouped sections)
  const kbLabel = 'current';// which snapshot the panel shows (selector is a later step)
  const kbOpen = new Set(); // which KB sections the user has expanded (default: none)
  let resolutions = [];     // every ask of the latest turn, each a stepped trace
  const visited = new Set();// cells the player has entered (mirrors the agent)
  // Facts the USER established by querying, kept as the map's durable record —
  // PERSISTS across turns (unlike `resolutions`, which clears each move). Keyed
  // "x,y" -> { pit?, wumpus?, breezy?, stenchy? } with 'YES'|'NO' values. The
  // eventual map overhaul will render these (known-true/false/unknown); for now
  // this is the plumbing that lets a user query change the map. Cleared per game.
  let askedFacts = {};
  let gen = 0;              // game generation, to ignore stale worker replies
  let inferring = false;    // a step is posted and we're awaiting the worker's reply
  let mode = 'manual';      // 'manual' (user drives) | 'automatic' (agent drives via policy)
  let running = false;      // automatic Run loop active (Run/Stop toggle)
  let stepping = false;     // a single Step is in flight (one-shot, not the loop)
  const AUTO_DELAY = 400;   // ms between automatic steps, so the run is watchable

  // The agent runs in a worker so a slow sweep can't freeze the UI.
  const worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    if (e.data.gen !== gen) return;     // reply from a previous game; ignore

    if (e.data.type === 'resolution') {
      // A single query's trace, streamed mid-turn — append and repaint the
      // solver so the log fills in live. The "resolving…" indicator (shown
      // while inferring) stays below the latest item until the turn ends.
      const view = e.data.view;
      resolutions.push(view);
      // A user query may carry a map fact it established; record it in the
      // durable store and repaint the grid so the map reflects the query.
      if (view.fact && view.fact.value) {
        recordAskedFact(view.fact);
        renderGrid();
      }
      renderSolver();
      return;
    }

    if (e.data.type === 'decision') {
      // The worker answered "what would the policy do?". Apply it (through the
      // normal action flow) if a run is active or a single Step is in flight.
      if (running || stepping) autoApply(e.data.action);
      return;
    }

    // type === 'done': the turn finished. reveal/beliefs/snapshots are valid
    // now; resolutions already hold the streamed views (use the authoritative
    // full list from the message in case any stream was dropped).
    reveal = e.data.reveal;
    beliefs = e.data.beliefs || {};
    snapshots = e.data.snapshots || {};
    resolutions = e.data.resolutions || resolutions;
    setBusy(false);                     // inference done; re-enable input + hide indicator
    renderGrid();
    renderKB();
    renderSolver();

    // A single Step just completed — clear the one-shot flag and refresh the
    // controls (its buttons may re-enable/disable now the action settled).
    if (stepping) { stepping = false; renderControls(); }

    // Automatic Run: this step's inference is settled — schedule the next after a
    // short, watchable delay, unless the game ended or the user hit Stop.
    if (running) {
      if (game.state.done) stopRun();
      else setTimeout(requestDecision, AUTO_DELAY);
    }
  };
  worker.onerror = (e) => console.error('worker error:', e.message, e);

  // Record a map fact the user established by querying (pred at (x,y) = value).
  // Merges into the per-cell entry so multiple queries about one cell accumulate.
  function recordAskedFact({ pred, x, y, value }) {
    const key = game.key(x, y);
    (askedFacts[key] || (askedFacts[key] = {}))[pred] = value;
  }

  // Build the plain percept object the agent ingests (it never sees the Game).
  function currentPercept() {
    const p = game.percepts();
    return { x: p.x, y: p.y, breezy: p.breezy, stenchy: p.stenchy, glitter: p.glitter, alive: game.state.alive };
  }

  function newGame() {
    game = new WW.Game({ size: 5 });
    gen++;
    reveal = {};
    snapshots = {};
    resolutions = [];
    askedFacts = {};
    running = false;                    // halt any active run; the button resets below
    stepping = false;                   // drop any in-flight single step
    visited.clear();
    visited.add(game.key(...game.state.location));
    renderGrid();                       // show the fresh map at once
    renderKB();
    renderSolver();
    renderControls();                   // reset Run/Stop label + button enabled states
    setBusy(true);                      // lock until the fresh agent's first sweep replies
    worker.postMessage({ type: 'new', gen, size: game.size, percept: currentPercept(), mode });
  }

  // Lock/unlock input while the worker is inferring. The avatar has already
  // moved (game.act + renderGrid run synchronously before the post); this only
  // prevents a SECOND action from racing ahead of the in-flight inference,
  // which would feed the agent a step before its prior step's facts are settled.
  function setBusy(on) {
    inferring = on;
    controlPanel.classList.toggle('busy', on);
  }

  function doAction(action) {
    if (game.state.done || inferring) return;  // ignore clicks until inference catches up
    const hadArrow = game.state.hasArrow;     // did this Shoot actually fire?
    const from = [...game.state.location];    // firing cell (Shoot doesn't move)
    const out = game.act(action);
    if (game.state.alive) visited.add(game.key(...game.state.location));

    // A fired arrow also yields a locational deduction (no-op shot does not).
    const shot = (action.startsWith('Shoot') && hadArrow)
      ? { x: from[0], y: from[1], dir: action.slice(5), scream: out.scream }
      : null;
    // Bump: a Move that didn't move = walked into a wall (locationless, timed).
    const bump = action.startsWith('Move') && !out.moved;
    const step = { action, percept: currentPercept(), scream: out.scream, shot, bump };

    resolutions = [];                   // fresh log; streamed views accumulate here
    setBusy(true);                      // lock input + arm the "resolving…" indicator
    renderGrid();                       // move the avatar immediately; fog follows
    renderSolver();                     // clear the panel + show the indicator at once
    worker.postMessage({ type: 'act', gen, step, mode });
  }

  // ---- grid (game panel) -------------------------------------------------

  function cellAttrs(x, y) {
    const key = game.key(x, y);
    const rev = reveal[key] || {};
    const asked = askedFacts[key] || {};      // facts the user PROVED by querying
    const isVisited = visited.has(key);
    const here = game.state.location[0] === x && game.state.location[1] === y;

    const attrs = [];
    // Objects — observed when the agent (or a user query) has INFERRED them present.
    if (game.pits.has(key)) attrs.push({ label: 'pit', observed: rev.pit === 'YES' || asked.pit === 'YES' });
    if (game.wumpus[0] === x && game.wumpus[1] === y) attrs.push({ label: 'wumpus', observed: rev.wumpus === 'YES' || asked.wumpus === 'YES' });
    if (game.gold[0] === x && game.gold[1] === y && !game.state.hasGold) attrs.push({ label: 'gold', observed: isVisited });
    // Percepts — observed once sensed (visited) OR proven by a user query.
    if (game.breezyAt(x, y))  attrs.push({ label: 'breeze',  observed: isVisited || asked.breezy === 'YES' });
    if (game.stenchyAt(x, y)) attrs.push({ label: 'stench',  observed: isVisited || asked.stenchy === 'YES' });
    if (game.glitterAt(x, y)) attrs.push({ label: 'glitter', observed: isVisited });
    // Negative inferences — proven absent, by the agent's sweep or a user query.
    if (rev.pit === 'NO'    || asked.pit === 'NO')    attrs.push({ label: 'no pit',    observed: true, neg: true });
    if (rev.wumpus === 'NO' || asked.wumpus === 'NO') attrs.push({ label: 'no wumpus', observed: true, neg: true });
    // Player — always full opacity.
    if (here) attrs.push({ label: 'player', observed: true, player: true });
    return attrs;
  }

  /* A wall torch for a room: a quarter-circle light glow radiating from the
     room's bottom-left, plus a bracket + flame mounted on the left wall, low.
     `lit` toggles the flame animation and the glow. Returns a fragment. */
  function makeTorch(lit) {
    const frag = document.createDocumentFragment();

    // Quarter-circle glow (only when lit) — sits under the token/text.
    if (lit) {
      const glow = document.createElement('div');
      glow.className = 'torch-glow';
      frag.appendChild(glow);
    }

    // Torch: bracket + (if lit) animated flame. Inline SVG so the flame can be
    // CSS-animated. Mounted low on the left wall of the room.
    const torch = document.createElement('div');
    torch.className = 'torch' + (lit ? ' lit' : '');
    torch.innerHTML =
      '<svg viewBox="0 0 20 34" xmlns="http://www.w3.org/2000/svg">' +
        // bracket arm + cup
        '<rect x="2" y="20" width="9" height="2.5" rx="1" fill="#3a2b18"/>' +
        '<path d="M8 18 L14 18 L13 24 L9 24 Z" fill="#5a3d1e"/>' +
        '<rect x="8.5" y="17" width="5" height="2" rx="1" fill="#3a2b18"/>' +
        // flame group (animated when .lit)
        '<g class="flame">' +
          '<path class="flame-outer" d="M11 17 Q6 10 11 2 Q16 10 11 17 Z" fill="#cc5500"/>' +
          '<path class="flame-mid"   d="M11 16 Q7.5 11 11 5 Q14.5 11 11 16 Z" fill="#ff8800"/>' +
          '<path class="flame-core"  d="M11 15 Q9 11.5 11 8 Q13 11.5 11 15 Z" fill="#ffcc55"/>' +
        '</g>' +
      '</svg>';
    frag.appendChild(torch);

    return frag;
  }

  /* A pit: a jagged hole centered in the room, about a doorway wide. Two jagged
     polygons give the hole visible edge THICKNESS — an outer ring in broken-
     flagstone tone (the cross-section of the shattered tile) around an inner
     hole filled with a soft, gradual dark-gray → black radial gradient. Inline
     SVG so rim + gradient are one shape. */
  function makePit() {
    const pit = document.createElement('div');
    pit.className = 'pit';

    // Swirling "wind" arcs around the rim: ~20 partial circles (~60 deg) at
    // radii near the pit's radius plus noise, scattered at random angles, in
    // low-opacity blue. Placed randomly (per pit) but computed once here.
    const cx = 50, cy = 50, baseR = 40;   // pit hole radius ~40
    let windArcs = '';
    for (let i = 0; i < 30; i++) {
      const r = baseR + (Math.random() * 15 - 2);            // pit radius + noise (~40–50)
      const start = Math.random() * Math.PI * 2;             // random start angle
      const sweep = (60 + Math.random() * 15) * Math.PI / 180; // ~55–70 deg arc
      const end = start + sweep;
      const x1 = (cx + r * Math.cos(start)).toFixed(2);
      const y1 = (cy + r * Math.sin(start)).toFixed(2);
      const x2 = (cx + r * Math.cos(end)).toFixed(2);
      const y2 = (cy + r * Math.sin(end)).toFixed(2);
      const rr = r.toFixed(2);
      const op = (0.25 + Math.random() * 0.30).toFixed(2);   // 0.25–0.55 opacity (matches the breeze glyph)
      const w = (1 + Math.random() * 0.9).toFixed(2);      // slight stroke variation
      // Each arc slowly rotates about the pit center at a slightly different
      // speed/direction (see .wind-arc + spin keyframes in CSS).
      const dur = (9 + Math.random() * 6).toFixed(1);        // 9–15s per turn
      const dir = Math.random() < 0.5 ? 'normal' : 'reverse';
      // large-arc-flag 0 (arc < 180), sweep-flag 1 (clockwise)
      windArcs +=
        `<path class="wind-arc" d="M${x1} ${y1} A ${rr} ${rr} 0 0 1 ${x2} ${y2}" ` +
        `fill="none" stroke="#6aa8e0" stroke-width="${w}" ` +
        `stroke-linecap="round" opacity="${op}" ` +
        `style="animation-duration:${dur}s;animation-direction:${dir}"/>`;
    }

    pit.innerHTML =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" overflow="visible">' +
        '<defs>' +
          // Smoother, more gradual fade: black holds only at the very center,
          // then eases up through mid-grays to the rim.
          '<radialGradient id="pitgrad" cx="50%" cy="50%" r="54%">' +
            '<stop offset="0%"   stop-color="#000000"/>' +
            '<stop offset="30%"  stop-color="#040404"/>' +
            '<stop offset="55%"  stop-color="#0d0d0d"/>' +
            '<stop offset="78%"  stop-color="#191919"/>' +
            '<stop offset="100%" stop-color="#242424"/>' +
          '</radialGradient>' +
          // Slight vertical shading on the tile-edge ring so it looks like a
          // real broken lip (lighter top, darker bottom).
          '<linearGradient id="pitrim" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%"   stop-color="#3a352b"/>' +
            '<stop offset="100%" stop-color="#211d16"/>' +
          '</linearGradient>' +
        '</defs>' +
        // OUTER: broken-tile edge (the rim we see looking into the hole). A
        // jagged polygon a bit larger than the hole.
        '<polygon points="50,3 62,11 73,8 76,21 88,25 82,38 93,48 81,58 88,71 ' +
          '73,72 68,86 55,79 49,94 39,81 26,86 24,71 10,66 19,53 6,44 20,36 ' +
          '14,23 29,24 33,10 45,15" fill="url(#pitrim)"/>' +
        // INNER: the hole itself, jagged but inset so a ragged band of the
        // outer rim shows all around (uneven thickness = natural broken edge).
        '<polygon points="50,10 59,17 69,15 70,26 80,30 76,40 84,49 75,56 80,67 ' +
          '69,68 65,79 55,74 49,85 41,75 31,79 30,67 19,62 26,52 16,45 27,39 ' +
          '22,28 33,29 37,18 46,21" fill="url(#pitgrad)"/>' +
        // swirling wind arcs around the rim (on top of the pit)
        windArcs +
      '</svg>';
    return pit;
  }

  /* The BREEZE percept glyph: a standalone swirl of the same blue wind arcs the
     pit uses, GENERATED on render so no two are alike (like the pit's wind).
     Partial ~60-deg circles at varied radii and random angles, low-opacity
     blue, clustered around the glyph center. */
  function makeBreeze() {
    const el = document.createElement('div');
    el.className = 'percept-glyph breeze-glyph';
    const cx = 50, cy = 50;
    let arcs = '';
    for (let i = 0; i < 22; i++) {
      const r = 19 + Math.random() * 12;                       // radius spread 12–36
      const start = Math.random() * Math.PI * 2;               // random start angle
      const sweep = (55 + Math.random() * 20) * Math.PI / 180; // ~55–75 deg arc
      const end = start + sweep;
      const x1 = (cx + r * Math.cos(start)).toFixed(2);
      const y1 = (cy + r * Math.sin(start)).toFixed(2);
      const x2 = (cx + r * Math.cos(end)).toFixed(2);
      const y2 = (cy + r * Math.sin(end)).toFixed(2);
      const rr = r.toFixed(2);
      const op = (0.25 + Math.random() * 0.30).toFixed(2);     // 0.25–0.55 opacity
      const w = (1.2 + Math.random() * 1.0).toFixed(2);        // stroke variation
      // Each arc slowly rotates about the glyph center at a slightly different
      // speed/direction, so the swirl drifts in and out of phase (see the
      // .wind-arc rule + spin keyframes in CSS).
      const dur = (9 + Math.random() * 6).toFixed(1);          // 9–15s per turn
      const dir = Math.random() < 0.5 ? 'normal' : 'reverse';
      arcs +=
        `<path class="wind-arc" d="M${x1} ${y1} A ${rr} ${rr} 0 0 1 ${x2} ${y2}" ` +
        `fill="none" stroke="#6aa8e0" stroke-width="${w}" ` +
        `stroke-linecap="round" opacity="${op}" ` +
        `style="animation-duration:${dur}s;animation-direction:${dir}"/>`;
    }
    el.innerHTML =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" overflow="visible">' +
        arcs +
      '</svg>';
    return el;
  }

  // Fog cloud for an UNKNOWN quadrant. Built fresh on every call — a scatter of
  // ~40 mostly-transparent gray blobs whose accumulated density reads as fog
  // with a ragged, organic edge (no straight sides). Rejection sampling spaces
  // the centers out so they don't clump. A PAD margin larger than the max blob
  // radius surrounds the scatter field, so no blob reaches the viewBox edge —
  // zero clipping. Because it's regenerated per placement (Math.random, no seed),
  // no two fog tiles are alike. The whole cloud gently rocks (CSS .fog-cloud).
  // (Mirrors the standalone artcandidates/gen-fog.js reference generator.)
  function makeFog() {
    const N = 200, R_MIN = 13, R_MAX = 20;
    const COLORS = ['#4a4d53', '#565a60', '#3f4247', '#616570'];
    const MIN_DIST = 5, MAX_TRIES = 60;
    // geometry (derived so nothing touches the viewBox edge). SPILL is large so
    // the fog reaches well into neighboring quadrants and the banks blend.
    const TILE = 50, SPILL = 90, PAD = R_MAX + 2;
    const FIELD = TILE + 2 * SPILL;
    const SPAN_MIN = PAD, SPAN_MAX = PAD + FIELD;
    const SIZE = FIELD + 2 * PAD, CENTER = SIZE / 2;
    const rangeR = (a, b) => a + (b - a) * Math.random();

    const blobs = [];
    for (let i = 0; i < N; i++) {
      let cx, cy;
      for (let t = 0; t < MAX_TRIES; t++) {
        cx = rangeR(SPAN_MIN, SPAN_MAX);
        cy = rangeR(SPAN_MIN, SPAN_MAX);
        if (!blobs.some(b => Math.hypot(cx - b.cx, cy - b.cy) < MIN_DIST)) break;
      }
      blobs.push({
        cx, cy,
        r: rangeR(R_MIN, R_MAX),
        op: rangeR(0.14, 0.30),
        fill: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
    const circles = blobs.map(b =>
      `<circle cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${b.r.toFixed(1)}" ` +
      `fill="${b.fill}" opacity="${b.op.toFixed(2)}"/>`).join('');

    const el = document.createElement('div');
    el.className = 'fog-cloud';
    el.innerHTML =
      `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" overflow="visible">` +
        `<g class="fog-rock" style="transform-origin:${CENTER}px ${CENTER}px">${circles}</g>` +
      '</svg>';
    return el;
  }

  // Fog over a whole cell: one fresh fog cloud per quadrant, CENTERED on the
  // quadrant center (25%/75%) — same as the confirmed-good contact-sheet
  // geometry — just bigger, so it reaches further both inward (quadrant
  // overlap) and outward (into the wall).
  function placeFog(cell) {
    for (const [qx, qy] of [[0,0],[1,0],[0,1],[1,1]]) {
      const fog = makeFog();
      fog.style.width = fog.style.height = '90%';
      fog.style.left = (qx ? 75 : 25) + '%';
      fog.style.top  = (qy ? 75 : 25) + '%';
      fog.style.transform = 'translate(-50%, -50%)';
      cell.appendChild(fog);
    }
  }

  function renderCell(x, y) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    // Any cell is a query target: clicking fills the ask builder's coordinate.
    cell.addEventListener('click', () => pickAskCell(x, y));

    // Wall torch, bottom-left of the room. Lit rooms glow; (1,1) is always
    // visited so it starts lit. (Later: light on visit.)
    const lit = (x === 1 && y === 1);
    cell.appendChild(makeTorch(lit));

    // Pit: reference placement in (2,2) for now.
    if (x === 2 && y === 2) cell.appendChild(makePit());

    // Wumpus: reference placement in (3,3) for now.
    if (x === 3 && y === 3) {
      const wump = document.createElement('img');
      wump.className = 'wumpus-token';
      wump.src = 'artcandidates/wumpus-02-menacing-brows.svg';
      wump.alt = 'wumpus';
      cell.appendChild(wump);
    }

    // Gold hoard: reference placement in (4,4) for now.
    if (x === 4 && y === 4) {
      const gold = document.createElement('img');
      gold.className = 'hoard-token';
      gold.src = 'artcandidates/hoard-09-heaped-pile.svg';
      gold.alt = 'gold';
      cell.appendChild(gold);
    }

    // Fog: reference placement — cover all four quadrants of (1,4) so we can
    // judge quadrant coverage, inter-quadrant overlap, and the per-tile variety.
    // Each fog covers one quadrant; sized OVER the quadrant and centered on it so
    // its core fills the quadrant while the spill overhangs into its neighbors.
    // (1,4) and (2,4) both fogged so we can confirm blending ACROSS the shared
    // vertical wall, not just within a room.
    if ((x === 1 && y === 4) || (x === 2 && y === 4)) placeFog(cell);

    // Percept glyphs: reference placements — breeze in (2,3), stench in (3,4).
    // Breeze is generated per render (no two alike, like the pit's wind).
    if (x === 2 && y === 3) cell.appendChild(makeBreeze());
    if (x === 3 && y === 4) {
      const st = document.createElement('img');
      st.className = 'percept-glyph';
      st.src = 'artcandidates/glyph-stench.svg';
      st.alt = 'stench';
      cell.appendChild(st);
    }

    const coord = document.createElement('div');
    coord.className = 'coord';
    coord.textContent = `(${x},${y})`;
    cell.appendChild(coord);

    for (const a of cellAttrs(x, y)) {
      // The player is drawn as the hero SVG token, not a text label.
      if (a.player) {
        const token = document.createElement('img');
        token.className = 'player-token';
        token.src = 'artcandidates/hero-10a3.svg';
        token.alt = 'player';
        cell.appendChild(token);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'attr' + (a.observed ? '' : ' dim') + (a.neg ? ' neg' : '');
      el.textContent = a.label;
      cell.appendChild(el);
    }
    return cell;
  }

  /* Build the board as an interleaved wall/cell grid.

     Tracks alternate post | cell | post | … | post — (2n+1) per axis. Post
     tracks are a fixed wall thickness (--wall-th); cell tracks are 1fr. In
     1-based CSS grid-line numbering, post lines fall on ODD track indices
     (1,3,5,…) and cells on EVEN track slots (2,4,…). We place:
       - a corner block at every post/post intersection,
       - a horizontal wall run on each post-row over a cell-column,
       - a vertical wall run on each post-col over a cell-row,
       - a floor cell in each cell/cell slot.
     A run on the outer boundary is SOLID (4 blocks); an interior run is a
     DOORWAY (middle 2 blocks dropped) — the fully-open grid means every
     interior edge is a passage. */
  function renderBoard() {
    const n = game.size;
    const tracks = ['var(--wall-th)'];
    for (let i = 0; i < n; i++) tracks.push('1fr', 'var(--wall-th)');
    const template = tracks.join(' ');

    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.style.gridTemplateColumns = template;
    grid.style.gridTemplateRows = template;

    // Track index -> CSS grid line (1-based). Post track i (0..n) is line 2i+1;
    // cell track j (1..n) is line 2j.
    const postLine = (i) => 2 * i + 1;
    const cellLine = (j) => 2 * j;

    // Grid rows run top-to-bottom, but the world's y increases upward, so cell
    // row j (from top) maps to world y = n+1-j. Post rows/cols don't need world
    // coords. We iterate top-to-bottom / left-to-right in grid space.

    // Room floors first (behind everything): one per cell slot, each grown half
    // a wall past its track so the flagstones reach wall-centers / bleed under
    // the walls and through doorways (see .room-floor).
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= n; j++) {
        const rf = document.createElement('div');
        rf.className = 'room-floor';
        rf.style.gridRow = cellLine(i);
        rf.style.gridColumn = cellLine(j);
        grid.appendChild(rf);
      }
    }

    // Corner posts: every (postRow i, postCol k), i,k in 0..n.
    for (let i = 0; i <= n; i++) {
      for (let k = 0; k <= n; k++) {
        const post = document.createElement('div');
        post.className = 'wall wall-post';
        post.style.gridRow = postLine(i);
        post.style.gridColumn = postLine(k);
        grid.appendChild(post);
      }
    }

    // Horizontal wall runs: on each post-row i (0..n), spanning each cell-col
    // j (1..n). Boundary if the post-row is the very top (i=0) or bottom (i=n).
    for (let i = 0; i <= n; i++) {
      const boundary = (i === 0 || i === n);
      for (let j = 1; j <= n; j++) {
        const run = document.createElement('div');
        run.className = 'wall wall-h' + (boundary ? '' : ' door');
        run.style.gridRow = postLine(i);
        run.style.gridColumn = cellLine(j);
        grid.appendChild(run);
      }
    }

    // Vertical wall runs: on each post-col k (0..n), spanning each cell-row
    // i (1..n). Boundary if the post-col is leftmost (k=0) or rightmost (k=n).
    for (let k = 0; k <= n; k++) {
      const boundary = (k === 0 || k === n);
      for (let i = 1; i <= n; i++) {
        const run = document.createElement('div');
        run.className = 'wall wall-v' + (boundary ? '' : ' door');
        run.style.gridRow = cellLine(i);
        run.style.gridColumn = postLine(k);
        grid.appendChild(run);
      }
    }

    // Floor cells: cell-row i (1..n from top) is world y = n+1-i; cell-col j is
    // world x = j.
    for (let i = 1; i <= n; i++) {
      const y = n + 1 - i;
      for (let j = 1; j <= n; j++) {
        const x = j;
        const cell = renderCell(x, y);
        cell.style.gridRow = cellLine(i);
        cell.style.gridColumn = cellLine(j);
        grid.appendChild(cell);
      }
    }

    return grid;
  }

  function renderGrid() {
    gamePanel.innerHTML = '<h2>Wumpus Dungeon</h2>';

    // Board first, then the toolbar (New map + status) beneath it.
    gamePanel.appendChild(renderBoard());

    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const newMap = document.createElement('button');
    newMap.className = 'new-map-btn';
    newMap.textContent = 'New Map';
    newMap.addEventListener('click', newGame);
    bar.appendChild(newMap);

    const status = document.createElement('span');
    status.className = 'status';
    const s = game.state;
    const ended = s.done ? `  —  ${s.outcome.toUpperCase()}` : '';
    // The agent's INFERRED belief about the Wumpus (not the game's truth).
    const wa = beliefs.wumpusAlive;
    const wumpus = wa === 'NO' ? 'dead' : wa === 'YES' ? 'alive' : '?';
    const gold = beliefs.hasGold === 'NO' ? 'no' : beliefs.hasGold === 'YES' ? 'yes' : '?';
    status.textContent =
      `Score ${s.points} | gold (agent): ${gold} | arrow: ${s.hasArrow ? 'yes' : 'no'} | ` +
      `wumpus (agent): ${wumpus} | at (agent): ${beliefs.location || '?'}${ended}`;
    bar.appendChild(status);
    gamePanel.appendChild(bar);
  }

  // ---- knowledge base (kb panel) ----------------------------------------

  /* Render the KB as a list of collapsible, topical sections (default
     collapsed). Each entry is a rendered logical formula. The user's expanded/
     collapsed choice per section is remembered in `kbOpen` across re-renders,
     so a move doesn't snap open sections shut. */
  function renderKB() {
    kbPanel.innerHTML = '<h2>Knowledge Base</h2>';

    const sections = snapshots[kbLabel] || [];
    for (const section of sections) {
      const details = document.createElement('details');
      details.className = 'kb-section';
      if (kbOpen.has(section.key)) details.open = true;
      details.addEventListener('toggle', () => {
        if (details.open) kbOpen.add(section.key);
        else kbOpen.delete(section.key);
      });

      const summary = document.createElement('summary');
      summary.innerHTML =
        `${section.title} <span class="kb-count">${section.formulas.length}</span>`;
      details.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'kb-list';
      if (section.formulas.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'kb-empty';
        empty.textContent = '(empty)';
        list.appendChild(empty);
      } else {
        for (const f of section.formulas) {
          const row = document.createElement('div');
          row.className = 'kb-formula';
          row.textContent = f;
          list.appendChild(row);
        }
      }
      details.appendChild(list);
      kbPanel.appendChild(details);
    }
  }

  // ---- resolution solver (solver panel) ---------------------------------

  /* A scrollable list of every ask the agent made this turn, two levels of
     collapsibility (all default-collapsed): click an ask to reveal its
     resolution steps; click a step to reveal that step's new resolvents. Both
     levels build their contents lazily on first open — a single ask can carry
     thousands of resolvents, so we don't put them in the DOM until asked. */
  function renderSolver() {
    solverPanel.innerHTML = '<h2>Resolution</h2>';
    const scroll = document.createElement('div');
    scroll.className = 'solver-scroll';

    if (resolutions.length === 0 && !inferring) {
      const empty = document.createElement('div');
      empty.className = 'solver-empty';
      empty.textContent = '(no asks this turn)';
      scroll.appendChild(empty);
    }

    for (const ask of resolutions) {
      const askEl = document.createElement('details');
      askEl.className = 'ask-entry' + (ask.userPosed ? ' user-posed' : '');

      const sum = document.createElement('summary');
      const q = document.createElement('span');
      q.className = 'ask-query';
      q.textContent = 'Ask ' + ask.query + '?';
      const res = document.createElement('span');
      res.className = 'ask-result' + (ask.result.startsWith('entailed') ? ' yes' : '');
      res.textContent = ask.result;
      sum.appendChild(q);
      sum.appendChild(res);
      askEl.appendChild(sum);

      let built = false;
      askEl.addEventListener('toggle', () => {
        if (askEl.open && !built) { built = true; buildSteps(askEl, ask); }
      });
      scroll.appendChild(askEl);
    }

    // While the worker is still resolving, a slowly pulsing "resolving…" line
    // sits below the latest streamed item; it vanishes when the turn completes
    // (setBusy(false) clears `inferring`, then renderSolver omits it).
    if (inferring) {
      const pulse = document.createElement('div');
      pulse.className = 'resolving';
      pulse.textContent = 'resolving…';
      scroll.appendChild(pulse);
    }

    solverPanel.appendChild(scroll);
  }

  /* The preprocessing pipeline: the clause set after each filter stage, shown
     above the resolution steps so a student can watch the input shrink before
     resolution proper begins. Each is a collapsible section listing its clauses,
     header showing the count — the shrinking counts make the filters' work plain.
     Built lazily (a section can hold the whole component). */
  function buildPreprocessing(askEl, ask) {
    const pp = ask.preprocessing;
    if (!pp) return;
    const stages = [
      { key: 'input',       title: 'Input',            note: 'filtered by anchor + component separation' },
      { key: 'pureSymbol',  title: 'Pure Symbol',      note: 'after pure-symbol elimination' },
      { key: 'subsumption', title: 'Unit Subsumption', note: 'after unit subsumption' },
    ];
    for (const s of stages) {
      const clauses = pp[s.key];
      if (!clauses) continue;                       // stage not captured (filter off / no trace)
      const secEl = document.createElement('details');
      secEl.className = 'res-step prep-step';

      const sum = document.createElement('summary');
      const left = document.createElement('span');
      left.textContent = s.title;
      left.title = s.note;                          // hover hint explaining the stage
      const right = document.createElement('span');
      right.className = 'step-count';
      right.textContent = 'Clauses: ' + clauses.length;
      sum.appendChild(left);
      sum.appendChild(right);
      secEl.appendChild(sum);

      let built = false;
      secEl.addEventListener('toggle', () => {
        if (secEl.open && !built) {
          built = true;
          const list = document.createElement('div');
          list.className = 'res-list';
          for (const c of clauses) {
            const row = document.createElement('div');
            row.className = 'res-line';
            row.textContent = c;
            list.appendChild(row);
          }
          secEl.appendChild(list);
        }
      });
      askEl.appendChild(secEl);
    }
  }

  function buildSteps(askEl, ask) {
    buildPreprocessing(askEl, ask);     // pipeline snapshots first, then the steps
    for (const st of ask.steps) {
      const stepEl = document.createElement('details');
      stepEl.className = 'res-step';

      const sum = document.createElement('summary');
      const left = document.createElement('span');
      left.textContent = (ask.unitOnly ? 'Unit Resolution Step: ' : 'Resolution Step: ') + st.step;
      const right = document.createElement('span');
      right.className = 'step-count';
      right.textContent = 'New Resolvents: ' + st.resolvents.length;
      sum.appendChild(left);
      sum.appendChild(right);
      stepEl.appendChild(sum);

      let built = false;
      stepEl.addEventListener('toggle', () => {
        if (stepEl.open && !built) { built = true; buildResolvents(stepEl, st); }
      });
      askEl.appendChild(stepEl);
    }
  }

  function buildResolvents(stepEl, st) {
    const list = document.createElement('div');
    list.className = 'res-list';
    for (const r of st.resolvents) list.appendChild(renderResLine(r));
    stepEl.appendChild(list);
  }

  /* One proof line. Normal resolvents show just the derived clause (the
     justification is dropped to keep the list readable). The empty clause (□)
     is the exception: a bare □ is meaningless, so it shows the two input clauses
     that contradicted, bold + red. */
  function renderResLine(r) {
    const line = document.createElement('div');
    line.className = 'res-line';

    if (!r.empty) {
      const cl = document.createElement('span');
      cl.className = 'res-clause';
      cl.textContent = r.resolvent;
      line.appendChild(cl);
      return line;
    }

    // Empty clause: "□ from <ci>, <cj>" with the two inputs flagged.
    const cl = document.createElement('span');
    cl.className = 'res-clause';
    cl.textContent = r.resolvent + ' from ';
    line.appendChild(cl);

    const ci = document.createElement('span');
    ci.className = 'res-input empty';
    ci.textContent = r.ci;
    line.appendChild(ci);
    line.appendChild(document.createTextNode(', '));

    const cj = document.createElement('span');
    cj.className = 'res-input empty';
    cj.textContent = r.cj;
    line.appendChild(cj);
    return line;
  }

  // ---- controls (control panel) -----------------------------------------

  /* A 3x3 compass of buttons for the given action prefix ('Move' or 'Shoot').
     N top-centre, W/E middle, S bottom-centre; the other cells are spacers.
     centerLabel, if given, fills the middle (index 4) spacer with a label so the
     pad names itself. */
  function compass(prefix, padClass, centerLabel) {
    const pad = document.createElement('div');
    pad.className = padClass;
    const layout = ['', 'N', '', 'W', '', 'E', '', 'S', ''];
    layout.forEach((dir, i) => {
      if (dir === '') {
        const spacer = document.createElement('div');
        if (i === 4 && centerLabel) {
          spacer.className = 'pad-label';
          spacer.textContent = centerLabel;
        }
        pad.appendChild(spacer);
        return;
      }
      const b = document.createElement('button');
      b.textContent = dir;
      b.addEventListener('click', () => doAction(prefix + dir));
      pad.appendChild(b);
    });
    return pad;
  }

  function renderControls() {
    controlPanel.innerHTML = '<h2>Controls</h2>';

    // The panel stacks the movement/action pads over a mode+run/step bar.
    const stack = document.createElement('div');
    stack.className = 'controls-stack';

    const controls = document.createElement('div');
    // In automatic mode the agent drives, so the manual pad is grayed + inert.
    controls.className = 'controls' + (mode === 'automatic' ? ' disabled' : '');

    // Left: large movement pad.
    const movePad = compass('Move', 'move-pad', 'Move');

    // Right column: small shooting pad on top, action buttons beneath.
    const right = document.createElement('div');
    right.className = 'right-col';
    right.appendChild(compass('Shoot', 'shoot-pad', 'Shoot'));

    const actions = document.createElement('div');
    actions.className = 'action-btns';
    for (const name of ['Grab', 'Climb']) {
      // Each button lives in an equal-width slot; the button fills 75% of it,
      // centered, so it reads narrower without shifting its center (see CSS).
      const slot = document.createElement('div');
      slot.className = 'action-slot';
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => doAction(name));
      slot.appendChild(b);
      actions.appendChild(slot);
    }
    right.appendChild(actions);

    controls.appendChild(movePad);
    controls.appendChild(right);

    // Mode + Run/Step bar. The mode toggle chooses who drives (user vs. agent);
    // the active button reflects the `mode` state. Run/Step are still unwired —
    // they drive the agent in automatic mode, handled in the next step.
    const modeBar = document.createElement('div');
    modeBar.className = 'mode-bar';

    const modeToggle = document.createElement('div');
    modeToggle.className = 'mode-toggle';
    for (const [name, value] of [['Manual', 'manual'], ['Automatic', 'automatic']]) {
      const b = document.createElement('button');
      b.className = 'mode-btn' + (mode === value ? ' active' : '');
      b.textContent = name;
      b.addEventListener('click', () => setMode(value));
      modeToggle.appendChild(b);
    }

    const runStep = document.createElement('div');
    runStep.className = 'run-step';

    // Run/Stop toggle: label + handler reflect whether a run is active. Enabled
    // only in automatic mode (and, for starting, when the game isn't over). A
    // single Step in flight also disables Run.
    const gameOver = game && game.state.done;
    const runBtn = document.createElement('button');
    runBtn.textContent = running ? 'Stop' : 'Run';
    runBtn.disabled = mode !== 'automatic' || stepping || (!running && gameOver);
    runBtn.addEventListener('click', toggleRun);
    runStep.appendChild(runBtn);

    // Step: one policy action. Enabled only in automatic mode, when no run/step is
    // in flight and the game isn't over.
    const stepBtn = document.createElement('button');
    stepBtn.textContent = 'Step';
    stepBtn.disabled = mode !== 'automatic' || running || stepping || gameOver;
    stepBtn.addEventListener('click', stepOnce);
    runStep.appendChild(stepBtn);

    modeBar.appendChild(modeToggle);
    modeBar.appendChild(runStep);

    stack.appendChild(controls);
    stack.appendChild(modeBar);
    controlPanel.appendChild(stack);
  }

  /* Switch drive mode. Grays the manual pad in automatic mode (see renderControls).
     Leaving automatic while a run is active stops it. (Withholding the automatic
     sweep in manual mode is a later step.) */
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    // Leaving automatic cancels any run AND any in-flight single step, so a
    // pending 'decision' reply can't apply a stray auto-action in manual mode.
    if (mode !== 'automatic') { if (running) stopRun(); stepping = false; }
    renderControls();
  }

  // ---- automatic Run loop ----------------------------------------------

  /* Run/Stop toggle. Run starts the automatic loop; Stop (or game end, or leaving
     automatic mode) halts it. Each cycle asks the worker for the policy's action,
     applies it, and — once the resulting inference settles — schedules the next
     (see the 'decision'/'done' handlers). */
  function toggleRun() {
    if (running) stopRun();
    else startRun();
  }

  function startRun() {
    if (running || mode !== 'automatic' || game.state.done || inferring) return;
    running = true;
    renderControls();          // flip the button to "Stop"
    requestDecision();
  }

  function stopRun() {
    running = false;
    renderControls();          // flip the button back to "Run"
  }

  // Ask the worker what the policy would do next (reply arrives as 'decision').
  function requestDecision() {
    if (!running) return;
    worker.postMessage({ type: 'decide', gen });
  }

  // Apply a policy-chosen action through the same flow a manual click uses.
  function autoApply(action) {
    doAction(action);
  }

  /* Single automatic Step: one policy action, no loop. Ignored while a run is
     active, a step is already in flight, inference is pending, the game is over,
     or we're not in automatic mode. The 'decision' reply applies it (stepping is
     set), and 'done' clears the flag. */
  function stepOnce() {
    if (running || stepping || inferring || mode !== 'automatic' || game.state.done) return;
    stepping = true;
    renderControls();                    // reflect the in-flight step (disable buttons)
    worker.postMessage({ type: 'decide', gen });
  }

  // ---- ask panel (manual query builder) --------------------------------

  /* The query under construction. Parts fill in independently as the user clicks:
       pred    — the atom, chosen from the four buttons (replaces on re-click);
       x, y    — the cell, filled by clicking a map square (replaces on re-click);
       negated — the ¬ toggle, allowed before anything else is chosen.
     A query is COMPLETE (submittable) only when pred and both coordinates are set.
     The four preds map to the agent's query predicate names. */
  const ATOMS = [
    { pred: 'breezy',  label: 'Breeze' },
    { pred: 'stenchy', label: 'Stench' },
    { pred: 'pit',     label: 'Pit'    },
    { pred: 'wumpus',  label: 'Wumpus' },
  ];
  const ATOM_NAME = { breezy: 'Breezy', stenchy: 'Stenchy', pit: 'Pit', wumpus: 'Wumpus' };
  let askQuery = { pred: null, x: null, y: null, negated: false };

  const askComplete = () => askQuery.pred !== null && askQuery.x !== null && askQuery.y !== null;

  /* The query as logical notation, with placeholders for the unfilled parts:
       ¬                 (negation toggled, nothing else yet)
       Pit(_,_)          (atom chosen, no cell yet)
       ¬Breezy(2,3)      (complete)
     Empty when nothing at all is set. */
  function askText() {
    const neg = askQuery.negated ? '¬' : '';
    if (!askQuery.pred) return neg;                       // just ¬ or nothing
    const x = askQuery.x === null ? '_' : askQuery.x;
    const y = askQuery.y === null ? '_' : askQuery.y;
    return `${neg}${ATOM_NAME[askQuery.pred]}(${x},${y})`;
  }

  /* The query display, the atom + ¬ buttons, and Clear/Submit. Read-only field
     (queries are built by clicking, not typed). Text is red until the query is
     complete; Submit is disabled (grayed) until then. */
  function renderAsk() {
    askPanel.innerHTML = '<h2>Ask</h2>';

    const header = document.createElement('div');
    header.className = 'ask-header';

    const field = document.createElement('div');
    field.className = 'ask-field' + (askComplete() ? '' : ' incomplete');
    field.textContent = askText();

    const btns = document.createElement('div');
    btns.className = 'ask-btns';

    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.addEventListener('click', clearAsk);

    const submit = document.createElement('button');
    submit.textContent = 'Submit';
    submit.disabled = !askComplete() || inferring;        // grayed until complete
    submit.addEventListener('click', submitAsk);

    btns.appendChild(clear);
    btns.appendChild(submit);
    header.appendChild(field);
    header.appendChild(btns);
    askPanel.appendChild(header);

    // Atom row: the four predicate buttons plus the ¬ toggle. Choosing an atom
    // replaces the current one; ¬ flips the sign (allowed with no atom yet).
    const atomRow = document.createElement('div');
    atomRow.className = 'ask-atoms';

    const neg = document.createElement('button');
    neg.className = 'ask-atom ask-neg' + (askQuery.negated ? ' active' : '');
    neg.textContent = '¬';
    neg.title = 'Toggle negation';
    neg.addEventListener('click', () => { askQuery.negated = !askQuery.negated; renderAsk(); });
    atomRow.appendChild(neg);

    for (const a of ATOMS) {
      const b = document.createElement('button');
      b.className = 'ask-atom' + (askQuery.pred === a.pred ? ' active' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => { askQuery.pred = a.pred; renderAsk(); });
      atomRow.appendChild(b);
    }
    askPanel.appendChild(atomRow);
  }

  // Fill the coordinate slot from a clicked map cell (replaces on re-click).
  function pickAskCell(x, y) {
    askQuery.x = x;
    askQuery.y = y;
    renderAsk();
  }

  // Reset the builder to empty.
  function clearAsk() {
    askQuery = { pred: null, x: null, y: null, negated: false };
    renderAsk();
  }

  /* Post the current query to the worker. The agent runs the same inference the
     agent's own asks use; its streamed view appends to the resolution log (at the
     bottom, since streamed views push in order) tagged userPosed so the panel
     tints it. Blocked while a turn's inference is in flight, to avoid interleaving
     a manual ask with the agent's step queries on the shared KB. */
  function submitAsk() {
    if (!askComplete() || inferring) return;
    worker.postMessage({ type: 'ask', gen, query: askQuery });
  }

  renderControls();
  renderAsk();
  newGame();
});

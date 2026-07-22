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
  let lastPolicyTrace = null; // rule-by-rule pass/fail list from the latest 'decision'
                               // reply (see logic.js policyAction), for the Decision
                               // Rules tab. null until the first automatic decision.
  const visited = new Set();// cells the player has entered (mirrors the agent)
  // Facts the USER established by querying, kept as the map's durable record —
  // PERSISTS across turns (unlike `resolutions`, which clears each move). Keyed
  // "x,y" -> { pit?, wumpus?, breezy?, stenchy? } with 'YES'|'NO' values. The
  // eventual map overhaul will render these (known-true/false/unknown); for now
  // this is the plumbing that lets a user query change the map. Cleared per game.
  let askedFacts = {};
  let gen = 0;              // game generation, to ignore stale worker replies
  let inferring = false;    // a step is posted and we're awaiting the worker's reply
  let mode = 'automatic';   // 'manual' (user drives) | 'automatic' (agent drives via policy)
  let running = false;      // automatic Run loop active (Run/Stop toggle)
  let stepping = false;     // a single Step is in flight (one-shot, not the loop)
  const AUTO_DELAY = 400;   // ms between automatic steps, so the run is watchable

  // Whether this game's agent has had its frontier-inference sweep run at
  // least once (autoInfer:true). A fresh game's initial 'new' sweep always
  // runs with autoInfer:false, regardless of the selected mode — Automatic
  // is the default mode, but the game should "do nothing and query nothing"
  // until Run/Step is actually pressed. The first Run/Step then triggers a
  // catch-up resync (see requestDecision/stepOnce) before asking for a
  // decision, so that first press infers exactly what a normal move into
  // (1,1) would have — not what an eagerly pre-swept agent already knew for
  // free. pendingAutoDecision marks that catch-up's 'done' reply as the
  // trigger for the REAL decide request, rather than a normal turn-end.
  let agentSwept = false;
  let pendingAutoDecision = false;

  // Which tab each tabbed panel currently shows. Module-level (not local to the
  // render function) because renderGrid/renderSolver rebuild their panel's whole
  // innerHTML on every call (every action) — the active tab must survive that.
  let gameTab = 'dungeon';      // 'dungeon' | 'about' | 'howto'
  let resolverTab = 'resolution'; // 'resolution' | 'decisionRules'

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
      // A user-posed Ask is exactly one _ask call with no follow-up 'done'
      // (unlike the agent's own sweep queries, which are steps within a
      // larger turn) — so this IS the ask completing; release the busy lock
      // submitAsk set, so input isn't left stuck disabled.
      if (view.userPosed) { setBusy(false); renderAsk(); }
      renderSolver();
      return;
    }

    if (e.data.type === 'decision') {
      // The worker answered "what would the policy do?". Stash the trace for
      // the Decision Rules tab (repaint if it's the one currently showing),
      // then apply the action (through the normal action flow) if a run is
      // active or a single Step is in flight.
      lastPolicyTrace = e.data.trace;
      if (resolverTab === 'decisionRules') renderSolver();
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

    // This 'done' was the one-time catch-up resync (see requestDecision/
    // stepOnce): the FIRST Run/Step press only catches the agent up to what
    // it would already know had it just moved into (1,1) — it does not also
    // take a real action. That's a turn in its own right (mirrors arriving
    // at the entrance), so it stops here; the NEXT press is what requests
    // and applies the first real decision.
    if (pendingAutoDecision) {
      pendingAutoDecision = false;
      agentSwept = true;
      stepping = false;
      renderControls();
      if (running) {
        if (game.state.done) stopRun();
        else setTimeout(requestDecision, AUTO_DELAY);
      }
      return;
    }

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

  let lastSeed = null;      // the seed behind the current map, so Reset can replay it

  // Build a fresh game world from `seed` (deterministic — same seed, same
  // pits/wumpus/gold layout every time) and reset all per-game UI state.
  // Shared by New Map (picks a fresh seed) and Reset (reuses lastSeed), so a
  // problem map can be replayed exactly to watch when/why a policy decision
  // (e.g. firing the arrow) happens.
  function startGame(seed) {
    lastSeed = seed;
    game = new WW.Game({ size: 5, seed });
    gen++;
    reveal = {};
    snapshots = {};
    resolutions = [];
    lastPolicyTrace = null;             // stale trace from the previous map shouldn't linger
    askedFacts = {};
    fogCache = {};                       // fresh map -> stale cached fog layouts don't apply
    running = false;                    // halt any active run; the button resets below
    stepping = false;                   // drop any in-flight single step
    agentSwept = false;                 // fresh agent needs its first Run/Step to catch it up
    visited.clear();
    visited.add(game.key(...game.state.location));
    renderGrid();                       // show the fresh map at once
    renderKB();
    renderSolver();
    renderControls();                   // reset Run/Stop label + button enabled states
    setBusy(true);                      // lock until the fresh agent's first sweep replies
    // Force the initial sweep to withhold frontier inference regardless of
    // the SELECTED mode (Automatic is the default, but the game should do
    // nothing until Run/Step is actually pressed — see agentSwept above).
    worker.postMessage({ type: 'new', gen, size: game.size, percept: currentPercept(), mode: 'manual' });
  }

  function newGame() {
    // Date.now() ^ a random component: distinct across rapid clicks, and
    // always defined so every map is replayable via Reset.
    startGame((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
  }

  // Called once at load: always a fresh random map. A specific map (e.g. one
  // being replayed after a page reload to pick up a code change) is instead
  // recovered via Load Map + its Level number, not the URL.
  function startInitialGame() {
    newGame();
  }

  // Replay the CURRENT map from scratch (same seed -> identical pits/wumpus/
  // gold layout), so a run that exposed a bug can be re-driven step by step.
  function resetGame() {
    if (lastSeed === null) return;
    startGame(lastSeed);
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
    // Reveal the fatal room even on death, so the player can see what killed
    // them (pit or Wumpus) instead of staring at fog. This is purely the UI's
    // OWN visited set (drives fog display only) — the agent's KB is separate
    // and already refuses to learn from a percept where alive is false (see
    // Agent.observe), so marking this room visited here can't leak anything
    // into the agent's own knowledge.
    visited.add(game.key(...game.state.location));

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

  // Keyboard shortcuts for the manual pads (arrows -> Move, WASD -> Shoot, G ->
  // Grab, C -> Climb) — an alternative to clicking, dispatching through the
  // exact same doAction path as a click. Only live in Manual mode: in
  // Automatic the pads are grayed out and inert (see .controls.disabled),
  // and doAction itself has no mode check of its own (clicks are blocked by
  // CSS pointer-events, not JS), so this listener enforces that same rule
  // itself rather than bypassing it. Ignored while typing in a form control,
  // so it can't hijack keys meant for some future text input.
  const MOVE_KEYS = { ArrowUp: 'MoveN', ArrowRight: 'MoveE', ArrowDown: 'MoveS', ArrowLeft: 'MoveW' };
  const SHOOT_KEYS = { w: 'ShootN', d: 'ShootE', s: 'ShootS', a: 'ShootW' };
  document.addEventListener('keydown', (e) => {
    if (mode !== 'manual') return;
    if (e.target.matches('input, textarea, select, button')) return;
    const key = e.key;
    let action = MOVE_KEYS[key] || SHOOT_KEYS[key.toLowerCase()] ||
      (key.toLowerCase() === 'g' ? 'Grab' : key.toLowerCase() === 'c' ? 'Climb' : null);
    if (!action) return;
    e.preventDefault();   // arrow keys would otherwise scroll the page
    doAction(action);
  });

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

  /* The entrance ladder: fixed at (1,1) only, resting against the south wall
     (world y increases upward — see renderGrid's row->y mapping — so the
     bottom edge of the grid is south), centered horizontally. Inline SVG,
     two rails + rungs, angled slightly as if leaned against the wall. */
  function makeLadder() {
    const el = document.createElement('div');
    el.className = 'ladder';
    el.innerHTML =
      '<svg viewBox="0 0 40 34" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        // rails
        '<path d="M8 34 L13 2" stroke="#5a3d1e" stroke-width="3" stroke-linecap="round" fill="none"/>' +
        '<path d="M32 34 L27 2" stroke="#5a3d1e" stroke-width="3" stroke-linecap="round" fill="none"/>' +
        // rungs
        '<path d="M9.4 28 L30.6 28" stroke="#4a3016" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M10.2 21 L29.8 21" stroke="#4a3016" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M11 14 L29 14" stroke="#4a3016" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M11.8 7 L28.2 7" stroke="#4a3016" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>';
    return el;
  }

  /* A pit: a jagged hole centered in the room, about a doorway wide. Two jagged
     polygons give the hole visible edge THICKNESS — an outer ring in broken-
     flagstone tone (the cross-section of the shattered tile) around an inner
     hole filled with a soft, gradual dark-gray → black radial gradient. Inline
     SVG so rim + gradient are one shape. */
  // Shared "swirling wind" arc generator used by both the pit rim and the
  // breeze glyph: a ring of partial circles (~55-75 deg each) at randomized
  // radii/angles/opacity/stroke-width, each with its own slow rotation (see
  // .wind-arc + spin keyframes in CSS) so the ring drifts rather than sitting
  // static. Returns the joined SVG <path> markup string.
  //   count            — how many arcs
  //   cx, cy           — ring center, in the caller's local coordinate space
  //   rMin, rMax       — arc radius range (radius = rMin + noise up to rMax-rMin)
  //   sweepMinDeg, sweepRangeDeg — arc sweep angle range, degrees
  //   wMin, wRange     — stroke-width range
  function makeWindArcs({ count, cx, cy, rMin, rMax, sweepMinDeg, sweepRangeDeg, wMin, wRange }) {
    let arcs = '';
    for (let i = 0; i < count; i++) {
      const r = rMin + Math.random() * (rMax - rMin);           // radius, randomized within range
      const start = Math.random() * Math.PI * 2;                // random start angle
      const sweep = (sweepMinDeg + Math.random() * sweepRangeDeg) * Math.PI / 180;
      const end = start + sweep;
      const x1 = (cx + r * Math.cos(start)).toFixed(2);
      const y1 = (cy + r * Math.sin(start)).toFixed(2);
      const x2 = (cx + r * Math.cos(end)).toFixed(2);
      const y2 = (cy + r * Math.sin(end)).toFixed(2);
      const rr = r.toFixed(2);
      const op = (0.25 + Math.random() * 0.30).toFixed(2);      // 0.25–0.55 opacity
      const w = (wMin + Math.random() * wRange).toFixed(2);     // stroke variation
      const dur = (9 + Math.random() * 6).toFixed(1);           // 9–15s per turn
      const dir = Math.random() < 0.5 ? 'normal' : 'reverse';
      // large-arc-flag 0 (arc < 180), sweep-flag 1 (clockwise)
      arcs +=
        `<path class="wind-arc" d="M${x1} ${y1} A ${rr} ${rr} 0 0 1 ${x2} ${y2}" ` +
        `fill="none" stroke="#6aa8e0" stroke-width="${w}" ` +
        `stroke-linecap="round" opacity="${op}" ` +
        `style="animation-duration:${dur}s;animation-direction:${dir}"/>`;
    }
    return arcs;
  }

  function makePit() {
    const pit = document.createElement('div');
    pit.className = 'pit';

    // Swirling wind arcs around the rim, at radii near the pit's radius
    // (~40) plus noise. Placed randomly (per pit) but computed once here.
    const windArcs = makeWindArcs({
      count: 30, cx: 50, cy: 50,
      rMin: 38, rMax: 53, sweepMinDeg: 60, sweepRangeDeg: 15,
      wMin: 1, wRange: 0.9,
    });

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
     pit uses, GENERATED on render so no two are alike (like the pit's wind),
     clustered around the glyph center. */
  function makeBreeze() {
    const el = document.createElement('div');
    el.className = 'percept-glyph breeze-glyph';
    const arcs = makeWindArcs({
      count: 22, cx: 50, cy: 50,
      rMin: 19, rMax: 31, sweepMinDeg: 55, sweepRangeDeg: 20,
      wMin: 1.2, wRange: 1.0,
    });
    el.innerHTML =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" overflow="visible">' +
        arcs +
      '</svg>';
    return el;
  }

  // Point-in-polygon test (even-odd ray casting). points: [{x,y}, ...].
  // Standard: cast a ray in +x from (px,py), count polygon-edge crossings;
  // odd = inside. Used only to constrain blob CENTERS (see makeFogPoly) —
  // never to clip a rendered shape.
  function pointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y;
      const xj = points[j].x, yj = points[j].y;
      const crosses = (yi > py) !== (yj > py);
      if (crosses) {
        const xCross = xi + (py - yi) * (xj - xi) / (yj - yi);
        if (px < xCross) inside = !inside;
      }
    }
    return inside;
  }

  // Cache of generated fog blob layouts, keyed by a caller-supplied string
  // (typically "x,y,regionKey"). renderGrid() rebuilds the WHOLE board (and
  // so calls makeFogPoly again) on every action, even for cells nothing
  // happened in; without this cache each still-fogged region would get a
  // brand-new random scatter every step, flickering visibly. A region's fog
  // is only ever generated once and reused until it's actually revealed (at
  // which point renderCell stops calling makeFogPoly for it, and the cache
  // entry simply goes unused — no explicit eviction needed since a fresh
  // New Map/Reset replaces the whole cache below).
  let fogCache = {};

  // Fog cloud filling an ARBITRARY polygon (e.g. a pentagon or the diamond
  // from the 5-region tile layout). points: a flat array of {x,y} pairs in
  // 0-100 local space (the same convention makePit()'s rim polygons use).
  //
  // "Balloons tied to points in a polygon" mechanic: blob CENTERS are
  // rejection-sampled to fall within (up to the edge of) the given polygon,
  // but each blob is drawn as a full, uncropped circle — never clipped to
  // the polygon boundary. That's what lets a blob near the edge spill its
  // round rim into a neighboring region instead of stopping at a hard seam.
  // Spacing (MIN_DIST) is scoped to THIS call's own blobs only — regions are
  // generated independently and never spaced against each other.
  //
  // cacheKey (optional): if given, the blob layout is generated once and
  // reused on subsequent calls with the same key (see fogCache above), so a
  // fogged region's cloud stays visually stable across re-renders instead of
  // resampling every step. Omit for one-off/reference uses (e.g. contact
  // sheets, where a fresh scatter each call is the point).
  function makeFogPoly(points, cacheKey) {
    // Blob size/spacing/spill are tuned relative to the LOCAL coordinate space
    // (0-100 = wall-center to wall-center), which renders at ~1 local unit per
    // room-percent.
    const N = 200, R_MIN = 4, R_MAX = 6;
    const COLORS = ['#4a4d53', '#565a60', '#3f4247', '#616570'];
    const MIN_DIST = 1.5, MAX_TRIES = 60;

    // Bounding box of the polygon, expanded by SPILL (candidate-sampling
    // field) and then by PAD (transparent viewBox margin so no blob's rim can
    // ever reach the SVG viewport edge — zero-clipping guarantee).
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const SPILL = 26, PAD = R_MAX + 2;
    const spanMinX = minX - SPILL, spanMaxX = maxX + SPILL;
    const spanMinY = minY - SPILL, spanMaxY = maxY + SPILL;
    // Shift so the sampling field's own top-left lands at (PAD, PAD) in the
    // SVG's local coordinate space.
    const offX = PAD - spanMinX, offY = PAD - spanMinY;
    const sizeX = (spanMaxX - spanMinX) + 2 * PAD;
    const sizeY = (spanMaxY - spanMinY) + 2 * PAD;
    const rangeR = (a, b) => a + (b - a) * Math.random();

    // On a cache hit, skip generation entirely and reuse the stored markup —
    // this is what keeps a still-fogged region's blob layout (and its rock
    // animation timing) stable across re-renders instead of resampling and
    // re-rolling every step (see fogCache above).
    const cached = cacheKey !== undefined ? fogCache[cacheKey] : undefined;
    let circles = cached && cached.circles;
    if (circles === undefined) {
      // Sample a point uniformly inside the polygon via rejection against its
      // bounding box (retry until a candidate lands inside — cheap for the
      // convex/near-convex shapes used here; MAX_TRIES bounds the worst case).
      const samplePointInPolygon = () => {
        for (let t = 0; t < MAX_TRIES; t++) {
          const px = rangeR(minX, maxX), py = rangeR(minY, maxY);
          if (pointInPolygon(px, py, points)) return { x: px, y: py };
        }
        // Fallback: bounding-box center is inside any of this project's shapes
        // (pentagons, diamond, square) even if random sampling kept missing.
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      };

      const blobs = [];
      for (let i = 0; i < N; i++) {
        let cx, cy;
        for (let t = 0; t < MAX_TRIES; t++) {
          const p = samplePointInPolygon();
          cx = p.x + offX; cy = p.y + offY;
          if (!blobs.some(b => Math.hypot(cx - b.cx, cy - b.cy) < MIN_DIST)) break;
        }
        blobs.push({
          cx, cy,
          r: rangeR(R_MIN, R_MAX),
          op: rangeR(0.14, 0.30),
          fill: COLORS[Math.floor(Math.random() * COLORS.length)],
        });
      }
      circles = blobs.map(b =>
        `<circle cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${b.r.toFixed(1)}" ` +
        `fill="${b.fill}" opacity="${b.op.toFixed(2)}"/>`).join('');
    }

    // Desync + accentuate the rock so neighboring regions/rooms don't move in
    // lockstep: randomize duration/delay/direction and nudge the amplitude
    // per-instance (see .fog-rock's --fog-rock-amp custom property). Cached
    // alongside the blob layout so a still-fogged region's rock doesn't
    // restart/re-roll its phase on every re-render (every game action).
    let rock = cached && cached.rock;
    if (rock === undefined) {
      rock = {
        dur: (6 + Math.random() * 4).toFixed(1),    // 6-10s per cycle
        delay: (-Math.random() * 10).toFixed(1),    // negative = starts mid-cycle
        dir: Math.random() < 0.5 ? 'normal' : 'reverse',
        amp: (2 + Math.random() * 1.5).toFixed(1),  // 2-3.5deg
      };
    }
    if (cacheKey !== undefined) fogCache[cacheKey] = { circles, rock };
    const { dur: rockDur, delay: rockDelay, dir: rockDir, amp: rockAmp } = rock;

    const el = document.createElement('div');
    el.className = 'fog-cloud';
    el.innerHTML =
      `<svg viewBox="0 0 ${sizeX.toFixed(1)} ${sizeY.toFixed(1)}" xmlns="http://www.w3.org/2000/svg" overflow="visible">` +
        `<g class="fog-rock" style="transform-origin:${(sizeX/2).toFixed(1)}px ${(sizeY/2).toFixed(1)}px; ` +
        `--fog-rock-amp:${rockAmp}deg; animation-duration:${rockDur}s; ` +
        `animation-delay:${rockDelay}s; animation-direction:${rockDir}">${circles}</g>` +
      '</svg>';
    // Stash the bbox/offset mapping so callers can position this element
    // against whatever local coordinate space the polygon was defined in.
    el.dataset.bbox = JSON.stringify({ minX, minY, maxX, maxY, sizeX, sizeY, offX, offY });
    return el;
  }

  // 5-region tile layout (confirmed via artcandidates/tile-layout-5region.svg):
  // 4 pentagons (each quadrant with its room-center-facing corner sliced off)
  // plus a central diamond, in 0-100 LOCAL space spanning the room WALL-CENTER
  // to WALL-CENTER (matching how .room-floor::before already bleeds under the
  // walls — see its `inset: calc(var(--wall-th) / -2)` rule). Region -> fact:
  //   Q1 top-left = Breeze, Q2 top-right = Gold, D center = Pit,
  //   Q3 bottom-right = Wumpus, Q4 bottom-left = Stench.
  const FOG_REGIONS = {
    Q1: [ {x:0,y:0}, {x:50,y:0}, {x:50,y:23.48}, {x:23.48,y:50}, {x:0,y:50} ],
    Q2: [ {x:50,y:0}, {x:100,y:0}, {x:100,y:50}, {x:76.52,y:50}, {x:50,y:23.48} ],
    D:  [ {x:50,y:23.48}, {x:76.52,y:50}, {x:50,y:76.52}, {x:23.48,y:50} ],
    Q3: [ {x:100,y:50}, {x:100,y:100}, {x:50,y:100}, {x:50,y:76.52}, {x:76.52,y:50} ],
    Q4: [ {x:0,y:50}, {x:23.48,y:50}, {x:50,y:76.52}, {x:50,y:100}, {x:0,y:100} ],
  };

  // Place one makeFogPoly() cloud for a region into `cell`. The region's
  // points are in 0-100 LOCAL room space (wall-center to wall-center); the
  // .grid-cell itself is the room INTERIOR (wall-face to wall-face), so the
  // 100-unit room maps onto `calc(100% + var(--wall-th))` of the cell,
  // centered — 1 local unit = that virtual room's own percentage. The fog
  // cloud's own SVG spans a padded bounding box around the region (see
  // makeFogPoly); position/size that whole box in the same percentage terms so
  // its local (0,0) origin lands at the right spot.
  // cacheKey: forwarded to makeFogPoly so this region's blob layout is stable
  // across re-renders (see fogCache) instead of resampling every step.
  function placeFogRegion(cell, points, cacheKey) {
    const fog = makeFogPoly(points, cacheKey);
    const bbox = JSON.parse(fog.dataset.bbox);
    delete fog.dataset.bbox;
    // The .fog-cloud DIV IS the padded SVG canvas (sizeX x sizeY local units):
    // the div is the whole (deliberately oversized) canvas, not just the
    // polygon's own bbox, so its built-in spill naturally overflows into
    // neighboring regions. We only need to position that whole div so the
    // canvas's local (0,0) — which is
    // (true-local-x, true-local-y) = (-offX, -offY), see makeFogPoly — lands
    // at the right spot in the .grid-cell's percentage space.
    //
    // 1 local unit, expressed as a CSS percentage of the .grid-cell box, given
    // the virtual 100-unit room spans (100% + wall-th) of the cell (the room
    // is wall-center to wall-center; the cell is wall-face to wall-face).
    const unit = `((100% + var(--wall-th)) / 100)`;
    // the room's local (0,0) sits half a wall-th before the cell's own 0%
    const roomOrigin = `(-1 * var(--wall-th) / 2)`;
    const originX = -bbox.offX, originY = -bbox.offY; // canvas (0,0) in true-local coords
    fog.style.left = `calc(${roomOrigin} + (${originX}) * ${unit})`;
    fog.style.top = `calc(${roomOrigin} + (${originY}) * ${unit})`;
    fog.style.width = `calc(${bbox.sizeX} * ${unit})`;
    fog.style.height = `calc(${bbox.sizeY} * ${unit})`;
    cell.appendChild(fog);
  }

  // Fog a whole cell using the 5-region layout (replaces the old 4-quadrant
  // placeFog for testing on the real board).
  function placeFog5(cell) {
    for (const key of ['Q1', 'Q2', 'D', 'Q3', 'Q4']) {
      placeFogRegion(cell, FOG_REGIONS[key]);
    }
  }

  // Center an element (token/glyph) on a REGION's centroid, sized as a
  // fraction of that region's own bounding-box extent (not the whole cell).
  // Uses the same wall-center-to-wall-center unit mapping as placeFogRegion,
  // so tokens land in the correct region regardless of cell pixel size.
  // sizeFrac: element size as a fraction of the region's smaller bbox
  // dimension (so a token doesn't overrun a narrow region).
  // nudgeYpx: optional fixed pixel offset added to the vertical position
  // (negative = up), for per-token fine-tuning independent of cell size.
  function placeInRegion(cell, el, points, sizeFrac, nudgeYpx) {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    const extent = Math.min(maxX - minX, maxY - minY);
    const size = extent * sizeFrac;
    const unit = `((100% + var(--wall-th)) / 100)`;
    const roomOrigin = `(-1 * var(--wall-th) / 2)`;
    const dy = nudgeYpx ? ` + ${nudgeYpx}px` : '';
    el.style.position = 'absolute';
    el.style.left = `calc(${roomOrigin} + ${cx} * ${unit})`;
    el.style.top = `calc(${roomOrigin} + ${cy} * ${unit}${dy})`;
    el.style.width = el.style.height = `calc(${size} * ${unit})`;
    el.style.transform = 'translate(-50%, -50%)';
    cell.appendChild(el);
  }

  function renderCell(x, y) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    // Any cell is a query target: clicking fills the ask builder's coordinate.
    cell.addEventListener('click', () => pickAskCell(x, y));

    // Wall torch, bottom-left of the room. Lit once the room has been visited.
    const key = game.key(x, y);
    const isVisited = visited.has(key);
    cell.appendChild(makeTorch(isVisited));
    if (x === 1 && y === 1) cell.appendChild(makeLadder());

    // Each of the 5 regions is either FOG (undetermined and unvisited), an
    // OBJECT glyph (revealed and present), or NOTHING (revealed and proven
    // absent). Visiting a room reveals ALL of it at once, regardless of what's
    // been inferred (the player would perceive everything by standing there).
    // Short of a visit, Pit/Wumpus can also be revealed early by inference
    // (the worker's sweep) or by a direct user query; Breeze/Gold/Stench only
    // reveal via a direct user query (sweep() doesn't cover them) or a visit.
    const rev = reveal[key] || {};
    const asked = askedFacts[key] || {};
    const pitRevealed    = isVisited || rev.pit === 'YES'    || rev.pit === 'NO'    || asked.pit === 'YES'    || asked.pit === 'NO';
    const wumpusRevealed = isVisited || rev.wumpus === 'YES' || rev.wumpus === 'NO' || asked.wumpus === 'YES' || asked.wumpus === 'NO';
    const goldRevealed   = isVisited;
    const breezeRevealed = isVisited || asked.breezy === 'YES' || asked.breezy === 'NO';
    const stenchRevealed = isVisited || asked.stenchy === 'YES' || asked.stenchy === 'NO';

    // Q1 Breeze
    if (!breezeRevealed) {
      placeFogRegion(cell, FOG_REGIONS.Q1, key + ',Q1');
    } else if (game.breezyAt(x, y)) {
      placeInRegion(cell, makeBreeze(), FOG_REGIONS.Q1, 1.0);
    }
    // Q2 Gold
    if (!goldRevealed) {
      placeFogRegion(cell, FOG_REGIONS.Q2, key + ',Q2');
    } else if (game.gold[0] === x && game.gold[1] === y && !game.state.hasGold) {
      const gold = document.createElement('img');
      gold.src = 'artcandidates/hoard-09-heaped-pile.svg';
      gold.alt = 'gold';
      placeInRegion(cell, gold, FOG_REGIONS.Q2, 0.75, -10);
    }
    // D Pit
    if (!pitRevealed) {
      placeFogRegion(cell, FOG_REGIONS.D, key + ',D');
    } else if (game.pits.has(key)) {
      placeInRegion(cell, makePit(), FOG_REGIONS.D, 0.75);
    }
    // Q3 Wumpus (live or dead variant)
    if (!wumpusRevealed) {
      placeFogRegion(cell, FOG_REGIONS.Q3, key + ',Q3');
    } else if (game.wumpus[0] === x && game.wumpus[1] === y) {
      const wump = document.createElement('img');
      wump.src = game.state.wumpusAlive
        ? 'artcandidates/wumpus-02-menacing-brows.svg'
        : 'artcandidates/wumpus-dead.svg';
      wump.alt = game.state.wumpusAlive ? 'wumpus' : 'wumpus (dead)';
      placeInRegion(cell, wump, FOG_REGIONS.Q3, 1.0, -12.5);
    }
    // Q4 Stench
    if (!stenchRevealed) {
      placeFogRegion(cell, FOG_REGIONS.Q4, key + ',Q4');
    } else if (game.stenchyAt(x, y)) {
      const st = document.createElement('img');
      st.src = 'artcandidates/glyph-stench.svg';
      st.alt = 'stench';
      placeInRegion(cell, st, FOG_REGIONS.Q4, 0.8);
    }

    const coord = document.createElement('div');
    coord.className = 'coord';
    coord.textContent = `(${x},${y})`;
    cell.appendChild(coord);

    // The player is still drawn as the hero SVG token, at full-cell scale
    // (not region-scoped — the player moves freely through the whole room).
    const hereAttr = cellAttrs(x, y).find(a => a.player);
    if (hereAttr) {
      const token = document.createElement('img');
      token.className = 'player-token';
      token.src = 'artcandidates/hero-10a3.svg';
      token.alt = 'player';
      cell.appendChild(token);
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

  /* Build a tab bar: one button per tab, styled like the mode toggle
     (.mode-btn.active reused as .tab-btn.active — same gold-highlight
     language). `tabs` is [{ key, label, disabled? }]. `activeKey` is the
     currently-selected key; `onSelect(key)` fires on click (ignored for a
     disabled tab). Returns the bar element; does not touch panel content —
     the caller decides what to render below based on the active key. */
  function renderTabBar(tabs, activeKey, onSelect) {
    const bar = document.createElement('div');
    bar.className = 'tab-bar';
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' +
        (t.key === activeKey ? ' active' : '') +
        (t.disabled ? ' disabled' : '');
      btn.textContent = t.label;
      if (t.disabled) {
        btn.disabled = true;
        if (t.disabledReason) btn.title = t.disabledReason;
      } else {
        btn.addEventListener('click', () => onSelect(t.key));
      }
      bar.appendChild(btn);
    }
    return bar;
  }

  function renderGrid() {
    // The tab bar IS the panel's title bar — "Wumpus Dungeon" is just the
    // default-selected tab, not a separate fixed heading above the tabs.
    gamePanel.innerHTML = '';

    gamePanel.appendChild(renderTabBar(
      [
        { key: 'dungeon', label: 'Wumpus Dungeon' },
        { key: 'about',   label: 'About' },
        { key: 'howto',   label: 'How To' },
      ],
      gameTab,
      (key) => { gameTab = key; renderGrid(); },
    ));

    if (gameTab === 'about')  { gamePanel.appendChild(renderAboutTab()); return; }
    if (gameTab === 'howto')  { gamePanel.appendChild(renderHowToTab()); return; }

    // 'dungeon' tab: board first, then the toolbar (New map + status) beneath it.
    const board = renderBoard();
    gamePanel.appendChild(board);

    const s = game.state;
    // Outcome overlay: dramatic stylized text over the board itself (NOT the
    // status line — score/outcome are dropped from there, since the policy
    // never actually considers score). 'dead' -> Defeat, 'win' -> Victory,
    // 'left' -> Escape (climbed out without the gold — survived, but no win).
    if (s.done) {
      const OUTCOME_TEXT = { win: 'Victory', left: 'Escape', dead: 'Defeat' };
      const overlay = document.createElement('div');
      overlay.className = 'outcome-overlay outcome-' + s.outcome;
      overlay.textContent = OUTCOME_TEXT[s.outcome];
      board.appendChild(overlay);
    }

    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const newMap = document.createElement('button');
    newMap.className = 'new-map-btn';
    newMap.textContent = 'New Map';
    newMap.addEventListener('click', newGame);
    bar.appendChild(newMap);

    const status = document.createElement('span');
    status.className = 'status';
    // The agent's INFERRED belief about the Wumpus (not the game's truth).
    const wa = beliefs.wumpusAlive;
    const wumpus = wa === 'NO' ? 'dead' : wa === 'YES' ? 'alive' : '?';
    const gold = beliefs.hasGold === 'NO' ? 'no' : beliefs.hasGold === 'YES' ? 'yes' : '?';
    status.textContent =
      `Level: ${lastSeed} | gold: ${gold} | arrow: ${s.hasArrow ? 'yes' : 'no'} | ` +
      `wumpus: ${wumpus} | at: ${beliefs.location || '?'}`;
    bar.appendChild(status);

    // Reset: replay the CURRENT map from scratch (same seed), on the opposite
    // side of the status text from New Map — for re-driving a problem map
    // step by step to watch a policy decision (e.g. when the arrow fires).
    const reset = document.createElement('button');
    reset.className = 'new-map-btn';
    reset.textContent = 'Reset';
    reset.addEventListener('click', resetGame);
    bar.appendChild(reset);

    // Load Map: prompt for an explicit seed and replay that map. Lets a
    // problem map (its seed read off "Level: …") be reloaded after a page
    // refresh — e.g. to pick up a logic.js/worker.js fix and re-test the
    // exact same layout, without needing the URL round-trip.
    const loadMap = document.createElement('button');
    loadMap.className = 'new-map-btn';
    loadMap.textContent = 'Load Map';
    loadMap.addEventListener('click', () => {
      const input = prompt('Enter a level seed to load:', lastSeed ?? '');
      if (input === null) return;                    // cancelled
      const n = Number(input);
      if (!Number.isFinite(n)) { alert('Not a valid seed number.'); return; }
      startGame(n >>> 0);
    });
    bar.appendChild(loadMap);

    gamePanel.appendChild(bar);
  }

  // Static prose for the About tab. User-facing text calls a board square a
  // "room" throughout (code/comments elsewhere still say "cell" or "room"
  // interchangeably — that's fine internally, but the student-facing copy
  // should be consistent).
  function renderAboutTab() {
    const el = document.createElement('div');
    el.className = 'tab-content prose';
    el.innerHTML = `
      <h3>The Wumpus World</h3>

      <p>The Wumpus World is a classic test bed for logical agents, from Russell &amp; Norvig's <em>Artificial Intelligence: A Modern Approach</em>. A brave hero explores a grid of rooms looking for gold, while trying not to die. Two hazards lurk in the dungeon: bottomless <strong>pits</strong> into which the hero can fall and a single <strong>Wumpus</strong> who is ready to eat the hero on sight. Entering into a room with either a pit or the Wumpus means certain death and the end of the game.</p>

      <p>Unfortunately, the hero can't see these hazards directly (until it is too late). The hero must infer them from <strong>percepts</strong>. A <strong>breeze</strong> means a pit is in an adjacent room; a <strong>stench</strong> means the Wumpus is in an adjacent room; a <strong>glitter</strong> means gold is in the current room. Two rooms are adjacent if one is immediately north (up), south (down), east (right), or west (left) of the other.</p>
      
      <p>The hero also carries a single <strong>arrow</strong>, which he can fire in a straight line down a row or column to kill the Wumpus (a <strong>scream</strong> percept confirms a hit). The hero's primary goal: grab the gold and climb back out through the entrance at room (1,1). If the gold cannot be reached, the hero must be content to escape the dungeon alive. In this visualization, you will have the opportunity to both control the hero and to observe how a logical agent would navigate the Wumpus World.</p>

      <h3>Logical agents</h3>
      <p>A <strong>logical agent</strong> doesn't guess — it demands certainty. It maintains a <strong>knowledge base</strong> (KB) of logical sentences — facts it has sensed, actions it has taken, and general rules about how the world works (e.g. "a room is breezy if and only if a neighboring room has a pit"). It only commits to a belief once that belief is <strong>logically entailed</strong> by the KB. This means that it is impossible for the new belief, or <strong>inference</strong>, to be false given what the agent already knows. To check this, the agent uses the <strong>resolution algorithm</strong> to check whether there is any way a candidate inference could be false if the statements in its knowledge base are true. This process of inference-checking is called a <strong>query</strong> and the agent poses queries using the <strong>ASK</strong> operation.</p>
      <p>After each move, the agent will determine its current location and record any percepts that it perceives. It then poses a series of queries to answer important questions (e.g., is there a pit in the room to the north). Using this information, the agent follows a simple decision tree for determining what to do next.</p>
      <p>The benefit of this approach is that the agent never takes risks: it never steps into a room unless it has actually proven that room safe, so it never dies. The cost is that proof is conservative — a room the agent merely <em>suspects</em> is safe (or unsafe), without proof, is treated exactly like a room it knows is dangerous. A logical agent that only ever acts on proof will sometimes leave gold behind, or explore less efficiently than an agent willing to guess.</p>

      <h3>Behind the scenes: making resolution work in practice</h3>
      <p>Textbook resolution is simple to describe and painfully slow to run as-is. It works by translating the agent's knowledge base and negated query into a set of clauses that it compares to one another, looking for new inferences and (ultimately) contradictions. If a contradiction is found, that means that it's impossible for the query to be false (hence, the negation) if the KB is true. If no contradiction is found — despite all possible inferences being made — then it is possible for the KB to be true and the query false.</p>

      <p>The problem with resolution is that it has no way to determine which clauses from its KB are relevant to the current query. For example, there is no direct relationship between pits/breeze rules and Wumpus/stench rules. That is, inferences about pits and inferences about Wumpuses will depend on distinct subsets of clauses from the KB. This means that resolution might spend a long time comparing irrelevant clauses and making irrelevant inferences before a contradiction is found. Worse, when no contradiction is present, the number of potential inferences resolution must explore can be truly vast.</p>

      <p>Getting this project's resolution algorithm to answer in real time — while still showing an honest, complete proof — required several deliberate shortcuts. Each trades away some generality for speed, in a way that's sound for <em>this specific game</em> but would need re-justifying in a different domain.</p>
      <ul>
        <li><strong>Anchoring and component separation.</strong> Most of the KB is facts and rules about specific rooms. A question about room (3,4) almost never needs to reason about room (1,1)'s rules at all — so before resolution starts, the agent filters the KB down to only the clauses that are actually reachable from the query by a chain of shared symbols (and, for rules that are anchored to a specific room, only when that room has actually been visited). This keeps every individual proof small, at the cost of re-filtering on every question rather than reusing one global proof.</li>
        <li><strong>Pure symbol elimination.</strong> A single symbol that appears with only one polarity across the filtered clause set (always negated, or never negated) can never be the pivot of a resolution step — resolution needs a complementary pair (one negated, one not negated). Clauses that only contain such symbols are dropped before the real search begins, since they can't contribute to a contradiction either way.</li>
        <li><strong>Unit subsumption.</strong> A known single-symbol fact (or "unit clause") can be used to immediately simplify any clause in which its complement appears. Applying this aggressively first — like a very restricted, fast pre-pass — shrinks the clause set before the general (much more expensive) resolution loop has to run at all.</li>
        <li><strong>No general cardinality axioms.</strong> R&amp;N's formulation can express facts like "exactly one Wumpus exists" as a family of clauses ruling out every pair of rooms both holding a Wumpus — sound, but expensive to state and use in general. This project instead hand-derives the one narrow, sound consequence of "there is exactly one Wumpus" the game actually needs: <strong>triangulation</strong>. If two rooms on a shared diagonal are both stenchy, the Wumpus must be in one of their (exactly two) common neighboring rooms — a disjunction that collapses to certainty once one candidate room is independently ruled out (typically by being visited safely). This is far cheaper than a general cardinality theory, but it is also far less general: it only knows what it was specifically built to know, and would not, by itself, generalize to "two Wumpuses" or a differently-shaped board without rewriting the rule.</li>
        <li><strong>Situation calculus.</strong> Formally tracking how facts change over time (whether the agent still has the arrow, where it believes it is, whether the Wumpus is still alive) calls for the full successor-state-axiom machinery of situation calculus. This project uses a lighter-weight version in two ways. First, not everything is actually time-indexed: Breezy and Stenchy are room properties that never change once the map is generated, so they are asserted as plain, untimed facts (<code>Breezy(x,y)</code>) rather than fluents (<code>Breezy(x,y,t)</code>) — only the genuinely dynamic facts (the arrow, the agent's location, whether the Wumpus is alive, whether gold is held) get the full time-indexed treatment. Second, each of those time-varying facts is tracked as a single "current value," proven fresh via one resolution step from the previous step's already-proven value, rather than re-deriving the entire history from time zero every turn.</li> 
        <li><strong>Dynamic Knowledge Base.</strong>The KB doesn't let old time-indexed axioms pile up or generate axioms for time steps arbitrarily far into the future. At the start of each step, every axiom timestamped strictly before the current time is <strong>retired</strong> (deleted) from the knowledge base and replaced by new axioms. A short list of exceptions is kept regardless of age — the agent's believed location history and the record of actions actually taken — because later reasoning (e.g. "was I ever in the room with the gold") needs to refer back to them. This keeps the KB's temporal layer bounded in size rather than growing every turn, at the cost of a KB that can no longer answer new questions about the past or future.</li>
        <li><strong>Unit resolution, where applicable.</strong> Unit subsumption (above) is a preprocessing pass; unit resolution is different — it's a restricted MODE of the search itself, allowing a resolution step only when at least one of the two clauses being combined is already a unit clause (a single literal). This is sound but not complete in general: a full, unrestricted search can prove true things a unit-only search cannot. This project accepts that incompleteness for a specific slice of queries — the gold and self-location fluents — because their supporting rules happen to share atoms with the location-tracking machinery, which would otherwise merge everything into one large component that full resolution saturates expensively. The game maintains only a single believed location for each time step — there is no positional uncertainty to reason about — which guarantees these particular facts are always provable by unit resolution alone, so restricting to it there costs nothing in what can be proven, while sidestepping the expensive general search entirely.</li>
      </ul>
      <p>None of these shortcuts change <em>what</em> the agent can correctly conclude in this game — every one was chosen because it is sound for the Wumpus World specifically. But that "specifically" matters: this is not a general-purpose theorem prover, and the corners cut to make it fast here would need to be reconsidered for a differently-shaped problem. This is a familiar tradeoff in computer science. Optimization requires us to leverage our knowledge of the target domain in order to improve performance.</p>`;
    return el;
  }

  // Static prose + reference diagram for the How To tab.
  function renderHowToTab() {
    const el = document.createElement('div');
    el.className = 'tab-content prose';
    el.innerHTML = `
      <h3>Manual vs. Automatic Modes</h3>
      <p>The mode toggle at the bottom of the Controls panel switches who controls our hero. In <strong>Manual</strong> mode, you control the hero with the movement, shooting, and action buttons. In <strong>Automatic</strong> mode, the hero is controlled by a logical agent according to a set of simple rules, dynamically visualized in the <strong>Decision Rules</strong> tab. In both modes, the <strong>Knowledge Base</strong> panel updates to show you what the hero currently knows (note discussion of the "Dynamic Knowledge Base" under "About"). Similarly, in both modes, the <strong>Resolution</strong> tab updates to show what the hero has (or has not) proven about the world during the present turn.</p>
      
      <p>In addition to who selects the hero's actions, the two modes differ in how the dungeon is revealed. In Automatic mode, the logical agent automatically makes queries about hazards based on its current percepts. For example, if a breeze is detected, the agent will query whether the adjacent cells contain a pit. The logical agent also checks on the current status of fluents (parts of the world that can change), including whether the agent has the arrow, whether the agent has the gold, whether the agent is where they expected to be given their last movement, and whether the Wumpus is alive. In Manual mode, these fluent checks are still automatic, but the user is responsible for making queries about hazards and percepts. The only way a hazard or percept can be revealed in Manual mode (apart from visiting a room and taking your chances) is by proving the presence or absence of that hazard via a query made using the <strong>Ask</strong> panel. The only exception to this is that inferences about the Wumpus based on arrow shots remain automatic.</p>
      
      <h3>Reading the Rooms</h3>
      <p>Each room is divided into five regions, one per fact the hero can learn about that room. Fog covers a region until that specific fact is settled, whether (i) by walking into the room (which reveals everything at once) or (ii) by the agent proving it through inference (whether automatically or via the Ask panel). Once revealed, a region shows either the matching icon (the fact is true) or nothing (the fact is false).</p>
      <div class="howto-diagram">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="1" y="1" width="98" height="98" fill="none" stroke="#5a3e10" stroke-width="1.5"/>
          <g fill="none" stroke="#5a3e10" stroke-width="1">
            <polygon points="50,25 75,50 50,75 25,50"/>
            <line x1="0" y1="50" x2="25" y2="50"/>
            <line x1="50" y1="0" x2="50" y2="25"/>
            <line x1="100" y1="50" x2="75" y2="50"/>
            <line x1="50" y1="75" x2="50" y2="100"/>
          </g>
        </svg>
        <!-- Five hoverable regions, positioned over the skeleton above (same
             0-100 coordinate space, as percentages). Each shows its label by
             default and swaps to the REAL in-game glyph on hover — the same
             assets/generators renderCell uses, not a redrawn approximation. -->
        <div class="howto-region" id="howto-region-breeze" style="left:0; top:0; width:50%; height:50%;">
          <span class="howto-region-label">Breeze</span>
          <div class="howto-region-glyph"></div>
        </div>
        <div class="howto-region" id="howto-region-gold" style="left:50%; top:0; width:50%; height:50%;">
          <span class="howto-region-label">Gold</span>
          <div class="howto-region-glyph"><img src="artcandidates/hoard-09-heaped-pile.svg" alt="gold"></div>
        </div>
        <div class="howto-region" id="howto-region-pit" style="left:25%; top:25%; width:50%; height:50%;">
          <span class="howto-region-label">Pit</span>
          <div class="howto-region-glyph"></div>
        </div>
        <div class="howto-region" id="howto-region-wumpus" style="left:50%; top:50%; width:50%; height:50%;">
          <span class="howto-region-label">Wumpus</span>
          <div class="howto-region-glyph"><img src="artcandidates/wumpus-02-menacing-brows.svg" alt="wumpus"></div>
        </div>
        <div class="howto-region" id="howto-region-stench" style="left:0; top:50%; width:50%; height:50%;">
          <span class="howto-region-label">Stench</span>
          <div class="howto-region-glyph"><img src="artcandidates/glyph-stench.svg" alt="stench"></div>
        </div>
      </div>
      <p>A room's torch lights once you've visited it. The entrance room, (1,1), features a ladder against its south wall, which is the only place the hero can climb out of the dungeon.</p>

      <h3>Making Queries</h3>
      <p>The Ask panel lets you pose a query directly. This is helpful for confirming (or disconfirming) your hunches in manual mode. It is also the only way of manually clearing fog from Wumpus, Pit, or percept positions before entering a room. A query is built by clicking, not typing: choose one of the four atom buttons (Breeze, Stench, Pit, Wumpus), optionally toggle <strong>¬</strong> to negate it, then click a room on the map to fill in its coordinates. The query text at the top of the panel shows the result so far — in red with underscores for the missing coordinates while incomplete, in normal text once all three parts (atom, ¬, room) are set. <strong>Clear</strong> empties the builder; <strong>Submit</strong> (grayed out until the query is complete) sends it to the resolution algorithm for testing against the knowledge base.</p>
      <p>Submitting runs the exact same resolution proof the logical agent runs automatically, and the steps appear in the Resolution panel like any other. You may submit your own queries in manual mode or in automatic mode (if advancing the logical agent using the <strong>step</strong> button). A submitted query is highlighted so you can tell it apart from the logical agent's automatic queries. If the proof settles the question one way or the other, that fact is recorded permanently: the corresponding region's fog clears on the map, just as if the agent had proven it during its own turn. If resolution can't settle it — not enough is known yet — nothing changes, and you can always try again once more of the map has been explored.</p>

      <h3>Controls</h3>
      <ul>
        <li><strong>Move (N/E/S/W)</strong> — step the hero one room in that direction, if there's no wall in the way. Keyboard: arrow keys.</li>
        <li><strong>Shoot (N/E/S/W)</strong> — fire the arrow in a straight line down the current row or column. Remember, our hero has only brought a single arrow, and the game tracks whether it's already been spent. Keyboard: W/A/S/D (W = north, D = east, S = south, A = west).</li>
        <li><strong>Grab</strong> — pick up the gold, if any is in the current room. Keyboard: G.</li>
        <li><strong>Climb</strong> — attempt to leave the dungeon. Remember, the only exit is in the entrance room, (1,1). Leaving the dungeon ends the game (win or otherwise). Keyboard: C.</li>
        <li><strong>Manual / Automatic</strong> — the mode toggle described above.</li>
        <li><strong>Run</strong> — have the logical agent complete a full run (useful for assessing the automatic agent's performance).</li>
        <li><strong>Step</strong> — have the logical agent complete one turn (useful for understanding the automatic agent's behavior) </li>
        <li><strong>New Map</strong> — generate a fresh randomized dungeon.</li>
        <li><strong>Reset</strong> — replay the <em>current</em> dungeon from scratch (same seed or "Level"), useful for re-watching a specific decision.</li>
        <li><strong>Load Map</strong> — load a dungeon by its seed number (shown as "Level: …" in the status line), so a specific map can be reproduced later.</li>
      </ul>`;

    // The Breeze/Pit glyphs are live-generated DOM (randomized wind arcs —
    // see makeBreeze/makePit), so they can't be embedded in the innerHTML
    // string above; append them here instead. Gold/Wumpus/Stench are plain
    // <img> tags already in the string (the same asset files renderCell
    // uses), so nothing further is needed for those.
    el.querySelector('#howto-region-breeze .howto-region-glyph').appendChild(makeBreeze());
    el.querySelector('#howto-region-pit .howto-region-glyph').appendChild(makePit());

    return el;
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
    // The tab bar IS the panel's title bar — "Resolution" is just the
    // default-selected tab, not a separate fixed heading above the tabs.
    solverPanel.innerHTML = '';

    // Decision Rules watches the AUTOMATIC policy step through its rule list —
    // meaningless in Manual mode (the user picks actions directly, no policy
    // runs), so the tab is disabled there and the panel falls back to
    // Resolution regardless of which tab was last selected.
    const decisionRulesDisabled = mode !== 'automatic';
    if (decisionRulesDisabled && resolverTab === 'decisionRules') resolverTab = 'resolution';

    solverPanel.appendChild(renderTabBar(
      [
        { key: 'resolution',    label: 'Resolution' },
        { key: 'decisionRules', label: 'Decision Rules', disabled: decisionRulesDisabled,
          disabledReason: 'Only available in Automatic mode' },
      ],
      resolverTab,
      (key) => { resolverTab = key; renderSolver(); },
    ));

    if (resolverTab === 'decisionRules') { solverPanel.appendChild(renderDecisionRulesTab()); return; }

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

  // Canonical rule list (labels mirror the `record(...)` calls in logic.js
  // policyAction, in order) — used to show ALL 9 rules every turn, even the
  // ones a short-circuited trace never reached. Keep in sync with that
  // function's docstring/record() calls if the policy changes.
  const POLICY_RULES = [
    { rule: 1, label: 'If gold in current room, grab.' },
    { rule: 2, label: 'Elif carrying gold AND at (1,1), climb.' },
    { rule: 3, label: 'Elif carrying gold, go toward (1,1).' },
    { rule: 4, label: 'Elif Wumpus known AND can shoot Wumpus, shoot.' },
    { rule: 5, label: 'Elif Wumpus known, go toward nearest safe firing position.' },
    { rule: 6, label: 'Elif adjacent unvisited safe room exists, go to it.' },
    { rule: 7, label: 'Elif unvisited safe room exists, go toward it.' },
    { rule: 8, label: 'Elif not at (1,1), step toward (1,1).' },
    { rule: 9, label: 'Else climb out.' },
  ];

  /* The automatic policy's rule-by-rule trace (see logic.js policyAction),
     from the latest 'decision' reply — a Run/Step in automatic mode requests
     one every turn. ALL rules are always listed, in order, so a student can
     read the whole policy before ever running it; a red X marks each rule
     the trace reached and rejected, a green check marks the one that fired
     (with the action it chose). Before any decision this turn — or before
     the very first one — every rule is simply unmarked (lastPolicyTrace is
     null; treated the same as an empty trace: nothing reached yet). */
  function renderDecisionRulesTab() {
    const el = document.createElement('div');
    el.className = 'tab-content decision-rules';

    const byRule = new Map((lastPolicyTrace || []).map(t => [t.rule, t]));

    const list = document.createElement('ol');
    list.className = 'decision-rule-list';
    for (const r of POLICY_RULES) {
      const t = byRule.get(r.rule);   // undefined if never reached this turn
      const li = document.createElement('li');
      li.className = 'decision-rule' +
        (t ? (t.matched ? ' matched' : ' rejected') : ' unreached');

      const mark = document.createElement('span');
      mark.className = 'decision-rule-mark';
      mark.textContent = t ? (t.matched ? '✓' : '✗') : '☐';   // unreached: empty checkbox
      li.appendChild(mark);

      const num = document.createElement('span');
      num.className = 'decision-rule-num';
      num.textContent = r.rule + '.';
      li.appendChild(num);

      const label = document.createElement('span');
      label.className = 'decision-rule-label';
      label.textContent = r.label;
      li.appendChild(label);

      // Always present (even unmatched) so the row's layout — and therefore
      // where the label wraps — never changes the moment a rule fires; only
      // its text differs.
      const action = document.createElement('span');
      action.className = 'decision-rule-action';
      action.textContent = (t && t.matched) ? '→ ' + t.action : '';
      li.appendChild(action);

      list.appendChild(li);
    }
    el.appendChild(list);
    return el;
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
      { key: 'input',       title: 'Anchoring and Component Separation', note: 'filtered by anchor + component separation' },
      { key: 'pureSymbol',  title: 'Pure Symbol Elimination', note: 'after pure-symbol elimination' },
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

    // A query can be legitimately "not entailed" with ZERO resolution steps:
    // if nothing in the KB is yet connected (via the anchor/component-
    // separation filter) to the query's atoms — e.g. asking about a distant,
    // unvisited cell early in the game — pure-symbol elimination can reduce
    // the whole component to nothing before resolution proper ever runs.
    // That's a correct, trivial proof, not a bug — but with no placeholder it
    // reads as broken (steps silently missing). Flag it explicitly instead.
    if (ask.steps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'res-step-empty';
      empty.textContent = 'No resolution steps — nothing in the knowledge base was connected to this query yet.';
      askEl.appendChild(empty);
      return;
    }

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
    for (const [name, value] of [['Automatic', 'automatic'], ['Manual', 'manual']]) {
      const b = document.createElement('button');
      b.className = 'mode-btn' + (mode === value ? ' active' : '');
      b.textContent = name;
      b.addEventListener('click', () => setMode(value));
      modeToggle.appendChild(b);
    }

    const runStep = document.createElement('div');
    // Grayed out (like the manual pad in automatic mode) until Automatic is
    // selected — Run/Step do nothing in Manual mode, so they should read as
    // visibly inert, not just individually disabled.
    runStep.className = 'run-step' + (mode !== 'automatic' ? ' disabled' : '');

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
     Leaving automatic while a run is active stops it.

     Manual mode withholds automatic frontier inference (sweep's autoInfer:false
     — see worker.js), so the agent's `determined` cache can be stale for the
     POLICY when the user switches to automatic mid-game: policyAction() reads
     `determined` to decide which cells are safe, and a cell the user actually
     visited but never proved via ASK reads as unsafe, sending the agent
     straight back to (1,1) (rule 9) instead of exploring it. Fix: on entering
     automatic, force one resync sweep (autoInfer:true, no world change) before
     any Run/Step can fire, so the cache is caught up to everything now provable
     from percepts gathered so far. */
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    // Leaving automatic cancels any run AND any in-flight single step, so a
    // pending 'decision' reply can't apply a stray auto-action in manual mode.
    if (mode !== 'automatic') { if (running) stopRun(); stepping = false; }
    else if (game && !game.state.done) {
      resyncAgent();
      agentSwept = true;   // this resync covers the same catch-up requestDecision/stepOnce do
    }
    renderControls();
  }

  // Re-sweep the worker's agent with autoInfer:true and no world change. Locks
  // input (like doAction) so a Run/Step click can't race ahead of the reply.
  function resyncAgent() {
    setBusy(true);
    worker.postMessage({ type: 'resync', gen, mode });
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
  // If the agent hasn't been swept with inference yet this game (true by
  // default — see agentSwept), catch it up first via the same resync used
  // for a Manual->Automatic mode switch; requestDecisionAfterSync (below)
  // fires the real decide request once that catch-up 'done' reply lands.
  function requestDecision() {
    if (!running) return;
    if (!agentSwept) { pendingAutoDecision = true; resyncAgent(); return; }
    worker.postMessage({ type: 'decide', gen });
  }

  // Apply a policy-chosen action through the same flow a manual click uses.
  function autoApply(action) {
    doAction(action);
  }

  /* Single automatic Step: one policy action, no loop. Ignored while a run is
     active, a step is already in flight, inference is pending, the game is over,
     or we're not in automatic mode. The 'decision' reply applies it (stepping is
     set), and 'done' clears the flag. Mirrors requestDecision's catch-up sync
     for an agent that hasn't been swept with inference yet this game. */
  function stepOnce() {
    if (running || stepping || inferring || mode !== 'automatic' || game.state.done) return;
    stepping = true;
    renderControls();                    // reflect the in-flight step (disable buttons)
    if (!agentSwept) { pendingAutoDecision = true; resyncAgent(); return; }
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
     a manual ask with the agent's step queries on the shared KB. setBusy(true)
     locks input for the DURATION of the ask too (a threat query — Pit/Wumpus —
     can run a much larger, unbounded search than a percept query and take
     noticeably longer): without this, a click/keypress/automatic Run step taken
     while the ask is still resolving would reach doAction and clear
     `resolutions` out from under the still-pending ask's reply, discarding its
     view before it ever renders. The worker has no 'done' for a plain ask, so
     the matching setBusy(false) lives in the 'resolution' handler instead,
     keyed off view.userPosed (see below). */
  function submitAsk() {
    if (!askComplete() || inferring) return;
    setBusy(true);
    renderAsk();          // reflect the now-disabled Submit button immediately
    worker.postMessage({ type: 'ask', gen, query: askQuery });
  }

  renderControls();
  renderAsk();
  startInitialGame();
});

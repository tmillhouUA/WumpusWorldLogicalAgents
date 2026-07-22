# Dungeon of the Wumpus — Logical Agent Visualizer

An interactive, browser-based visualization of a **logical agent** solving the Wumpus World, from Russell & Norvig's *Artificial Intelligence: A Modern Approach*. Watch (or drive) a hero exploring a grid dungeon, and see exactly what the agent knows, what it has proven, and why it acts the way it does — one resolution step at a time.

## The Wumpus World

A hero explores a grid of rooms looking for gold, while trying not to die. Two hazards lurk in the dungeon: bottomless **pits**, and a single **Wumpus** ready to eat the hero on sight. Entering a room with either means instant death.

The hero can't see these hazards directly. They must be inferred from **percepts**: a **breeze** means a pit is in an adjacent room; a **stench** means the Wumpus is in an adjacent room; a **glitter** means gold is in the current room. The hero also carries one **arrow**, fired in a straight line to kill the Wumpus (a **scream** confirms a hit). The goal is to grab the gold and climb back out through the entrance at (1,1) — or failing that, to escape alive.

## Logical Agents

A logical agent doesn't guess — it demands certainty. It maintains a **knowledge base** (KB) of logical sentences: facts it has sensed, actions it has taken, and general rules about how the world works. It only commits to a belief once that belief is **logically entailed** by the KB — meaning it's impossible for the belief to be false given what the agent already knows. It checks this using the **resolution algorithm**, posing a **query** (via **ASK**) for each fact it needs to settle.

The payoff: the agent never takes risks, and so it never dies from a preventable mistake — it never enters a room unless it has actually *proven* that room safe. The cost: proof is conservative. A room merely *suspected* safe, without proof, is treated exactly like a room known to be dangerous, so a purely logical agent will sometimes leave gold behind or explore less efficiently than one willing to guess.

This project makes both halves of that trade visible — the missed opportunities that arise from requiring proof and the safety that proof provides.

## Modes

The mode toggle switches who controls the hero.

| Mode | Actions | Dungeon reveals |
|---|---|---|
| **Automatic** (default) | A logical agent chooses every action, following a fixed 9-rule decision policy (visible live in the **Decision Rules** tab) | The agent automatically queries hazards implied by its current percepts |
| **Manual** | You choose every action | Only by walking into a room, or by proving a fact yourself via the **Ask** panel |

In both modes, the **Knowledge Base** panel shows what the hero currently knows, and the **Resolution** tab shows what has (or hasn't) been proven this turn. Fluent checks (arrow, gold, location, whether the Wumpus is still alive) stay automatic in both modes — only *hazard* queries are gated by mode.

## Reading the Rooms

Each room is divided into five regions, one per fact the hero can learn about it: Breeze, Gold, Pit, Wumpus, Stench. Fog covers a region until that fact is settled — either by visiting the room (which reveals everything at once) or by the agent proving it through inference. Once revealed, a region shows its glyph (fact true) or nothing (fact false).

## Making Queries

The **Ask** panel lets you pose a query by hand: pick an atom (Breeze/Stench/Pit/Wumpus), optionally negate it (¬), then click a room to fill in its coordinates. **Submit** runs the exact same resolution proof the automatic agent uses, and the steps stream into the Resolution panel. If the proof settles the question, the corresponding fog clears on the map — same as if the agent had proven it on its own turn.

## Controls

| Control | Function |
|---|---|
| Move (N/E/S/W) | Step one room in that direction. Keyboard: arrow keys |
| Shoot (N/E/S/W) | Fire the (single) arrow down the current row/column. Keyboard: W/A/S/D |
| Grab | Pick up gold in the current room. Keyboard: G |
| Climb | Leave the dungeon (only works at the entrance, (1,1)). Keyboard: C |
| Manual / Automatic | Mode toggle |
| Run | Let the agent play out a full game |
| Step | Advance the agent one turn at a time |
| New Map | Generate a fresh randomized dungeon |
| Reset | Replay the current dungeon (same seed) from scratch |
| Load Map | Load a specific dungeon by its Level/seed number |

## Behind the Scenes

Textbook resolution is simple to describe and painfully slow to run as-is — it has no way to know which KB clauses are relevant to a given query, so it can waste enormous effort on irrelevant comparisons. Getting this project's resolution to answer in real time, while still showing an honest, complete proof, took several deliberate, game-specific shortcuts:

- **Anchoring and component separation** — before resolving, filter the KB down to clauses actually reachable from the query by a chain of shared symbols (and, for room-specific rules, only rooms already visited).
- **Pure symbol elimination** — drop clauses containing a symbol that only ever appears with one polarity; it can never be a resolution pivot.
- **Unit subsumption** — use known single-fact clauses to simplify the clause set before the expensive general search runs.
- **No general cardinality axioms** — instead of a full "exactly one Wumpus" axiom family, hand-derive the one consequence the game needs: triangulation from two stenchy rooms on a shared diagonal.
- **Lightweight situation calculus** — only genuinely time-varying facts (arrow, location, Wumpus alive, gold held) are time-indexed; static facts like Breezy/Stenchy are plain untimed atoms. Each time-varying fact tracks a single current value, proven fresh from the prior step rather than re-derived from time zero.
- **Dynamic knowledge base** — outdated time-indexed axioms are retired each turn rather than left to accumulate, keeping every proof bounded in size.
- **Unit resolution, where sound** — a restricted (unit-only) search is used for the fluents that happen to always be provable that way, avoiding an expensive general search without losing completeness for those specific queries.

Every shortcut here is **sound** — it never lets the agent conclude something false. Not all of them are **complete** in general (unit resolution, in particular, can miss entailments a full search would catch) — but each is complete *for our Wumpus World agent specifically*: for every query that actually needs answered, the restricted search still finds the proof whenever one exists. This is a deliberate, familiar tradeoff: optimization leverages knowledge of the target domain to buy performance, at the cost of generality outside it.

## Usage

A live version is available at [tmillhouua.github.io/WumpusWorldLogicalAgents](https://tmillhouua.github.io/WumpusWorldLogicalAgents/).

Alternatively, clone or download the repository and serve the folder locally (e.g. `npx serve .`). The app uses a Web Worker for the agent's reasoning, which most browsers block from running off a plain `file://` page — so serving isn't optional, though it still requires no build step, just a static file server.

## Dependencies

None. The game logic, resolution engine, and UI are all plain HTML/CSS/JavaScript with zero external libraries. Webfonts (`fonts/`) are bundled locally — the app has no network dependency at all once loaded.

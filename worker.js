/* worker.js — the agent's "brain", off the main thread.

   Runs the expensive part (KB + resolution) so a slow sweep never freezes the
   UI. Loads the same logic layer the page uses (classic worker, no modules)
   and owns a single Agent. The main thread keeps the Game (cheap, synchronous)
   and talks to this worker via messages:

     { type:'new', gen, size, percept }  -> make a fresh Agent, observe the
                                            start cell, reply with a sweep
     { type:'act', gen, step }           -> run one time step (action + percept
                                            + scream + optional shot), reply
     { type:'resync', gen, mode }        -> re-sweep with no world change (used
                                            when switching INTO automatic: manual
                                            play withholds auto-inference, so the
                                            agent's determined cache may be stale
                                            for the policy — this catches it up
                                            before policyAction() runs), reply
     { type:'decide', gen }              -> read-only: "what would the policy do
                                            next?" replies { type:'decision',
                                            action, trace } (trace is the rule-by-
                                            rule pass/fail list, for the Decision
                                            Rules panel) — does NOT apply the
                                            action or advance the world
     { type:'ask', gen, query }          -> read-only: run one user-posed query
                                            against the current KB. No 'done'
                                            reply — just the single streamed
                                            'resolution' message (see below).

   Replies are tagged and STREAMED. As each query completes, the worker posts
   { gen, type:'resolution', view } so the solver panel fills in live; when the
   turn finishes it posts one { gen, type:'done', reveal, beliefs, snapshots }.
   (The reveal/beliefs/snapshots are only valid once the whole turn has run, so
   they ride the final message; the streamed views are the per-query traces.)
   The `gen` is echoed back so the main thread can ignore replies from a
   previous game (e.g. after "New map"). */

importScripts('logic.js');

let agent = null;
let curGen = 0;   // the gen of the turn currently running, for the streaming hook

self.onmessage = function (e) {
  const { type, gen, size, percept, step, query, mode } = e.data;
  curGen = gen;

  // A user-posed manual query: run the ask and stream its view (via the
  // onResolution hook, tagged userPosed) — but DON'T sweep or clear the turn's
  // ask list. It reads the KB without advancing the world, so there's no reveal
  // to recompute and no 'done' to post; the streamed 'resolution' is the reply.
  if (type === 'ask') {
    agent.query(query.pred, query.x, query.y, query.negated);
    return;
  }

  // Automatic mode: report the action the policy chooses from what's been proven.
  // Read-only — no world change here (the main thread owns the Game and applies
  // the action via a normal 'act'); we just answer "what would you do?".
  if (type === 'decide') {
    const { action, trace } = agent.policyAction();
    self.postMessage({ gen, type: 'decision', action, trace });
    return;
  }

  if (type === 'new') {
    agent = new WW.Agent(size);
    // Stream each query's trace as it completes (see Agent._ask). The hook is
    // set on the agent once; it tags every post with the live turn's gen.
    agent.onResolution = (view) => self.postMessage({ gen: curGen, type: 'resolution', view });
    agent.resolutions = [];
    agent.observe(percept);
  } else if (type === 'act') {
    agent.resolutions = [];           // start a fresh ask list for this turn
    agent.act(step);
  } else if (type === 'resync') {
    agent.resolutions = [];           // fresh ask list; falls through to the sweep below
  }

  // sweep() settles frontier facts (mutating the KB), so capture the display
  // snapshot AFTER it — the panel then matches the reveal shown on the grid.
  // Its queries also stream via the onResolution hook and accumulate on
  // agent.resolutions (the full list, included in the final message too).
  // In manual mode we withhold the automatic frontier inference (autoInfer:false)
  // — the user must prove hazards via the ASK panel — but still build the reveal.
  const reveal = agent.sweep({ autoInfer: mode !== 'manual' });
  agent.snapshot('current');
  self.postMessage({ gen, type: 'done', reveal, beliefs: agent.beliefs(), snapshots: agent.snapshots, resolutions: agent.resolutions });
};

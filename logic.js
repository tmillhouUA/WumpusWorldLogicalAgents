/* logic.js — the pedagogically interesting layer.

   Holds everything on the logic side: the game/world model, the KB agent,
   the propositional parser, the CNF converter, the resolution solver, and
   helper functions. Has NO dependency on the DOM, so it can be exercised
   on its own (see test.js).

   Public surface is exposed on the single global `WW` (think of it the way
   you use `d3`): ui.js and test.js call `WW.something(...)`. Functions that
   are purely internal to this file can stay as plain top-level functions and
   need not be added to WW. */


/* ======================================================================
   1. FORMULA AST
   ----------------------------------------------------------------------
   A propositional sentence is a tree of plain objects. Five node shapes:

     atom     { type:'atom',    name }
     not      { type:'not',     arg }
     and      { type:'and',     left, right }
     or       { type:'or',      left, right }
     implies  { type:'implies', left, right }
     iff      { type:'iff',     left, right }

   Atoms are opaque here: identity is just the `name` string (e.g.
   "Pit(2,2)"). We can enrich atoms later with structured predicate /
   location / time fields WITHOUT touching the converter or solver, since
   those treat an atom purely as an identity. The parser (built later) will
   produce exactly these nodes; for now the constructors below let tests and
   the agent build sentences directly.
   ====================================================================== */

function atom(name)        { return { type: 'atom',    name }; }
function not(arg)          { return { type: 'not',     arg }; }
function and(left, right)  { return { type: 'and',     left, right }; }
function or(left, right)   { return { type: 'or',      left, right }; }
function implies(l, r)     { return { type: 'implies', left: l, right: r }; }
function iff(l, r)         { return { type: 'iff',     left: l, right: r }; }

/* Fold a non-empty list into a left-nested conjunction / disjunction.
   Handy for building things like "Pit(1,2) ∨ Pit(2,1) ∨ Pit(2,3)". */
function ands(list) { return list.reduce((a, b) => and(a, b)); }
function ors(list)  { return list.reduce((a, b) => or(a, b)); }


/* ======================================================================
   2. PRETTY-PRINTING (readable, student-facing form)
   ----------------------------------------------------------------------
   Renders a formula with logic symbols, following three teaching rules for
   when parentheses may be dropped (everything else stays fully parenthesized
   per the grammar — we do NOT use operator precedence to drop parens):

     (i)   the outermost pair is dropped;
     (ii)  parens within a run of conjunctions are dropped (∧ is associative);
     (iii) parens within a run of disjunctions are dropped (∨ is associative).

   So a conjunction or disjunction sitting inside a DIFFERENT operator keeps
   its parens, e.g.  Breezy(1,1) ↔ (Pit(1,2) ∨ Pit(2,1)).

   Negation: no parens before an atom or another negation (¬A, ¬¬A), parens
   before a compound (¬(A ∧ B)). Implication and biconditional are not
   associative, so nested ones keep their parens: (A → B) → C.
   ====================================================================== */

const SYM = { not: '¬', and: '∧', or: '∨', implies: '→', iff: '↔' };

/* Render an operand of a binary node, adding parentheses unless the child is
   an atom/negation (self-delimiting) or continues the same associative chain
   (∧ inside ∧, or ∨ inside ∨). */
function renderOperand(child, parentOp) {
  if (child.type === 'atom') return child.name;
  if (child.type === 'not')  return renderNot(child);

  const sameAssocChain =
    child.type === parentOp && (parentOp === 'and' || parentOp === 'or');
  const inner = renderBinary(child);
  return sameAssocChain ? inner : '(' + inner + ')';
}

/* The "A op B" core of a binary node, without any surrounding parentheses. */
function renderBinary(n) {
  return renderOperand(n.left, n.type) + ' ' + SYM[n.type] + ' ' + renderOperand(n.right, n.type);
}

function renderNot(n) {
  const a = n.arg;
  if (a.type === 'atom') return '¬' + a.name;
  if (a.type === 'not')  return '¬' + renderNot(a);
  return '¬(' + renderBinary(a) + ')';
}

/* Top-level entry point: the outermost expression takes no surrounding parens. */
function formulaToString(n) {
  if (n.type === 'atom') return n.name;
  if (n.type === 'not')  return renderNot(n);
  return renderBinary(n);
}


/* ======================================================================
   3. CLAUSES (CNF form, solver-facing)
   ----------------------------------------------------------------------
   A literal is { atom: <name>, negated: <bool> }.
   A clause is  { literals: [ ...literals ] }, understood as their
   disjunction. The empty clause (no literals) represents falsehood and
   prints as □. Clauses are canonicalized: duplicate literals removed,
   literals sorted for a stable display/key, and tautological clauses
   (containing both X and ¬X) dropped, since they are always true.
   ====================================================================== */

/* Turn a literal node (atom or ¬atom) into a {atom, negated} literal.
   After NNF + distribution every leaf is one of these two shapes. */
function makeLiteral(node) {
  if (node.type === 'atom') return { atom: node.name, negated: false };
  if (node.type === 'not' && node.arg.type === 'atom') {
    return { atom: node.arg.name, negated: true };
  }
  throw new Error('Expected a literal, got: ' + formulaToString(node));
}

/* Canonicalize a list of literals into a clause, or return null if the
   clause is a tautology (and therefore droppable). */
function canonicalizeClause(literals) {
  const polarities = new Map();   // atom -> Set of negated-values seen
  const unique = new Map();       // literal key -> literal (dedupes)

  for (const lit of literals) {
    if (!polarities.has(lit.atom)) polarities.set(lit.atom, new Set());
    polarities.get(lit.atom).add(lit.negated);
    if (polarities.get(lit.atom).size === 2) return null; // X and ¬X -> tautology
    unique.set((lit.negated ? '!' : '') + lit.atom, lit);
  }

  const lits = [...unique.values()].sort((a, b) =>
    a.atom === b.atom ? (a.negated ? 1 : 0) - (b.negated ? 1 : 0)
                      : (a.atom < b.atom ? -1 : 1));
  return { literals: lits };
}

/* Stable string key for a clause (used to dedupe clause sets). */
function clauseKey(clause) {
  return clause.literals.map(l => (l.negated ? '!' : '') + l.atom).join('|');
}

function clauseToString(clause) {
  if (clause.literals.length === 0) return '□';
  return '(' + clause.literals.map(l => (l.negated ? '¬' : '') + l.atom).join(' ∨ ') + ')';
}


/* ======================================================================
   4. CNF CONVERSION  (with a step-by-step trace)
   ----------------------------------------------------------------------
   Standard four-pass algorithm (R&N §7.5.2), each pass a pure function
   formula -> formula so the trace can snapshot the whole sentence after
   each named rule:

     1. eliminate ↔   :  (α ↔ β)  ==>  (α → β) ∧ (β → α)
     2. eliminate →   :  (α → β)  ==>  (¬α ∨ β)
     3. move ¬ inward :  De Morgan + double-negation  (yields NNF)
     4. distribute ∨ over ∧

   Then read the clauses off the resulting conjunction of disjunctions.
   The trace is recorded at PASS granularity (one entry per rule that
   changes the sentence) — clean and textbook-aligned; we can add finer
   per-rewrite detail later if a lesson wants it.
   ====================================================================== */

function eliminateBiconditional(n) {
  switch (n.type) {
    case 'atom':    return n;
    case 'not':     return not(eliminateBiconditional(n.arg));
    case 'and':     return and(eliminateBiconditional(n.left), eliminateBiconditional(n.right));
    case 'or':      return or(eliminateBiconditional(n.left), eliminateBiconditional(n.right));
    case 'implies': return implies(eliminateBiconditional(n.left), eliminateBiconditional(n.right));
    case 'iff': {
      const a = eliminateBiconditional(n.left);
      const b = eliminateBiconditional(n.right);
      return and(implies(a, b), implies(b, a));
    }
  }
}

function eliminateImplication(n) {
  switch (n.type) {
    case 'atom':    return n;
    case 'not':     return not(eliminateImplication(n.arg));
    case 'and':     return and(eliminateImplication(n.left), eliminateImplication(n.right));
    case 'or':      return or(eliminateImplication(n.left), eliminateImplication(n.right));
    case 'implies': return or(not(eliminateImplication(n.left)), eliminateImplication(n.right));
    // 'iff' cannot appear: eliminated in the previous pass.
  }
}

/* Push negations inward until they sit only on atoms (negation normal form).
   At this point implications and biconditionals are already gone, so a
   negation's argument is an atom, a negation, an and, or an or. */
function moveNegationInward(n) {
  switch (n.type) {
    case 'atom': return n;
    case 'and':  return and(moveNegationInward(n.left), moveNegationInward(n.right));
    case 'or':   return or(moveNegationInward(n.left), moveNegationInward(n.right));
    case 'not': {
      const a = n.arg;
      switch (a.type) {
        case 'atom': return not(a);                                    // already a literal
        case 'not':  return moveNegationInward(a.arg);                 // ¬¬α ==> α
        case 'and':  return or(moveNegationInward(not(a.left)),        // ¬(α∧β) ==> ¬α ∨ ¬β
                               moveNegationInward(not(a.right)));
        case 'or':   return and(moveNegationInward(not(a.left)),       // ¬(α∨β) ==> ¬α ∧ ¬β
                                moveNegationInward(not(a.right)));
      }
    }
  }
}

/* Distribute ∨ over ∧ so the sentence becomes a conjunction of disjunctions.
   Re-distributes the results because a freshly built ∨ may expose more. */
function distribute(n) {
  switch (n.type) {
    case 'atom': return n;
    case 'not':  return n;   // a literal (negation sits on an atom by now)
    case 'and':  return and(distribute(n.left), distribute(n.right));
    case 'or': {
      const a = distribute(n.left);
      const b = distribute(n.right);
      if (a.type === 'and') return and(distribute(or(a.left, b)), distribute(or(a.right, b)));
      if (b.type === 'and') return and(distribute(or(a, b.left)), distribute(or(a, b.right)));
      return or(a, b);
    }
  }
}

/* Split a (post-distribution) sentence into its set of clauses. */
function flattenAnd(n) { return n.type === 'and' ? [...flattenAnd(n.left), ...flattenAnd(n.right)] : [n]; }
function flattenOr(n)  { return n.type === 'or'  ? [...flattenOr(n.left),  ...flattenOr(n.right)]  : [n]; }

function extractClauses(n) {
  const clauses = [];
  const seen = new Set();
  for (const conjunct of flattenAnd(n)) {
    const clause = canonicalizeClause(flattenOr(conjunct).map(makeLiteral));
    if (!clause) continue;                      // tautology dropped
    const key = clauseKey(clause);
    if (seen.has(key)) continue;                // duplicate clause dropped
    seen.add(key);
    clauses.push(clause);
  }
  return clauses;
}

/* Convert a formula to CNF. Returns { clauses, trace }.
     clauses : array of canonical clauses (the solver-facing form)
     trace   : array of { rule, before, after } readable snapshots, one per
               pass that actually changed the sentence. */
function toCNF(formula) {
  const trace = [];
  let f = formula;

  const step = (rule, next) => {
    const before = formulaToString(f);
    const after = formulaToString(next);
    if (before !== after) trace.push({ rule, before, after });
    f = next;
  };

  step('Eliminate ↔ (biconditional elimination)', eliminateBiconditional(f));
  step('Eliminate → (implication elimination)',   eliminateImplication(f));
  step('Move ¬ inward (De Morgan, double negation)', moveNegationInward(f));
  step('Distribute ∨ over ∧',                      distribute(f));

  return { clauses: extractClauses(f), trace };
}


/* ======================================================================
   5. KNOWLEDGE BASE
   ----------------------------------------------------------------------
   The KB is a list of ENTRIES, each pairing a readable sentence with the
   clauses it produced (and the conversion trace). Keeping them per-entry
   preserves provenance: a student can see which sentence spawned which
   clauses — the heart of the "propositional proliferation" lesson.

   CNF is a cached derivation of the sentence (computed once at tell-time),
   never edited independently, so the two forms cannot drift apart.
   ====================================================================== */

class KB {
  constructor() {
    this.entries = [];   // [{ sentence, text, clauses, trace }]
  }

  /* Add a sentence (an AST node). The optional `topic` tags the entry so the KB
     panel can group it (entries that look identical — e.g. a shoot-derived
     ¬Wumpus vs. a visited-cell ¬Wumpus — can't be told apart after the fact, so
     provenance is recorded here, at tell-time). The optional `anchor` ([x,y]) tags
     a location-anchored entry (a percept biconditional, anchored at the cell whose
     percept is on its LHS) so a per-query filter can admit it only for an allowed
     set of cells; unanchored entries (everything else) are always admitted. Stored
     as the [x,y] array for readability/highlighting; membership is tested by key.
     Returns the created entry. */
  tell(sentence, topic, anchor) {
    const { clauses, trace } = toCNF(sentence);
    const entry = { sentence, text: formulaToString(sentence), clauses, trace, topic, anchor };
    this.entries.push(entry);
    return entry;
  }

  /* Readable sentences, for the KB panel. */
  sentences() { return this.entries.map(e => e.text); }

  /* Flattened union of all clauses, for the solver. (May contain clauses
     that recur across entries; the solver can dedupe if it cares.) */
  clauses() { return this.entries.flatMap(e => e.clauses); }

  /* Like clauses(), but admitting an anchored entry only when its anchor cell is
     in `allowed` (a Set of "x,y" keys). Unanchored entries always pass. This is
     the epistemic per-query filter: it reproduces "only biconditionals the agent
     is entitled to" by selecting which anchors participate, independently of the
     topological component-separation filter the solver applies afterward. Passing
     `allowed = null/undefined` admits everything (today's full-KB behavior).
     Filters at the ENTRY level so a later view can highlight surviving entries. */
  clausesForAnchors(allowed) {
    if (!allowed) return this.clauses();
    return this.entries.flatMap(e =>
      (e.anchor && !allowed.has(e.anchor[0] + ',' + e.anchor[1])) ? [] : e.clauses);
  }

  /* Remove every entry for which pred(entry) is true. Used to retire stale
     time-indexed axioms once their fluents have been materialized forward. */
  retract(pred) { this.entries = this.entries.filter(e => !pred(e)); }

  /* Three-valued query that materializes its result. Runs `ask`; on a
     determinate answer it TELLs the fact (so knowledge accumulates and the
     reveal can read it), skipping it if already present to avoid bloat.
     Returns the ask result ({ result: 'YES'|'NO'|'UNKNOWN', ... }). */
  query(q) {
    const r = ask(this, q, { collectTrace: false });   // sweeps don't need traces
    if (r.result === 'YES' || r.result === 'NO') {
      const fact = r.result === 'YES' ? q : not(q);
      const key = clauseKey(toCNF(fact).clauses[0]);
      if (!this.clauses().some(c => clauseKey(c) === key)) this.tell(fact);
    }
    return r;
  }
}


/* ======================================================================
   6. RESOLUTION  (R&N Figure 7.12)
   ----------------------------------------------------------------------
   The textbook procedure, kept as close to the pseudocode as our clause
   representation allows:

     function PL-RESOLUTION(KB, α) returns true or false
       clauses ← the set of clauses in the CNF representation of KB ∧ ¬α
       new ← { }
       loop do
         for each pair of clauses C_i, C_j in clauses do
           resolvents ← PL-RESOLVE(C_i, C_j)
           if resolvents contains the empty clause then return true
           new ← new ∪ resolvents
         if new ⊆ clauses then return false
         clauses ← clauses ∪ new

   A `true` result means KB ∧ ¬α is unsatisfiable, i.e. KB ⊨ α. This is the
   faithful (inefficient) version: every pass re-resolves all pairs. Fine for
   the small Wumpus KBs we expect; we'll discover the limit empirically.
   ====================================================================== */

/* Small clause-set helpers, keyed by the canonical clauseKey. */
function dedupeClauses(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = clauseKey(c);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}
function unionClauses(a, b) { return dedupeClauses([...a, ...b]); }
function clausesSubsetOf(needles, haystack) {     // needles ⊆ haystack ?
  const keys = new Set(haystack.map(clauseKey));
  return needles.every(c => keys.has(clauseKey(c)));
}

/* Component separation: the subset of `clauses` transitively connected to a
   set of seed atoms through shared atoms. Sound for deciding entailment of a
   query whose atoms are the seeds, PROVIDED the KB is consistent — clauses in
   other connected components can't affect the result, so dropping them is
   safe and lets an unrelated query resolve trivially. */
function connectedClauses(clauses, seedAtoms) {
  const atoms = new Set(seedAtoms);
  const included = [];
  let remaining = clauses;
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const c of remaining) {
      if (c.literals.some(l => atoms.has(l.atom))) {
        included.push(c);
        for (const l of c.literals) atoms.add(l.atom);
        changed = true;
      } else {
        next.push(c);
      }
    }
    remaining = next;
  }
  return included;
}

/* Pure-literal elimination: drop every clause containing an atom that occurs
   with only ONE polarity across the whole clause set. Such an atom can never be
   resolved on (resolution needs a complementary pair), so its clauses can never
   contribute to deriving the empty clause — they are inert for refutation and
   safe to remove. This is the DPLL pure-symbol rule, sound here for the same
   reason: we are testing KB ∧ ¬query for unsatisfiability, and dropping clauses
   that can't participate in a refutation cannot change whether □ is derivable.

   Removing a clause can leave another atom pure (its only complementary
   occurrences were in the dropped clauses), so we iterate to a fixpoint. */
function pureLiteralElimination(clauses) {
  let current = clauses;
  while (true) {
    const pos = new Set();   // atoms seen non-negated
    const neg = new Set();   // atoms seen negated
    for (const c of current) {
      for (const l of c.literals) (l.negated ? neg : pos).add(l.atom);
    }
    // An atom is pure if it appears in exactly one of the two sets.
    const pure = new Set();
    for (const a of pos) if (!neg.has(a)) pure.add(a);
    for (const a of neg) if (!pos.has(a)) pure.add(a);
    if (pure.size === 0) return current;                  // fixpoint
    const next = current.filter(c => !c.literals.some(l => pure.has(l.atom)));
    if (next.length === current.length) return current;   // nothing dropped
    current = next;
  }
}

/* Unit subsumption: a unit clause {L} subsumes (makes redundant) every clause
   that also contains the literal L, since that clause is satisfied whenever {L}
   is — anything it could help derive, {L} derives at least as cheaply. Dropping
   subsumed clauses is sound for refutation (a deleted clause is never needed to
   reach □). We keep the unit subsumers themselves and remove only the longer
   clauses they subsume.

   This is the deletion half of unit handling. The complementary half — striking
   the literal ¬L out of clauses when {L} is known (unit resolution / clause
   simplification) — is NOT done here; it would shorten the breeze biconditionals
   rather than just remove whole clauses, and is a separate step.

   Restricted to unit subsumers (rather than general C ⊆ D) so the test is a
   cheap signed-literal membership check, no general subset comparison. The
   agent's settled facts are exactly units, so this is where the payoff is. */
function unitSubsumption(clauses) {
  // Index the literals carried by unit clauses, keyed by signed atom.
  const unitLits = new Set();
  for (const c of clauses) {
    if (c.literals.length === 1) {
      const l = c.literals[0];
      unitLits.add((l.negated ? '!' : '') + l.atom);
    }
  }
  if (unitLits.size === 0) return clauses;
  return clauses.filter(c => {
    if (c.literals.length === 1) return true;             // never drop a unit itself
    // Drop this clause if some unit subsumes one of its literals (same sign).
    return !c.literals.some(l => unitLits.has((l.negated ? '!' : '') + l.atom));
  });
}

/* PL-RESOLVE: the set of all clauses obtainable by resolving Ci and Cj —
   one resolvent per complementary pair of literals. Each resolvent is
   factored (duplicate literals removed by canonicalizeClause) and any
   tautological resolvent is discarded. The empty clause (no literals) is
   returned as a normal clause and signals a contradiction upstream. */
function plResolve(ci, cj) {
  const resolvents = [];
  const seen = new Set();
  for (const li of ci.literals) {
    for (const lj of cj.literals) {
      if (li.atom === lj.atom && li.negated !== lj.negated) {
        // Resolve on this complementary pair: drop both, union the rest.
        const merged = [
          ...ci.literals.filter(l => !(l.atom === li.atom && l.negated === li.negated)),
          ...cj.literals.filter(l => !(l.atom === lj.atom && l.negated === lj.negated)),
        ];
        const clause = canonicalizeClause(merged);   // factoring + tautology test
        if (!clause) continue;                        // tautology -> discard
        const key = clauseKey(clause);
        if (seen.has(key)) continue;
        seen.add(key);
        resolvents.push(clause);
      }
    }
  }
  return resolvents;
}

/* PL-RESOLUTION. Returns { entailed, trace, clauses }:
     entailed : true iff KB ⊨ query (empty clause derived)
     trace    : [{ ci, cj, resolvent, isNew, pass }] — one entry per resolvent
                produced, in order, for the step-by-step console panel.
                `pass` is the outer do-loop iteration (1-based) the resolvent
                was produced in — the natural "step" of the algorithm. Within
                a pass, the inner for-loop resolves every pair of the current
                clauses; between passes, the novel resolvents are folded into
                the clause set and another pass begins.
                `isNew` is false when the resolvent duplicates a clause that
                already existed at the start of this pass, or one produced
                earlier in the same pass — i.e. the redundant re-derivations
                the naive loop keeps generating. The panel can stream every
                entry in and then cross out / fade the isNew:false ones,
                leaving only the novel resolvents.
     clauses  : the full clause set at termination

   This is the incremental (level-saturation) refinement of Fig 7.12: rather
   than re-resolving EVERY pair each pass (which re-derives the same clauses
   over and over), each pass resolves only the newest set — the `frontier`, the
   clauses first derived in the previous pass — against itself and against every
   older clause. Pairs whose members are both older were already tried in an
   earlier pass, so they're skipped. This derives exactly the same clauses as
   Fig 7.12 (same entailment result) with far less work; it is NOT a search
   restriction like set-of-support (every resolution still happens, once).

   options (all optional):
     componentSeparation : default true — restrict to the query's connected
                           component (sound for a consistent KB; the big speed
                           win, since unrelated cells resolve trivially).
     budget              : default Infinity — max NOVEL resolvents before bailing
                           to "not proven" (sets `budgetExceeded`). Disabled for
                           now so we can watch a full saturation play out; pass a
                           finite budget to re-enable the backstop.
     collectTrace        : default true — record each step's NEW resolvents for
                           the solver panel (the culled view it displays). Only
                           new clauses are kept, so the trace is O(K), not the
                           O(K^2) of all attempts. Set false to skip it entirely
                           (the sweep doesn't need it).
     unitOnly            : default false — restrict to UNIT resolution (every step
                           has a unit parent). Sound but incomplete in general;
                           used for localization, where the answer is always
                           unit-derivable, so it settles fast without the full
                           saturation that the coupled SSA cluster would trigger.
     allowedAnchors      : default null — a Set of "x,y" keys; when given, only
                           location-anchored entries whose anchor is in the set
                           enter resolution (the epistemic filter). Unanchored
                           entries always participate. null admits the whole KB. */
function plResolution(kb, query, options = {}) {
  const { componentSeparation = true, pureLiteral = true, subsumption = true, budget = Infinity, collectTrace = true, unitOnly = false, allowedAnchors = null } = options;

  // clauses ← CNF of (KB ∧ ¬query), with the KB pre-filtered to the allowed
  // anchors (the epistemic filter) before the topological filters below.
  const negQuery = toCNF(not(query)).clauses;
  let initial = dedupeClauses([...kb.clausesForAnchors(allowedAnchors), ...negQuery]);
  if (componentSeparation) {
    const seed = negQuery.flatMap(c => c.literals.map(l => l.atom));
    initial = connectedClauses(initial, seed);
  }
  // Preprocessing snapshots, for the solver panel: the clause set as it stands
  // after each preprocessing stage, so a student can watch the input shrink
  // through the filters before resolution proper begins. Captured unconditionally
  // (each shows the set ENTERING the next stage), so a disabled filter simply
  // shows no change there. Only built when a trace is collected.
  const snap = (cs) => collectTrace ? cs.map(clauseToString) : null;
  const preprocessing = collectTrace ? {} : null;
  if (collectTrace) preprocessing.input = snap(initial);   // after anchor + component sep
  // Pure-literal elimination: drop clauses whose atoms can never be resolved on.
  // Sound (see pureLiteralElimination); shrinks the set fed to saturation.
  if (pureLiteral) initial = pureLiteralElimination(initial);
  if (collectTrace) preprocessing.pureSymbol = snap(initial);
  // Unit subsumption: drop longer clauses made redundant by a known unit fact.
  // Sound (see unitSubsumption); collapses clauses the settled facts subsume.
  if (subsumption) initial = unitSubsumption(initial);
  if (collectTrace) preprocessing.subsumption = snap(initial);
  // General-interest instrumentation (gated; default off): the connected-component
  // size actually fed to resolution — the main driver of saturation cost.
  if (plResolution.verbose) console.error(`[plRes] ${formulaToString(query)}  component=${initial.length}`);

  const knownKeys = new Set(initial.map(clauseKey));   // every clause derived so far
  let older = [];                 // clauses from before the frontier (all pairs among them tried)
  let frontier = initial;         // the newest set: this pass resolves FROM these
  const trace = [];
  let pass = 0;                   // outer loop iteration = a "step"
  let count = 0;                  // NEW resolvents produced (for the budget)

  // Empty-clause short-circuit. The empty clause can ONLY be produced by
  // resolving two complementary UNIT clauses ({L} and {¬L}) — any extra literal
  // would survive into the resolvent. So instead of waiting to resolve them in
  // the (dominating) final pass, we index every unit clause by its signed atom
  // and, the moment a unit's complement is already present, declare □ and stop.
  // At most 2·|atoms| units exist, so this is an O(1) check per new unit. It
  // short-circuits only the ENTAILED case; a non-entailed query still saturates
  // to fixpoint (absence of □ is known only when nothing new can be derived).
  const emptyClause = { literals: [] };
  const unitKey       = c => (c.literals[0].negated ? '!' : '') + c.literals[0].atom;
  const complementKey = c => (c.literals[0].negated ? ''  : '!') + c.literals[0].atom;
  const units = new Map();        // signed-atom key -> a unit clause holding that literal
  // Register a unit clause; if its complement is already known, return a
  // terminal entailed result (recording the □ step), else index it. null if c
  // is not a unit or no complement is found.
  const registerUnit = (c, atPass) => {
    if (c.literals.length !== 1) return null;
    const comp = units.get(complementKey(c));
    if (comp) {
      if (collectTrace) trace.push({ ci: comp, cj: c, resolvent: emptyClause, isNew: true, pass: atPass });
      return { entailed: true, trace, clauses: older.concat(frontier), preprocessing };
    }
    units.set(unitKey(c), c);
    return null;
  };

  // Seed the index from the initial clauses (the KB units + the negated query);
  // a complementary pair already present means the query is entailed outright.
  for (const c of initial) {
    const out = registerUnit(c, 0);
    if (out) return out;
  }

  while (frontier.length > 0) {
    pass++;
    const newThisPass = [];       // the "truly new" resolvents of this step

    // Resolve one pair; record it; return a terminal result object or null.
    const resolvePair = (ci, cj) => {
      // Unit resolution: only resolve when at least one parent is a unit clause.
      // This rides forward unit-propagation chains to □ without ever doing the
      // non-unit × non-unit cross-product that makes full saturation explode.
      // Sound but incomplete in general (complete only for the unit-derivable
      // fragment) — used where the answer is known to be unit-provable.
      if (unitOnly && ci.literals.length > 1 && cj.literals.length > 1) return null;
      for (const r of plResolve(ci, cj)) {
        if (r.literals.length === 0) {              // empty clause -> KB ⊨ query
          if (collectTrace) trace.push({ ci, cj, resolvent: r, isNew: true, pass });
          return { entailed: true, trace, clauses: older.concat(frontier), preprocessing };
        }
        const key = clauseKey(r);
        const isNew = !knownKeys.has(key);
        // Only the panel's culled view is ever shown, so record only NEW
        // resolvents. Collecting the discarded (non-new) attempts too would
        // grow the trace to O(K^2) and OOM on large saturations.
        if (collectTrace && isNew) trace.push({ ci, cj, resolvent: r, isNew, pass });
        if (isNew) {
          knownKeys.add(key);
          newThisPass.push(r);
          // If this new clause is a unit and completes a complementary pair,
          // □ is derivable now — stop before the rest of the saturation runs.
          const unitOut = registerUnit(r, pass);
          if (unitOut) return unitOut;
          if (++count > budget) {                   // backstop: bail to "not proven"
            return { entailed: false, trace, clauses: older.concat(frontier), budgetExceeded: true, preprocessing };
          }
        }
      }
      return null;
    };

    // (i) frontier × frontier (each unordered pair once)...
    for (let i = 0; i < frontier.length; i++) {
      for (let j = i + 1; j < frontier.length; j++) {
        const out = resolvePair(frontier[i], frontier[j]);
        if (out) return out;
      }
    }
    // (ii) ...and frontier × older (old × old pairs were already done).
    for (const f of frontier) {
      for (const o of older) {
        const out = resolvePair(f, o);
        if (out) return out;
      }
    }

    older = older.concat(frontier);   // the frontier joins the "already-paired" set
    frontier = newThisPass;           // next pass resolves from this step's new clauses
  }
  return { entailed: false, trace, clauses: older, preprocessing };   // fixpoint, no new clauses -> KB ⊭ query
}

/* ask: the three-valued entailment query we settled on (NOT part of R&N).
   Failing to prove danger is not a proof of safety, so we run resolution
   twice. Returns { result: 'YES' | 'NO' | 'UNKNOWN', ... } with the
   underlying proof object(s) attached for display.
     YES     : KB ⊨ query
     NO      : KB ⊨ ¬query
     UNKNOWN : neither is entailed */
function ask(kb, query, options) {
  const positive = plResolution(kb, query, options);
  if (positive.entailed) return { result: 'YES', positive };

  const negative = plResolution(kb, not(query), options);
  if (negative.entailed) return { result: 'NO', negative };

  return { result: 'UNKNOWN', positive, negative };
}


/* ======================================================================
   7. GAME  (the world: ground truth + mechanics)
   ----------------------------------------------------------------------
   The hidden world and its transition function — a plain simulation. It
   holds the truth and NEVER consults the KB to decide what is true; the
   agent learns about the world only through the percepts act() returns.
   (The fog/reveal display, built later, reads the agent's KB, not this.)

   Coordinates: (col, row), 1-indexed, (1,1) bottom-left.
   North = +row, South = −row, East = +col, West = −col.
   ====================================================================== */

/* Tiny seedable PRNG (mulberry32) so maps are reproducible in tests.
   Pass a seed for determinism; omit to use Math.random. */
function makeRng(seed) {
  if (seed === undefined) return Math.random;
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOVE = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };

class Game {
  constructor(opts = {}) {
    this.size = opts.size || 5;
    this.pitProb = opts.pitProb != null ? opts.pitProb : 0.2;
    // Reward structure (R&N-style defaults); kept in one place to tweak.
    this.score = Object.assign(
      { step: -1, arrow: -10, gold: 1000, death: -1000 }, opts.score || {});
    this.rng = makeRng(opts.seed);
    this.maxRetries = opts.maxRetries || 1000;
    this.generate();
  }

  // ---- grid helpers ----------------------------------------------------
  key(x, y) { return x + ',' + y; }
  inBounds(x, y) { return x >= 1 && x <= this.size && y >= 1 && y <= this.size; }
  neighbors(x, y) {
    return Object.values(MOVE)
      .map(([dx, dy]) => [x + dx, y + dy])
      .filter(([nx, ny]) => this.inBounds(nx, ny));
  }

  // ---- generation ------------------------------------------------------
  /* Random map that is SOLVABLE (a pit-free path exists from (1,1) to the
     gold), but not necessarily inferentially solvable. The Wumpus may block
     the only pit-free route, forcing arrow use — which is allowed since one
     Wumpus + one arrow + a pit-free path is always winnable. */
  generate() {
    const n = this.size;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      // Pits: independent per cell, never at the entrance (1,1).
      const pits = new Set();
      for (let x = 1; x <= n; x++) {
        for (let y = 1; y <= n; y++) {
          if (x === 1 && y === 1) continue;
          if (this.rng() < this.pitProb) pits.add(this.key(x, y));
        }
      }
      // Candidates for Wumpus / gold: not the entrance, not a pit.
      const free = [];
      for (let x = 1; x <= n; x++) {
        for (let y = 1; y <= n; y++) {
          if ((x === 1 && y === 1) || pits.has(this.key(x, y))) continue;
          free.push([x, y]);
        }
      }
      if (free.length === 0) continue;

      const wumpus = free[Math.floor(this.rng() * free.length)];
      const gold = this._weightedPick(free);   // biased away from (1,1)

      // Reject a breeze or stench at the entrance: in automatic mode the
      // agent starts there with no prior evidence, so a percept at (1,1)
      // makes the map trivially unsolvable by inference alone (a pit/Wumpus
      // is provably adjacent before a single cell has been explored).
      const entranceBreezy = this.neighbors(1, 1).some(([nx, ny]) => pits.has(this.key(nx, ny)));
      const entranceStenchy = this.neighbors(1, 1).some(([nx, ny]) => nx === wumpus[0] && ny === wumpus[1]);
      if (entranceBreezy || entranceStenchy) continue;

      if (this._pitFreePath(pits, gold)) {     // solvable?
        this.pits = pits;
        this.wumpus = wumpus;
        this.gold = gold;
        this._reset();
        return;
      }
    }
    // Fallback (e.g. pitProb too high to ever solve): a trivially safe map.
    this.setWorld({ pits: [], wumpus: [n, n], gold: [n, n] });
  }

  /* Pick a cell with probability proportional to its Manhattan distance from
     (1,1), biasing the gold deep into the map. */
  _weightedPick(cells) {
    const weights = cells.map(([x, y]) => (x - 1) + (y - 1));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return cells[Math.floor(this.rng() * cells.length)];
    let r = this.rng() * total;
    for (let i = 0; i < cells.length; i++) {
      r -= weights[i];
      if (r <= 0) return cells[i];
    }
    return cells[cells.length - 1];
  }

  /* BFS over non-pit cells (Wumpus ignored) from (1,1) to target. */
  _pitFreePath(pits, target) {
    const seen = new Set([this.key(1, 1)]);
    const queue = [[1, 1]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if (x === target[0] && y === target[1]) return true;
      for (const [nx, ny] of this.neighbors(x, y)) {
        const k = this.key(nx, ny);
        if (seen.has(k) || pits.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return false;
  }

  /* Install a specific world (arrays of [x,y]) and reset state. Handy for
     tests and for loading hand-built maps later. */
  setWorld({ pits = [], wumpus, gold }) {
    this.pits = new Set(pits.map(([x, y]) => this.key(x, y)));
    this.wumpus = wumpus;
    this.gold = gold;
    this._reset();
  }

  _reset() {
    this.state = {
      location: [1, 1],
      hasArrow: true,
      wumpusAlive: true,
      hasGold: false,
      alive: true,
      done: false,
      outcome: null,    // 'dead' | 'win' | 'left'
      time: 0,
      points: 0,
    };
  }

  // ---- percepts (located, static square properties) -------------------
  breezyAt(x, y)  { return this.neighbors(x, y).some(([nx, ny]) => this.pits.has(this.key(nx, ny))); }
  stenchyAt(x, y) { return this.neighbors(x, y).some(([nx, ny]) => nx === this.wumpus[0] && ny === this.wumpus[1]); }
  glitterAt(x, y) { return !this.state.hasGold && x === this.gold[0] && y === this.gold[1]; }

  /* The located percepts for the current room. (Glitter and Scream are the
     dynamic ones; Breezy/Stenchy are static square properties.) */
  percepts() {
    const [x, y] = this.state.location;
    return { x, y, breezy: this.breezyAt(x, y), stenchy: this.stenchyAt(x, y), glitter: this.glitterAt(x, y) };
  }

  // ---- transition ------------------------------------------------------
  /* Apply an action and return an outcome record (action, time, location,
     whether a move happened, the current-room percepts, scream, and terminal
     info). Actions: MoveN/S/E/W, ShootN/S/E/W, Grab, Climb. */
  act(action) {
    const s = this.state;
    if (s.done) return this._outcome(action, false, false);

    s.time++;
    s.points += this.score.step;
    let moved = false;
    let scream = false;

    if (action.startsWith('Move')) {
      const [dx, dy] = MOVE[action.slice(4)];
      const nx = s.location[0] + dx;
      const ny = s.location[1] + dy;
      if (this.inBounds(nx, ny)) {                 // off-board move = no-op
        s.location = [nx, ny];
        moved = true;
        const k = this.key(nx, ny);
        const onWumpus = s.wumpusAlive && nx === this.wumpus[0] && ny === this.wumpus[1];
        if (this.pits.has(k) || onWumpus) {
          s.alive = false; s.done = true; s.outcome = 'dead';
          s.points += this.score.death;
        }
      }
    } else if (action.startsWith('Shoot')) {
      if (s.hasArrow) {
        s.hasArrow = false;
        s.points += this.score.arrow;
        const [dx, dy] = MOVE[action.slice(5)];
        let [cx, cy] = s.location;
        while (true) {
          cx += dx; cy += dy;
          if (!this.inBounds(cx, cy)) break;
          if (s.wumpusAlive && cx === this.wumpus[0] && cy === this.wumpus[1]) {
            s.wumpusAlive = false; scream = true; break;
          }
        }
      }
    } else if (action === 'Grab') {
      if (this.glitterAt(s.location[0], s.location[1])) s.hasGold = true;
    } else if (action === 'Climb') {
      if (s.location[0] === 1 && s.location[1] === 1) {
        s.done = true;
        if (s.hasGold) { s.outcome = 'win'; s.points += this.score.gold; }
        else s.outcome = 'left';
      }
    }

    return this._outcome(action, moved, scream);
  }

  _outcome(action, moved, scream) {
    const s = this.state;
    return {
      action,
      time: s.time,
      location: [...s.location],
      moved,
      percepts: this.percepts(),
      scream,
      alive: s.alive,
      done: s.done,
      outcome: s.outcome,
      points: s.points,
    };
  }
}


/* ======================================================================
   8. AGENT  (holds the KB; reasons about the world)
   ----------------------------------------------------------------------
   The agent is the only thing that "knows." It learns through percepts and
   reasons with resolution. This first version handles the STATIC map
   inference (pits / Wumpus / gold); SSA self-localization is a later step.

   The agent never touches the Game: the caller hands it a plain percept object
   via observe(percept). Interim shortcut (to be replaced by SSA): that percept
   is located and the agent TELLs visited-cell safety, rather than inferring its
   own position. The static inference below is unaffected.

   Deliberate simplification: we do NOT assert "exactly one Wumpus" (the full
   at-least-one / at-most-one cardinality axioms, O(size^2) pairwise clauses).
   Those are faithful to R&N but blow up naive resolution and would force a
   set-of-support refinement. Dropping them keeps the algorithm the book's
   plain PL-RESOLUTION. In their place, _populateWumpusTriangulation() asserts
   a cheap, sound shortcut standing in for at-most-one: if two of a cell's
   neighbours are both stenchy, the Wumpus is at that cell (only one Wumpus
   really exists, so two independently-stenchy neighbours can only be jointly
   explained by it sitting at their common neighbour). That plus the ¬Wumpus
   safety inference covers most positive-location and all safety queries; we
   only lose location-by-GLOBAL-elimination (every other cell independently
   ruled out via cues that never form a two-neighbour stench pair) and the
   "safe everywhere once pinned" inference (those residual cases read
   UNKNOWN).

   Added lazily as cells are visited (perception-scoped grounding):
     - the percept facts for the cell (Breezy/Stenchy/Gold, ±)
     - the cell's safety (¬Pit, ¬Wumpus — survived)
     - the cell's biconditionals  Breezy ⇔ ⋁ neighbour pits,
                                   Stenchy ⇔ ⋁ neighbour Wumpus

   Phase A adds a small TEMPORAL layer: a time counter, the action taken each
   step (as time-indexed atoms), and successor-state axioms for HaveArrow and
   WumpusAlive (the latter driven by the Scream observation). These atoms form
   their own connected component, disjoint from the static pit/Wumpus map, so
   component separation keeps them out of the location sweep. (Location SSA +
   self-localization, and the L-dependent fluents Glitter/HaveGold, are Phase B.)
   ====================================================================== */

/* The agent's action vocabulary (asserted time-indexed, e.g. MoveE(3)). */
const ACTIONS = ['MoveN', 'MoveS', 'MoveE', 'MoveW', 'ShootN', 'ShootS', 'ShootE', 'ShootW', 'Grab', 'Climb'];

class Agent {
  constructor(size) {
    this.size = size;
    this.kb = new KB();
    this.visited = new Set();
    this.breezyCells = new Set();    // visited cells where a breeze was sensed
    this.stenchyCells = new Set();   // visited cells where a stench was sensed
    this.determined = {};            // cache of settled static facts: name -> 'YES'|'NO'
    this.snapshots = {};             // label -> a captured kbView(), for the KB panel
    this.resolutions = [];           // every ask this turn, each a stepped trace, for the solver panel
    // (No full "exactly one Wumpus" cardinality axioms — see the note above;
    // _populateBiconditionals() below asserts the cheaper triangulation
    // shortcut in their place.)

    // Temporal layer: initial conditions at t = 0. We also track each fluent's
    // current value so the next step's proof starts from a materialized fact
    // (one SSA step) rather than re-deriving the whole chain.
    this.t = 0;
    this.arrowVal = true;
    this.aliveVal = true;
    this.haveGoldVal = false;        // believed carrying-gold state (a fluent, settled each step)
    this.goldHereVal = false;        // believed "gold is in my current cell" (a fluent, settled each step)
    this.locVal = [1, 1];            // believed cell — INFERRED each step by _localize; also the
                                     // anchor for next step's SSA grounding (no dead-reckoning from percepts)
    this.kb.tell(this.arrowAtom(0), 'arrow');
    this.kb.tell(this.aliveAtom(0), 'alive');
    this.kb.tell(not(this.haveGoldAtom(0)), 'gold');   // initial condition: the agent starts empty-handed
    this.kb.tell(this.locAtom(1, 1, 0), 'locations');   // initial condition: the agent starts at (1,1)
    this.kb.tell(not(this.bumpAtom(0)), 'percept');    // initial condition: no wall bump before any move
    // The static percept biconditionals for EVERY cell (location-agnostic), gated
    // per query by the anchor filter rather than by where the agent has been.
    this._populateBiconditionals();
    // The starting cell is taken in by the caller via observe(percept).
  }

  /* Assert, for every cell on the board, the two static percept biconditionals
       Breezy(x,y) ⇔ ⋁ neighbour pits        (anchor (x,y))
       Stenchy(x,y) ⇔ ⋁ neighbour Wumpus      (anchor (x,y))
     These are the structural axioms relating a square's percept to its neighbours'
     hazards. They are location-AGNOSTIC: populated once, for all cells, and
     persistent (untimed, so never retired). WHICH of them participates in a given
     query is decided per query by the anchor filter (allowedAnchors) — the agent's
     own queries pass `visited`, reproducing the old per-visit scoping; a user can
     pass a wider set to ask about a cell never stood in. The anchor tags the cell
     whose percept is the biconditional's LHS. */
  _populateBiconditionals() {
    for (let x = 1; x <= this.size; x++) {
      for (let y = 1; y <= this.size; y++) {
        const nb = this.neighbors(x, y);
        this.kb.tell(iff(this.brz(x, y), ors(nb.map(([nx, ny]) => this.pit(nx, ny)))), 'pit', [x, y]);
        this.kb.tell(iff(this.stc(x, y), ors(nb.map(([nx, ny]) => this.wmp(nx, ny)))), 'wumpus', [x, y]);
      }
    }
    this._populateWumpusTriangulation();
  }

  /* Shortcut rule standing in for the dropped cardinality axioms (see the
     class-level note above): for every DIAGONAL pair of cells (x1,y1)-(x2,y2)
     (i.e. the two cells share exactly two common neighbours — the OTHER two
     corners of the same 2x2 block), if both are stenchy, the Wumpus is at ONE
     of those two shared neighbours A or B —
       (Stenchy(x1,y1) ^ Stenchy(x2,y2)) => Wumpus(A) v Wumpus(B)
     e.g. stench at (2,1) and (1,2) => Wumpus(1,1) v Wumpus(2,2).

     NOT a unique-cell conclusion: an earlier version of this rule wrongly
     concluded a single cell (treating A and B as if only one were possible),
     which is unsound — either corner independently explains both stenches, so
     the correct axiom is a DISJUNCTION, collapsing to a definite location only
     once ordinary resolution rules out one disjunct (e.g. the agent visits A
     safely, so ¬Wumpus(A) is a separate known fact, and resolving it against
     this clause yields Wumpus(B) for free — no extra rule needed for that
     step). Sound because there is really only ever one Wumpus: two
     independently-stenchy diagonal cells can only be jointly explained by a
     Wumpus at one of their two shared corners. This is O(size) clauses (one
     per diagonal pair), well under the O(size^2) at-most-one cardinality
     axioms whose resolution cost was the reason cardinality was dropped.

     ANCHORING: anchored to BOTH premise cells (x1,y1) and (x2,y2), NOT to A/B
     — A/B are exactly the cells this rule exists to help decide, and are
     typically UNVISITED at decide-time, so anchoring there would make
     _decide's `allowedAnchors: visited` filter exclude the clause for the one
     case it's needed (a no-op in practice). Telling it twice, once per premise
     anchor, admits it once EITHER premise cell is visited; it can only
     actually resolve to something once BOTH Stenchy facts are known, which
     itself requires having visited both (Stenchy is a raw percept, never
     inferred) — so admitting it early is harmless. */
  _populateWumpusTriangulation() {
    for (let x = 1; x <= this.size; x++) {
      for (let y = 1; y <= this.size; y++) {
        // Only look at the diagonal neighbour to the NE and SE of (x,y), so
        // each unordered diagonal pair in the grid is visited exactly once.
        for (const [dx, dy] of [[1, 1], [1, -1]]) {
          const x2 = x + dx, y2 = y + dy;
          if (!this.inBounds(x2, y2)) continue;
          // The two cells shared between (x,y) and (x2,y2)'s neighbourhoods —
          // the other two corners of their common 2x2 block.
          const shared = this.neighbors(x, y).filter(([nx, ny]) =>
            this.neighbors(x2, y2).some(([mx, my]) => mx === nx && my === ny));
          if (shared.length !== 2) continue;   // off the edge: fewer than 2 shared corners
          const [[ax, ay], [bx, by]] = shared;
          const rule = implies(ands([this.stc(x, y), this.stc(x2, y2)]), ors([this.wmp(ax, ay), this.wmp(bx, by)]));
          this.kb.tell(rule, 'wumpus', [x, y]);
          this.kb.tell(rule, 'wumpus', [x2, y2]);
        }
      }
    }
  }

  // Grid geometry — the agent knows the board shape (built-in world knowledge).
  key(x, y) { return x + ',' + y; }
  inBounds(x, y) { return x >= 1 && x <= this.size && y >= 1 && y <= this.size; }
  neighbors(x, y) {
    return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      .filter(([nx, ny]) => this.inBounds(nx, ny));
  }

  // Atom builders (the agent's vocabulary).
  pit(x, y) { return atom(`Pit(${x},${y})`); }
  wmp(x, y) { return atom(`Wumpus(${x},${y})`); }
  brz(x, y) { return atom(`Breezy(${x},${y})`); }
  stc(x, y) { return atom(`Stenchy(${x},${y})`); }
  // Temporal (fluent) atom builders.
  arrowAtom(t)        { return atom(`HaveArrow(${t})`); }
  aliveAtom(t)        { return atom(`WumpusAlive(${t})`); }
  screamAtom(t)       { return atom(`Scream(${t})`); }
  bumpAtom(t)         { return atom(`Bump(${t})`); }   // locationless wall-bump percept
  glitterAtom(t)      { return atom(`Glitter(${t})`); }      // locationless gold-sense percept
  goldAtom(x, y, t)   { return atom(`Gold(${x},${y},${t})`); }   // gold present at (x,y) at t (fluent)
  haveGoldAtom(t)     { return atom(`HaveGold(${t})`); }    // agent is carrying gold (fluent)
  firedAtom(t)        { return atom(`Fired(${t})`); }
  locAtom(x, y, t)    { return atom(`L(${x},${y},${t})`); }   // "the agent is at (x,y) at time t"
  actionAtom(name, t) { return atom(`${name}(${t})`); }

  /* Ingest one cell's STATIC percepts (first visit only). The caller passes a
     plain percept object { x, y, breezy, stenchy, glitter, alive }; the agent
     never touches the Game. Only the static square properties (Breezy/Stenchy)
     are handled here. Glitter is a timed, locationless percept (like Bump/Scream)
     and is processed in act() against the believed current cell, not here. */
  observe(p) {
    if (!p.alive) return;                  // dead agents learn nothing
    // NOTE: p.x,p.y label the STATIC world facts below (Breezy(x,y) etc.) with the
    // world's true coordinates. These are untimed, so they cannot drive the timed
    // localization inference — using true coords here is not a localization cheat.
    // The agent's BELIEF about where it is (locVal) comes only from _localize.
    const key = this.key(p.x, p.y);
    if (this.visited.has(key)) return;
    this.visited.add(key);

    const { x, y } = p;
    // Survived => this cell is safe.
    this.kb.tell(not(this.pit(x, y)), 'pit');
    this.kb.tell(not(this.wmp(x, y)), 'wumpus');
    // Percept facts (static square properties), positive or negative.
    this.kb.tell(p.breezy  ? this.brz(x, y) : not(this.brz(x, y)), 'percept');
    this.kb.tell(p.stenchy ? this.stc(x, y) : not(this.stc(x, y)), 'percept');
    // Remember where evidence was sensed, to gate which queries are worth posing.
    if (p.breezy)  this.breezyCells.add(key);
    if (p.stenchy) this.stenchyCells.add(key);
    // The percept biconditionals are NOT asserted here anymore: they are populated
    // globally (for every cell) once at construction, and gated per query by the
    // anchor filter (see _populateBiconditionals). observe() now contributes only
    // the situated EVIDENCE (safety + sensed percepts) for the visited cell.
  }

  /* One time step. The agent is told the action it took, the resulting percept,
     and whether a scream was heard. It records the action, advances the
     successor-state axioms (HaveArrow, WumpusAlive), infers its new cell, observes
     the new cell, and folds in any shot deduction.
     step = { action, percept, scream, bump, shot|null }. */
  act(step) {
    // Clear the PREVIOUS step's transient scaffolding first, then build this
    // step's on top — so when act() returns, the KB holds exactly the latest
    // step's actions and SSAs (visible in the KB panel) plus the carried-forward
    // facts. Retiring here (this.t still = t) drops time < t, which keeps the
    // time-t materialized facts the new SSA proofs depend on.
    this._retireStaleSteps();

    const t = this.t;

    // The action taken at t (and the others, not taken).
    for (const name of ACTIONS) {
      this.kb.tell(name === step.action ? this.actionAtom(name, t) : not(this.actionAtom(name, t)), 'action');
    }

    // A single "fired this step" fact. R&N's Shoot is one action; we split it
    // into four directions only for NSEW, so as a 4-way disjunction in the arrow
    // SSA it would blow up saturation — collapse it back to one atom here.
    this.kb.tell(step.action.startsWith('Shoot') ? this.firedAtom(t) : not(this.firedAtom(t)), 'arrow');

    // Successor-state axioms, t -> t+1:
    //   keep the arrow unless a shot was fired,
    this.kb.tell(iff(this.arrowAtom(t + 1), and(this.arrowAtom(t), not(this.firedAtom(t)))), 'arrow');
    //   the Wumpus stays alive unless a scream is heard (the kill signal).
    this.kb.tell(iff(this.aliveAtom(t + 1), and(this.aliveAtom(t), not(this.screamAtom(t + 1)))), 'alive');

    // The scream observation at t+1 (the bridge's input).
    this.kb.tell(step.scream ? this.screamAtom(t + 1) : not(this.screamAtom(t + 1)), 'alive');

    // The Bump percept (locationless, timed): a Move that produced no movement is
    // a wall bump. This is the feedback that makes localization a genuine question.
    this.kb.tell(step.bump ? this.bumpAtom(t + 1) : not(this.bumpAtom(t + 1)), 'percept');

    this.t = t + 1;

    // Prove and materialize the new fluent values. The proof is the entailed
    // direction (guided by the previous value), so it's a single SSA step from
    // a materialized fact — short, and never the saturating non-entailed side.
    this.arrowVal = this._settle(this.arrowAtom(this.t), this.arrowVal && !step.action.startsWith('Shoot'), 'arrow');
    this.aliveVal = this._settle(this.aliveAtom(this.t), this.aliveVal && !step.scream, 'alive');

    // Genuine self-localization (see _localize and locationSSA). The agent does
    // NOT read its coordinates from the percept; it infers its cell from the prior
    // belief, the action it took, and the Bump percept.
    const priorCell = this.locVal;        // believed cell BEFORE this step (where a Grab would act)
    this.locVal = this._localize(step, t);

    this.observe(step.percept);           // static percept facts for the new cell
    this._settleGold(step, t, priorCell);  // glitter -> gold, grab -> HaveGold (after localization)
    if (step.shot) this.shoot(step.shot);  // locational deduction from a fired arrow
  }

  /* Retire time-indexed axioms strictly older than the current time t. Called
     at the START of each step: it clears the prior step's actions/SSAs (their
     fluents have been carried forward as materialized facts at time t, kept
     here) so the temporal component stays bounded, while leaving this step's
     own scaffolding to be built afterward and shown in the KB panel.
     (Static, location-indexed atoms like Pit(2,3) are written X(col,row) — two
     numbers — so they never match this single-index pattern and are kept.) */
  _retireStaleSteps() {
    const t = this.t;
    // The time index of a time-indexed temporal atom, or null for a static one.
    // Two shapes carry a time: single-index atoms (HaveArrow(4), MoveE(3)) hold
    // it as the sole argument; the spatio-temporal fluents L(x,y,t)/Gold(x,y,t)
    // hold it as the THIRD argument after two coordinates. Static, purely
    // location-indexed atoms (Pit(2,3) — two numbers) match neither and return
    // null, so they are kept. (L(x,y,t) facts are topic 'locations' and exempt
    // below; matching them here only affects the location-SSA conditionals,
    // which should retire by time anyway.)
    const staleTime = (name) => {
      const xyt = name.match(/^\w+\((\d+),(\d+),(\d+)\)$/);
      if (xyt) return Number(xyt[3]);
      const m = name.match(/^\w+\((\d+)\)$/);
      return m ? Number(m[1]) : null;
    };
    const isPositiveFact = (e) =>
      e.clauses.every((c) => c.literals.every((l) => !l.negated));
    this.kb.retract((e) => {
      // Persistent records survive retirement: the believed locations and the
      // positive actions taken (the action history) feed later practical
      // reasoning. Both are isolated unit facts, so keeping them costs
      // resolution nothing. (Negated action atoms are NOT facts in this sense
      // and fall through to the time-based check, so they're cleaned each move.)
      if (e.topic === 'locations') return false;
      if (e.topic === 'action' && isPositiveFact(e)) return false;
      return e.clauses.some((c) => c.literals.some((l) => {
        const ti = staleTime(l.atom);
        return ti !== null && ti < t;
      }));
    });
  }

  /* Run one entailment query, recording its stepped trace for the solver panel
     (every ask this turn is kept; the panel shows them one at a time). Returns
     the raw plResolution result. */
  _ask(goal, { unitOnly = false, allowedAnchors = null, userPosed = false, deriveFact = null } = {}) {
    const r = plResolution(this.kb, goal, { collectTrace: true, unitOnly, allowedAnchors });
    const view = this._resolutionView(goal, r, unitOnly, userPosed);
    // Attach any per-query rider (e.g. the map fact a user query establishes)
    // BEFORE firing the stream hook, so the streamed view carries it.
    if (deriveFact) view.fact = deriveFact(r);
    this.resolutions.push(view);
    // Optional streaming hook: lets the worker emit each query's trace as it
    // completes, so the solver panel fills in live rather than all at once at
    // the end of the turn. Unset (e.g. in Node tests) = no-op, no behaviour
    // change; resolutions are still collected on this.resolutions either way.
    if (this.onResolution) this.onResolution(view);
    return r;
  }

  /* A user-posed query about one static cell property. `pred` is 'pit' |
     'wumpus' | 'breezy' | 'stenchy'; (x,y) the cell; `negated` asks ¬. An
     inference is an inference regardless of who poses it — this runs the same
     _ask as the agent — but the anchor set is visited ∪ {queried cell} (the
     user may ask about an unvisited cell, and its own biconditional is admitted
     so triangulation proofs like Breezy(2,3) can go through), and the view is
     tagged userPosed so the panel can distinguish it. Returns the result.
     No KB mutation: user queries read the KB, they don't teach it. */
  query(pred, x, y, negated = false) {
    const build = { pit: this.pit, wumpus: this.wmp, breezy: this.brz, stenchy: this.stc }[pred];
    if (!build) throw new Error('unknown query predicate: ' + pred);
    const goal = negated ? not(build.call(this, x, y)) : build.call(this, x, y);
    const anchors = new Set(this.visited);
    anchors.add(this.key(x, y));
    // Translate the proof outcome into a persistent map fact. A PROVED query
    // fixes the cell's value in that polarity (YES if we proved the atom, NO if
    // we proved its negation); a FAILED proof means UNKNOWN, so we record
    // nothing (value: null) — "not entailed" is not the same as "proven false".
    // The streamed view carries this (see _ask) so the main thread can update
    // the map, the durable record of what the user's queries established.
    const deriveFact = (r) => ({ pred, x, y, value: r.entailed ? (negated ? 'NO' : 'YES') : null });
    return this._ask(goal, { allowedAnchors: anchors, userPosed: true, deriveFact });
  }

  /* Shape one ask's trace for display: the query, the outcome, and the steps
     (outer-loop passes) each carrying only that pass's NEW resolvents (the
     cull), as proof lines. An empty resolvent (□) flags its two inputs. */
  _resolutionView(goal, r, unitOnly = false, userPosed = false) {
    const byStep = new Map();
    for (const e of r.trace) {
      if (!e.isNew) continue;
      if (!byStep.has(e.pass)) byStep.set(e.pass, []);
      byStep.get(e.pass).push({
        resolvent: clauseToString(e.resolvent),
        ci: clauseToString(e.ci),
        cj: clauseToString(e.cj),
        empty: e.resolvent.literals.length === 0,
      });
    }
    const steps = [...byStep.entries()].sort((a, b) => a[0] - b[0])
      .map(([step, resolvents]) => ({ step, resolvents }));
    return {
      query: formulaToString(goal),
      result: r.entailed ? 'entailed — □ found' : 'not entailed',
      unitOnly,                                  // ran under unit resolution? (labels the steps)
      userPosed,                                 // asked by the user (vs. the agent) — the panel tints these
      preprocessing: r.preprocessing || null,   // clause sets after each filter stage
      steps,
    };
  }

  /* Prove a fluent's expected value via the SSA and materialize it as a fact.
     Returns the value (true/false) if proved, else undefined. `unitOnly` runs
     the proof under unit resolution — used for the gold fluents, whose SSAs
     share L/Grab atoms with the location cluster and so merge into one large
     component that full resolution saturates; the single-unit-belief invariant
     makes them unit-derivable (see _localize and the no-positional-uncertainty
     design), so the unit proof is both fast and reliable. */
  _settle(atom, expected, topic, { unitOnly = false } = {}) {
    const goal = expected ? atom : not(atom);
    if (this._ask(goal, { unitOnly }).entailed) {
      this.kb.tell(goal, topic);
      return expected;
    }
    return undefined;
  }

  /* The genuine, Bump-governed successor-state axiom for cell (x,y), t -> t+1 —
     a biconditional (Reiter's form), and the form R&N actually use:

       L(x,y,t+1) ⟺ [ ⋁ arrived: was at a neighbor and moved INTO (x,y) ]
                   ∨ [ L(x,y,t) ∧ ( Bump(t+1) ∨ took no move ) ]

     The arrival disjuncts are the positive effects (a move between two real cells
     never bumps, so they need no Bump term). The second disjunct is the frame
     term: you persist iff you didn't successfully leave — i.e. you took no move
     at all, OR you took a move that bumped. Crucially, whether a move SUCCEEDS is
     governed by the Bump PERCEPT, not by board geometry — inBounds is used only
     to enumerate which neighbor cells exist (which arrivals are possible), never
     to predict an outcome. That is what makes localization a genuine inference
     rather than dead-reckoning. */
  locationSSA(x, y, t) {
    const arrivals = [];   // came from a real neighbor by moving into (x,y)
    for (const dir of ['N', 'S', 'E', 'W']) {
      const [dx, dy] = MOVE[dir];
      const sx = x - dx, sy = y - dy;                 // source cell for an arrival via Move<dir>
      if (this.inBounds(sx, sy)) arrivals.push(and(this.locAtom(sx, sy, t), this.actionAtom('Move' + dir, t)));
    }
    // Took no move = none of the four Move actions was the action this step.
    const noMove = ands(['N', 'S', 'E', 'W'].map((d) => not(this.actionAtom('Move' + d, t))));
    const stayPut = and(this.locAtom(x, y, t), or(this.bumpAtom(t + 1), noMove));
    return iff(this.locAtom(x, y, t + 1), ors([...arrivals, stayPut]));
  }

  /* Infer the agent's new cell at t+1 from the prior belief, the action, and the
     Bump percept — no dead-reckoning. Asserts the full bump-governed SSAs grounded
     around the believed prior cell, then proves the new cell against them.

     There are at most two candidate cells: the prior cell (stayed) and, for a move
     into the board, the neighbor moved toward. Exactly one is entailed; the Bump
     percept (asserted in act) decides which. Both candidates are settled by UNIT
     resolution against the full KB: the proof of the true cell is always a unit
     chain (single-unit prior belief — see the no-positional-uncertainty design),
     so it derives □ fast without the cross-product that detonates full saturation,
     and a "not entailed" answer reliably rejects the other candidate.
     Returns the believed [x,y], or undefined if nothing is provable. */
  _localize(step, t) {
    if (!this.locVal) return undefined;          // lost track; can't ground (shouldn't happen)
    const [px, py] = this.locVal;                // believed PRIOR cell (anchor)
    const tNext = t + 1;

    // Assert the proper (full, bump-governed) SSAs: prior cell + its real
    // neighbours — the KB artifacts for this step, and what we query against.
    for (const [x, y] of [[px, py], ...this.neighbors(px, py)]) {
      this.kb.tell(this.locationSSA(x, y, t), 'location');
    }

    // Candidate cells: the moved-to neighbour (only if the move targets a real
    // cell — inBounds bounds the candidates to existing cells, not the outcome)
    // and the prior cell. Take the first that unit resolution entails.
    const candidates = [];
    if (step.action.startsWith('Move')) {
      const [dx, dy] = MOVE[step.action.slice(4)];
      if (this.inBounds(px + dx, py + dy)) candidates.push([px + dx, py + dy]);
    }
    candidates.push([px, py]);                   // staying is always possible

    for (const [x, y] of candidates) {
      const goal = this.locAtom(x, y, tNext);
      if (this._ask(goal, { unitOnly: true }).entailed) {
        this.kb.tell(goal, 'locations');
        return [x, y];
      }
    }
    return undefined;
  }

  /* Infer gold facts for the step t -> t+1, after localization has fixed the
     believed cells. Three pieces, in order:

       1. Glitter sensor at the NEW cell. Glitter(t+1) is a timed, locationless
          percept (like Bump). The agent senses it AT its current cell, so the
          perception-scoped biconditional grounds it there:
              Glitter(t+1) ⟺ Gold(cx,cy,t+1)
          (the L(cx,cy,t+1) conjunct is redundant given the unit location fact,
          so it's folded out for a smaller clause). This settles whether gold is
          in the new cell now — both directions: glitter proves gold here, no
          glitter proves no gold here.

       2. Gold frame SSA at the PRIOR cell. Gold persists unless grabbed from
          that cell this step:
              Gold(px,py,t+1) ⟺ Gold(px,py,t) ∧ ¬( Grab(t) ∧ L(px,py,t) )
          This axiom is ASSERTED (so the frame reasoning is visible in the KB
          panel) but NOT queried: gold at a cell the agent has left is inert —
          the agent only ever acts on gold in its CURRENT cell (piece 1) and on
          whether it is carrying gold (piece 3). HaveGold's acquisition term uses
          Gold(px,py,t) — the value carried from when (px,py) WAS current — not
          this t+1 frame fact, so nothing consumes Gold(px,py,t+1). We therefore
          skip the settle to avoid a query whose answer no one reads.

       3. HaveGold acquisition SSA. Once carried, always carried; acquired by
          grabbing on a gold cell (scoped to the prior cell, the only live
          disjunct given the unit location fact):
              HaveGold(t+1) ⟺ HaveGold(t) ∨ ( Grab(t) ∧ Gold(px,py,t) )

     The QUERIED fluents (current-cell gold, HaveGold) are proved by _settle
     against the SSA (uniform with arrow/alive), so every acted-on belief is
     inferred, not bookkept. All gold queries run under unit resolution: the
     gold SSAs share L/Grab atoms with the location cluster, so component
     separation can't isolate them and full resolution would saturate; the
     single-unit-belief invariant makes them unit-derivable (see _localize). */
  _settleGold(step, t, priorCell) {
    const tNext = t + 1;
    const grabbed = step.action === 'Grab';
    const priorGold = this.goldHereVal;       // believed Gold(px,py,t) carried from last step

    // (2) Gold frame SSA at the prior cell — asserted for display, not queried
    //     (gold at a departed cell is inert; see the method doc).
    if (priorCell) {
      const [px, py] = priorCell;
      this.kb.tell(
        iff(this.goldAtom(px, py, tNext),
            and(this.goldAtom(px, py, t),
                not(and(this.actionAtom('Grab', t), this.locAtom(px, py, t))))),
        'gold');
    }

    // (1) Glitter sensor at the new cell, then settle whether gold is here now.
    let goldHere = false;
    if (this.locVal) {
      const [cx, cy] = this.locVal;
      const glit = !!step.percept.glitter;
      this.kb.tell(glit ? this.glitterAtom(tNext) : not(this.glitterAtom(tNext)), 'gold');
      this.kb.tell(iff(this.glitterAtom(tNext), this.goldAtom(cx, cy, tNext)), 'gold');
      goldHere = this._settle(this.goldAtom(cx, cy, tNext), glit, 'gold', { unitOnly: true }) === true;
    }
    this.goldHereVal = goldHere;               // carried as Gold(current cell, t+1) for next step

    // (3) HaveGold acquisition SSA. We only assert + settle it when there's
    //     something to prove: a grab was ATTEMPTED this step (it might acquire
    //     gold), OR we already believe we're carrying it (then keep re-proving
    //     it forward at the current time, so a later check — e.g. "only Climb
    //     with the gold" — can resolve HaveGold(now) rather than a retired,
    //     stale-time fact). With no grab and no gold yet, the acquisition
    //     disjunct is dead and HaveGold just stays false — nothing to query.
    if (grabbed || this.haveGoldVal) {
      const acquire = grabbed && priorGold;    // grabbed on a cell that had gold
      const willHave = this.haveGoldVal || acquire;
      const acquireTerm = priorCell
        ? and(this.actionAtom('Grab', t), this.goldAtom(priorCell[0], priorCell[1], t))
        : null;
      this.kb.tell(
        iff(this.haveGoldAtom(tNext),
            acquireTerm ? or(this.haveGoldAtom(t), acquireTerm) : this.haveGoldAtom(t)),
        'gold');
      this.haveGoldVal = this._settle(this.haveGoldAtom(tNext), willHave, 'gold', { unitOnly: true });
    }
  }

  /* The agent's current beliefs about its time-indexed fluents (for display),
     read from the values materialized each step. 'YES' | 'NO' | 'UNKNOWN'. */
  beliefs() {
    const fmt = (v) => v === undefined ? 'UNKNOWN' : (v ? 'YES' : 'NO');
    const loc = this.locVal ? `(${this.locVal[0]},${this.locVal[1]})` : 'UNKNOWN';
    return { arrow: fmt(this.arrowVal), wumpusAlive: fmt(this.aliveVal), location: loc, hasGold: fmt(this.haveGoldVal) };
  }

  /* The KB grouped into topical sections for the KB panel, each a list of
     rendered formulas (formulaToString output). The SECTION order runs
     percept/static facts first, then Actions, then everything that depends on
     the actions taken (the SSA families) — anything action-dependent sits below
     Actions. WITHIN a section, entries are sorted newest-time-first; static
     (non-time-indexed) entries keep their insertion order at the bottom.
     `key` is the topic tag; `title` is the section heading. */
  kbView() {
    const sections = [
      { key: 'percept',  title: 'Percepts' },
      { key: 'pit',      title: 'Pits & Breezes' },
      { key: 'wumpus',   title: 'Wumpus & Stench' },
      { key: 'action',   title: 'Actions' },
      { key: 'locations', title: 'Locations' },
      { key: 'location', title: 'Location SSAs' },
      { key: 'arrow',    title: 'Arrow SSAs' },
      { key: 'alive',    title: 'Aliveness SSAs' },
      { key: 'gold',     title: 'Gold & Glitter' },
    ];
    // The most recent time an entry references (max over its atoms), or null
    // when it is static. L(x,y,t) holds the time third; other temporal atoms
    // (HaveArrow(4), MoveE(3)) hold it as the sole index.
    const entryTime = (e) => {
      let max = null;
      for (const c of e.clauses) for (const l of c.literals) {
        const lm = l.atom.match(/^\w+\((\d+),(\d+),(\d+)\)$/);   // L(x,y,t) or Gold(x,y,t)
        const sm = lm ? null : l.atom.match(/^\w+\((\d+)\)$/);
        const ti = lm ? Number(lm[3]) : (sm ? Number(sm[1]) : null);
        if (ti !== null && (max === null || ti > max)) max = ti;
      }
      return max;
    };
    const sortKey = (e) => { const ti = entryTime(e); return ti === null ? -Infinity : ti; };

    const byTopic = {};
    for (const s of sections) byTopic[s.key] = [];
    const other = [];
    for (const e of this.kb.entries) {
      (byTopic[e.topic] || other).push(e);
    }
    // Stable sort (V8) keeps same-time entries in insertion order.
    const ordered = (entries) => entries.slice().sort((a, b) => sortKey(b) - sortKey(a)).map((e) => e.text);
    const view = sections.map((s) => ({ key: s.key, title: s.title, formulas: ordered(byTopic[s.key]) }));
    if (other.length) view.push({ key: 'other', title: 'Other', formulas: ordered(other) });
    return view;
  }

  /* Capture the current grouped KB under `label`, for the KB panel to display.
     This separates WHAT the agent stores (mutated by act/sweep) from WHAT is
     shown: the panel renders snapshots, and the moment a snapshot is taken
     determines its content (e.g. a start-of-step capture is "forward-looking",
     an end-of-step capture "backward-looking"). kbView() returns a fresh
     structure of plain strings, so storing the reference is a safe capture. */
  snapshot(label) {
    this.snapshots[label] = this.kbView();
  }

  /* Restricted sweep — a stand-in for user-guided querying. First it settles
     any newly-decidable frontier facts, asking only what's worth asking:
       (i)  the cell is unvisited and adjacent to a visited cell (the frontier);
       (ii) both pit and Wumpus are decided for every such cell — _decide runs a
            single cheap query each and returns NO (a breeze/stench-free visited
            neighbour ENTAILS absence — the safe case), YES (positive evidence
            triangulates presence), or UNKNOWN (left open until evidence grows).
     (Gold has no remote evidence; it's learned by glitter on visiting.)
     NB: the frontier alone is the gate — we must decide the SAFE case (which
     needs no positive percept), so we can't restrict to cells whose neighbours
     sensed a breeze/stench, or an indicator-free start would settle nothing and
     the agent would think it had no safe move.
     Then it returns the reveal built from EVERY settled fact (query- or shot-
     derived), so known cells stay revealed across moves.

     `autoInfer` (default true) runs the frontier _decide inference. In MANUAL
     mode the caller passes false: the agent stops proving hazards FOR the user,
     since those are exactly the facts the user can establish via the ASK panel.
     The reveal is still built either way, so anything settled by OTHER means
     (the user's own asks, or a no-scream shot's ¬Wumpus ray deduction) keeps
     showing — Manual withholds only the automatic frontier inference, not the
     display of facts that do get proven.
     Returns a map key -> { pit?, wumpus? } of 'YES' | 'NO'. */
  sweep({ autoInfer = true } = {}) {
    if (autoInfer) {
      for (let x = 1; x <= this.size; x++) {
        for (let y = 1; y <= this.size; y++) {
          const key = this.key(x, y);
          if (this.visited.has(key)) continue;                     // (i) unvisited
          const vNbrs = this.neighbors(x, y).filter(([nx, ny]) => this.visited.has(this.key(nx, ny)));
          if (vNbrs.length === 0) continue;                        // (i) adjacent to a visited cell

          this._decide(this.pit(x, y), vNbrs, this.breezyCells, 'pit');    // (ii) safe/present/unknown
          this._decide(this.wmp(x, y), vNbrs, this.stenchyCells, 'wumpus');
        }
      }
    }

    // Reveal = all settled (YES/NO) facts, parsed back to cell + kind.
    const reveal = {};
    for (const name in this.determined) {
      const m = name.match(/^(Pit|Wumpus)\((\d+),(\d+)\)$/);
      if (!m) continue;
      const kind = m[1] === 'Pit' ? 'pit' : 'wumpus';
      const k = m[2] + ',' + m[3];
      (reveal[k] || (reveal[k] = {}))[kind] = this.determined[name];
    }
    return reveal;
  }

  /* Decide one property of one cell as cheaply as possible, running at most a
     single resolution:
       (a) if it's already settled, return the cached answer — no query;
       (b) if a visited neighbour LACKS the indicator percept, absence is
           entailed, so confirm NO with the cheap ¬atom query (and skip the
           saturating "is it present?" query);
       (c) otherwise absence cannot be entailed, so only ask presence — YES if
           proved (a short proof), else UNKNOWN.
     Settled YES/NO answers are cached (the map is static) and TOLD to the KB
     so they help other queries. UNKNOWN is left open to revisit as evidence
     grows. `indicatorCells` is breezyCells (for pits) or stenchyCells (Wumpus). */
  _decide(atom, vNbrs, indicatorCells, topic) {
    const name = formulaToString(atom);
    if (this.determined[name]) return this.determined[name];        // (a) skip known

    // The agent reasons only from cells it has stood in: restrict the biconditionals
    // to visited anchors. The frontier cell being decided is unvisited, and its own
    // biconditional is never needed — both the safety (b) and triangulation (c)
    // proofs route through VISITED neighbours' biconditionals — so `visited` is the
    // right set, and it reproduces the pre-globalization per-visit scoping exactly.
    const anchors = this.visited;

    const hasSafetyEvidence = vNbrs.some(([nx, ny]) => !indicatorCells.has(this.key(nx, ny)));

    if (hasSafetyEvidence) {                                        // (b) absence is entailed -> NO
      if (this._ask(not(atom), { allowedAnchors: anchors }).entailed) {
        this.kb.tell(not(atom), topic);
        return (this.determined[name] = 'NO');
      }
      return 'UNKNOWN';                                             // (shouldn't happen for a consistent KB)
    }

    if (this._ask(atom, { allowedAnchors: anchors }).entailed) {    // (c) presence only
      this.kb.tell(atom, topic);
      return (this.determined[name] = 'YES');
    }
    return 'UNKNOWN';
  }

  /* Locational deduction from firing the arrow (piece 1; aliveness — the
     "Wumpus is now dead" fact — is the separate SSA layer, settled in act() as
     aliveVal). Given the firing cell, direction, and whether a scream was heard:
       - scream:    the Wumpus is DEAD. We do NOT touch the static Wumpus(x,y)
                    map — deadness is the WumpusAlive fluent's business, and a
                    corpse's location is still wherever it was. Instead, once the
                    Wumpus is dead the wumpus dimension is simply dropped from the
                    safety test (see _isSafe), so stench no longer blocks anything.
       - no scream: the Wumpus is not on the ray, so ¬Wumpus for every ray cell
                    (a genuine location fact — the live Wumpus isn't on those cells).
     `shot` = { x, y, dir, scream }. Caller invokes this only when an arrow was
     actually fired. */
  shoot(shot) {
    if (shot.scream) return;                       // deadness handled by the aliveness fluent, not the map
    const ray = this._ray(shot.x, shot.y, shot.dir);
    if (ray.length === 0) return;
    for (const [cx, cy] of ray) {
      if (this.visited.has(this.key(cx, cy))) continue;               // already known safe
      this.kb.tell(not(this.wmp(cx, cy)), 'alive');
      this.determined[formulaToString(this.wmp(cx, cy))] = 'NO';
    }
  }

  /* Cells from (x,y) outward in a cardinal direction to the board edge
     (excluding the origin) — the arrow's path. */
  _ray(x, y, dir) {
    const [dx, dy] = MOVE[dir];
    const cells = [];
    let cx = x + dx, cy = y + dy;
    while (this.inBounds(cx, cy)) { cells.push([cx, cy]); cx += dx; cy += dy; }
    return cells;
  }

  // ---- automatic-mode policy -------------------------------------------

  /* A cell is SAFE iff the agent has PROVEN it hazard-free (or has stood in it —
     surviving a visit proves it). UNKNOWN is not safe: the agent never gambles.
     Two hazards, handled separately:
       - Pit: always must be proven absent (¬Pit).
       - Wumpus: matters ONLY while the Wumpus is believed alive. Once the agent
         has proven it dead (aliveVal === false, from the Scream via the aliveness
         SSA), the wumpus dimension drops out of the safety test entirely — a dead
         Wumpus threatens no cell, so ¬Wumpus need not be proven anywhere. While
         alive, ¬Wumpus must normally be proven per-cell — EXCEPT once the Wumpus
         has been PINNED to a specific cell (_wumpusCell()): since there is only
         ever one Wumpus, every OTHER cell is then ¬Wumpus by pure logic, even if
         the resolution engine never separately proved that specific cell (sweep()
         only queries the unvisited FRONTIER, so a firing position beyond it can
         sit un-queried forever without this shortcut — the agent would then never
         find a route to shoot a Wumpus it has already located).
     This keeps deadness in the fluent layer (not the static Wumpus map) while
     still letting a kill unblock stench-guarded cells. */
  _isSafe(x, y) {
    const k = this.key(x, y);
    if (this.visited.has(k)) return true;
    if (this.determined[formulaToString(this.pit(x, y))] !== 'NO') return false;   // pit not ruled out
    if (this.aliveVal === false) return true;                                      // Wumpus dead => wumpus is moot
    if (this.determined[formulaToString(this.wmp(x, y))] === 'NO') return true;    // ¬Wumpus directly proven
    const w = this._wumpusCell();
    if (w && !(w[0] === x && w[1] === y)) return true;                             // Wumpus pinned elsewhere => here is safe
    return false;
  }

  /* Whether the Wumpus has been PROVEN to sit at a specific cell (the sweep's
     branch (c) caches this as 'YES' when stench observations triangulate). */
  _wumpusCell() {
    for (const name in this.determined) {
      if (this.determined[name] !== 'YES') continue;
      const m = name.match(/^Wumpus\((\d+),(\d+)\)$/);
      if (m) return [Number(m[1]), Number(m[2])];
    }
    return null;
  }

  /* BFS over the SAFE-cell graph (orthogonal steps between safe cells) from the
     agent's current cell. Neighbours are expanded in canonical N,E,S,W order, so
     the first goal reached is the nearest and ties break deterministically.
     `isGoal(x,y)` marks target cells (which need not themselves be safe — e.g. we
     path TO a firing position, which is safe, but the goal test is generic).
     Returns the DIRECTION ('N'|'E'|'S'|'W') of the first step along the shortest
     path to the nearest goal, or null if no goal is reachable through safe cells.
     A goal AT the current cell returns null (caller handles "already there"). */
  _safeStep(isGoal) {
    const [sx, sy] = this.locVal;
    const DIRS = ['N', 'E', 'S', 'W'];              // canonical tie-break order
    const start = this.key(sx, sy);
    // Each queue entry carries the FIRST step taken to reach it, so on hitting a
    // goal we can report that first move without reconstructing the path.
    const queue = [[sx, sy, null]];
    const seen = new Set([start]);
    while (queue.length) {
      const [x, y, firstDir] = queue.shift();
      if (firstDir !== null && isGoal(x, y)) return firstDir;   // nearest goal (not the start)
      for (const dir of DIRS) {
        const [dx, dy] = MOVE[dir];
        const nx = x + dx, ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const nk = this.key(nx, ny);
        if (seen.has(nk) || !this._isSafe(nx, ny)) continue;    // only walk safe cells
        seen.add(nk);
        queue.push([nx, ny, firstDir === null ? dir : firstDir]);
      }
    }
    return null;
  }

  /* Choose the agent's next action in AUTOMATIC mode from what it has PROVEN
     (this reads settled facts; the per-turn sweep has already done the inference).
     The rules are checked top to bottom and the whole tree is re-evaluated after
     each action. Returns an action string (see ACTIONS) or null if none applies.

     The behavioural policy (for students):
       1.  In the gold room                                   -> Grab.
       2.  At (1,1) and carrying the gold                     -> Climb.
       3.  Carrying the gold but not at (1,1)                 -> step (BFS) toward
                                                                 (1,1) — get the
                                                                 gold home first.
       4.  Wumpus proven, arrow in hand, and standing on a
           safe firing position on its row/column            -> Shoot at it.
       5.  Wumpus proven, arrow in hand, a safe firing
           position reachable through safe cells             -> step (BFS) toward
                                                                 the nearest one.
       6.  An ADJACENT unvisited safe cell exists            -> move onto it
                                                                 (first in N,E,S,W).
       7.  An unvisited safe cell exists but none adjacent    -> step (BFS) toward
                                                                 the nearest one.
       8.  No unvisited safe cells and not at (1,1)           -> step (BFS) toward (1,1).
       9.  At (1,1) with no unvisited safe cells             -> Climb (give up).

     Rules 4/5 are a two-phase "act if in position, else navigate toward it"
     pair: rule 4/5 fires every turn the Wumpus is proven and the arrow is in
     hand — including once exploration has widened the safe set enough to
     reach a firing position that wasn't reachable earlier — so the agent
     always finishes off a known Wumpus before it gives up (8/9); see
     _isSafe's Wumpus-pinned shortcut, which is what makes a firing position
     beyond the explored frontier provably safe once the Wumpus's own cell is
     known. The agent is SOUND: it steps only onto proven-safe cells and
     shoots only a spent-if-wrong last arrow, so it never dies — it may,
     however, fail to reach gold that has no provably safe path, and climb
     out instead.

     A prior version had two more rules (a last-ditch speculative shot at an
     unresolved neighbour of a sensed-stenchy cell, once exploration ran out
     but before giving up). Removed: verified empirically (3000+ simulated
     games, varied pit density) that their guard — arrow still in hand AND a
     stench sensed, at the point rule 7 fails — never actually holds. Rules
     4/5 are eager enough (firing the instant the Wumpus is proven, every
     turn, before rule 6/7 even runs) that whenever a stench is sensed and
     the arrow gets used, the Wumpus is already provably dead by the time
     exploration could run out; the only remaining stench-sensed games end
     in a win with the arrow never needed. So the speculative-shot guard was
     dead code, not just rare.

     TODO (possible future switch): a "risky" agent variant that will also
     explore/act on cells NOT proven safe (accepting real death risk) could
     revisit this — an agent willing to gamble might still want a
     speculative shot even without full proof. The current SOUND agent
     deliberately never does that. */
  /* Returns { action, trace }. `trace` is one entry per numbered rule above,
     IN ORDER, for the Decision Rules panel: { rule, label, matched, action? }.
     Every rule this call actually reached gets an entry (matched:false until
     the one that fires, which gets matched:true and its action); rules after
     the match are never reached and are simply absent from the trace — the
     panel treats "absent" as "not yet checked", not as a fourth state. */
  policyAction() {
    const trace = [];
    const record = (rule, label, matched, action) => {
      trace.push({ rule, label, matched, action });
      return matched;
    };
    const [cx, cy] = this.locVal;

    // 1. Grab gold in the current room.
    if (record(1, 'Grab gold in the current room', this.goldHereVal, 'Grab')) {
      return { action: 'Grab', trace };
    }

    // 2. Climb out from the entrance once carrying gold.
    const climbHome = cx === 1 && cy === 1 && this.haveGoldVal;
    if (record(2, 'At (1,1) carrying gold: climb out', climbHome, 'Climb')) {
      return { action: 'Climb', trace };
    }

    // 3. Carrying the gold but not home yet -> head for (1,1) first.
    if (this.haveGoldVal) {
      const home = this._safeStep((x, y) => x === 1 && y === 1);
      if (record(3, 'Carrying gold, not home: step toward (1,1)', !!home, home && 'Move' + home)) {
        return { action: 'Move' + home, trace };
      }
    } else {
      record(3, 'Carrying gold, not home: step toward (1,1)', false);
    }

    // 4 & 5. Deliberate shot at a PROVEN Wumpus (needs the arrow).
    const w = this._wumpusCell();
    if (w && this.arrowVal) {
      const [wx, wy] = w;
      // A firing position: a safe cell sharing the Wumpus's row or column (from
      // there a single cardinal shot's ray reaches it).
      const isFiringPos = (x, y) =>
        this._isSafe(x, y) && ((x === wx && y !== wy) || (y === wy && x !== wx));
      // 4. Already on a firing position -> shoot toward the Wumpus.
      const onFiringPos = isFiringPos(cx, cy);
      if (onFiringPos) {
        const dir = cx === wx ? (wy > cy ? 'N' : 'S') : (wx > cx ? 'E' : 'W');
        record(4, 'On a firing position for the proven Wumpus: shoot', true, 'Shoot' + dir);
        return { action: 'Shoot' + dir, trace };
      }
      record(4, 'On a firing position for the proven Wumpus: shoot', false);
      // 5. Otherwise walk to the nearest reachable firing position.
      const step = this._safeStep(isFiringPos);
      if (record(5, 'Wumpus proven: step toward a firing position', !!step, step && 'Move' + step)) {
        return { action: 'Move' + step, trace };
      }
    } else {
      record(4, 'On a firing position for the proven Wumpus: shoot', false);
      record(5, 'Wumpus proven: step toward a firing position', false);
    }

    // 6. Step onto an adjacent unvisited safe cell (first in canonical order).
    let adjDir = null;
    for (const dir of ['N', 'E', 'S', 'W']) {
      const [dx, dy] = MOVE[dir];
      const nx = cx + dx, ny = cy + dy;
      if (this.inBounds(nx, ny) && !this.visited.has(this.key(nx, ny)) && this._isSafe(nx, ny)) {
        adjDir = dir;
        break;
      }
    }
    if (record(6, 'An adjacent unvisited safe cell exists: step onto it', !!adjDir, adjDir && 'Move' + adjDir)) {
      return { action: 'Move' + adjDir, trace };
    }

    // 7. A non-adjacent unvisited safe cell exists -> BFS toward the nearest.
    const unvisitedSafe = (x, y) => !this.visited.has(this.key(x, y)) && this._isSafe(x, y);
    const towardFrontier = this._safeStep(unvisitedSafe);
    if (record(7, 'An unvisited safe cell exists: step toward it', !!towardFrontier, towardFrontier && 'Move' + towardFrontier)) {
      return { action: 'Move' + towardFrontier, trace };
    }

    // 8. Nothing left to explore and not home -> head back to (1,1).
    const notHome = !(cx === 1 && cy === 1);
    if (notHome) {
      const home = this._safeStep((x, y) => x === 1 && y === 1);
      if (record(8, 'Nothing left to explore, not home: step toward (1,1)', !!home, home && 'Move' + home)) {
        return { action: 'Move' + home, trace };
      }
    } else {
      record(8, 'Nothing left to explore, not home: step toward (1,1)', false);
    }

    // 9. Home, out of options -> climb out empty-handed (or with gold if held).
    record(9, 'Nothing left to do: climb out', true, 'Climb');
    return { action: 'Climb', trace };
  }
}


/* ======================================================================
   PUBLIC SURFACE
   ====================================================================== */

const WW = {
  // AST constructors
  atom, not, and, or, implies, iff, ands, ors,
  // rendering
  formulaToString, clauseToString,
  // conversion + knowledge base
  toCNF, KB,
  // resolution
  plResolve, plResolution, ask,
  // game world + agent
  Game, Agent,
};

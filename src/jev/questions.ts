/**
 * The fixed question set sent to Jev, one call per sleeve per tick.
 *
 * Two sources of constraint, and both are load-bearing.
 *
 * jev-1.13's DOCUMENTED failure modes
 * (https://docs.typesafe.ai/model-jaggedness/jev-1.13):
 *
 *  - "It struggles with tasks that require numeric precision" and is "not a
 *    calculator"  -> no question asks it to compare, count or rank numbers.
 *    Every magnitude question is already bucketed in features/compute.ts, and
 *    every numeric threshold is enforced in risk/gates.ts, in code.
 *  - "It can be quite literal in its understanding" / answers "the question you
 *    wrote, not the one you meant" -> each instruction states the exact
 *    condition, and each criteria entry describes what that option covers
 *    WITHOUT relying on negation of another option. The vendor explicitly warns
 *    that double negatives degrade accuracy.
 *  - "Math using score" -> a Score is compared against a threshold in code and
 *    never interpolated between levels.
 *  - "Answer the question you wrote" -> one atomic decision per question. No
 *    question bundles two judgments, and within a rubric each level turns on
 *    ONE fact.
 *
 * arXiv:2609.29429 ("Just Ask Jev", 2026-09-24):
 *
 *  The paper varies what Jev is asked against what it SEES and finds the
 *  fields of the input carry the label, not the question wording. Two
 *  consequences, both applied here:
 *
 *  1. A criterion must not quote the state that should produce it. An example
 *     like "order book imbalance says buy_heavy and 5 minute momentum says up"
 *     hands over the answer as a lookup table: the model can pattern-match the
 *     state string instead of judging it. Every criterion below says what its
 *     option MEANS, and none of them names a bucket value.
 *  2. Not-for lines that are only the negation of a sibling option are gone,
 *     for the same reason plus the vendor's double-negative warning.
 *
 * 3. Only `choice` probabilities are thresholdable. A `noul` is an absolute
 *    probability, not a distribution over options, and the vendor's own worked
 *     example shows a threshold does not transfer between the two. The desk
 *     therefore has no noul: `direction` and `action` are the only quantities
 *    the gates compare against a number, and they compare a Choice's
 *    `probabilities`. `confidence` stays a SEPARATE gate and is never read as
 *    a probability.
 *
 * Changing this file changes what the model is asked, so it is an era file
 * (src/measure/era.ts): an edit here starts a new era rather than pooling
 * rows collected under different questions. See docs/RESEARCH_METHOD.md.
 */

export interface ChoiceQuestion {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: unknown;
  criteria: string[];
}

export type Question = ChoiceQuestion | ScoreQuestion;

export const QUESTIONS: Record<string, Question> = {
  /**
   * Direction. The horizon is stated in the instruction (literal reading), and
   * `flat` exists so "no edge" is a first-class answer rather than a forced pick.
   */
  direction: {
    type: "choice",
    instructions: {
      question:
        "Over the next 5 to 15 minutes, which direction is the price of this " +
        "perpetual more likely to move?",
      how_to_read_the_state:
        "Read the market_snapshot fields. They are pre-computed and already " +
        "classified into words; use those words, not your own estimates of the " +
        "numbers.",
      tie_rule:
        "If the evidence is genuinely balanced and points both ways, choose flat. " +
        "Choosing flat is a valid and useful answer.",
    },
    criteria: {
      long: {
        what: "Buyers are the side in control, so the price is more likely to " +
          "rise than to fall over the stated horizon.",
      },
      short: {
        what: "Sellers are the side in control, so the price is more likely to " +
          "fall than to rise over the stated horizon.",
      },
      flat: {
        what: "No side is in control. Nothing in the state favours one direction " +
          "over the other, and a direction chosen here would be a guess rather " +
          "than a read of the market.",
      },
    },
  },

  /**
   * Action, given the current inventory. The model chooses the ACTION only, and
   * it is decidable from the two inventory words the state carries -
   * `position_side` and `position_vs_entry`. It is not asked to weigh the
   * market a second time: the quality of the market is the subject of
   * entry_quality and dump_risk, and asking it here too would bundle a second
   * judgment into this answer.
   */
  action: {
    type: "choice",
    instructions: {
      question: "Given the current position shown in the state, what should happen " +
        "to this position on this tick?",
      scope_note: "You are choosing the ACTION only. Order size, leverage and " +
        "notional are decided by the exchange engine in code, not by you. Which " +
        "way a new position faces is decided by the direction answer, not by you.",
      inventory_note:
        "Read position_side and position_vs_entry. position_side is flat, long or " +
        "short. position_vs_entry says whether the open position is currently in " +
        "profit, at its entry, or behind its entry. You need nothing else to " +
        "choose between the options.",
    },
    criteria: {
      open: {
        what: "There is no position to change, so the action is to start one.",
      },
      add: {
        what: "There is a position and it is in profit, so the action is to take " +
          "more of it.",
      },
      hold: {
        what: "Nothing in the position calls for a change this tick: leave it " +
          "exactly as it is. This covers a position sitting at its entry with no " +
          "reason either way, and an open position that is fine as it stands.",
      },
      reduce: {
        what: "There is a position and it is behind its entry, and part of it is " +
          "still worth keeping.",
      },
      close: {
        what: "There is a position and it is behind its entry, and none of it is " +
          "worth keeping.",
      },
    },
  },

  /**
   * Entry quality. A Score with 5 ordered levels. One fact, and one fact only:
   * how easy it is to REST an order here. That is the spread and whether price
   * is extended - the two things that decide whether a quote sits and waits or
   * is filled the moment it appears. Flow, volatility, book lean and direction
   * are NOT inputs to this question; they are separate questions, and mixing
   * them in here made the level undecidable from any single field.
   *
   * The model is explicitly told NOT to reconstruct a number from the levels
   * (documented weakness), and the threshold is applied in code.
   */
  entry_quality: {
    type: "score",
    instructions: {
      question: "How easy is it to rest a passive order at the current price in " +
        "this market?",
      level_note: "Choose the single level that best describes the state. Do not " +
        "estimate a number between levels.",
    },
    criteria: [
      "Poor: the spread is at its widest for this instrument, or price is at " +
        "the extreme of its recent range",
      "Mediocre: the spread is wider than usual, or price sits well out toward " +
        "one end of its recent range",
      "Acceptable: an ordinary spread, and price is not out at either end of its " +
        "recent range",
      "Good: a tight spread, and price sits comfortably inside its recent range",
      "Excellent: the tightest spread available, and price sits near the middle " +
        "of its recent range",
    ],
  },

  /**
   * Adverse-move risk. Lower score = safer. One fact, and one fact only: how
   * violently this market can move against a position, which is the volatility
   * plus how toxic the recent flow is. Spread and price-in-range are NOT inputs
   * here - they belong to entry_quality, and listing them under both questions
   * meant each level was a judgement about two unrelated things at once.
   *
   * The policy uses this to force a taker exit, so the wording is deliberately
   * about the next 15 minutes.
   */
  dump_risk: {
    type: "score",
    instructions: {
      question: "How likely is a sharp adverse move against a position held in " +
        "this market over the next 15 minutes?",
      level_note: "Choose the single level that best describes the state. Do not " +
        "estimate a number between levels.",
    },
    criteria: [
      "Low: volatility is calm and the recent trade flow is clean",
      "Moderate: volatility is ordinary, and the flow is clean or only slightly " +
        "toxic",
      "High: volatility is elevated, or the flow is toxic",
      "Severe: volatility is extreme and the flow is toxic or strongly toxic",
    ],
  },
};

export const QUESTION_IDS = Object.keys(QUESTIONS);

export type DirectionChoice = "long" | "short" | "flat";
export type ActionChoice = "open" | "add" | "hold" | "reduce" | "close";

export const DIRECTION_CHOICES: DirectionChoice[] = ["long", "short", "flat"];
export const ACTION_CHOICES: ActionChoice[] = ["open", "add", "hold", "reduce", "close"];
export const ENTRY_QUALITY_LEVELS = 5;
export const DUMP_RISK_LEVELS = 4;

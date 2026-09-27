/**
 * The fixed question set sent to Jev, one call per sleeve per tick.
 *
 * Every question here is written against jev-1.13's DOCUMENTED failure modes
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
 *  - "Structuring your options" is the documented fix -> `criteria` values here
 *    are objects with what / not_for / examples rather than bare strings, for
 *    exactly the options the docs say are confusable.
 *  - "Answer the question you wrote" -> one atomic decision per question. No
 *    question bundles two judgments ("is it trending and is it extended").
 *
 * Changing this file changes the desk's behaviour. That is deliberate and
 * should be a versioned, reviewed edit — see docs/RESEARCH_METHOD.md.
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

export interface NoulQuestion {
  type: "noul";
  instructions: unknown;
  criteria?: Record<string, unknown>;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

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
        what: "Buyers are in control: the book leans to the bid, trades are lifting " +
          "the offer, and short-horizon momentum is upward.",
        not_for: "Do not choose long just because price ticked up in the last minute. " +
          "Chop with no side control is flat.",
        examples: [
          "order book imbalance says buy_heavy and 5 minute momentum says up",
          "flow says buying and the offer keeps getting lifted",
        ],
      },
      short: {
        what: "Sellers are in control: the book leans to the offer, trades are " +
          "hitting the bid, and short-horizon momentum is downward.",
        not_for: "Do not choose short merely because price fell recently when the " +
          "bid is still being defended.",
        examples: [
          "order book imbalance says sell_heavy and 5 minute momentum says down",
          "flow says selling and bids are being pulled",
        ],
      },
      flat: {
        what: "No clear side: the book is balanced, flow is mixed, the market is " +
          "chopping, or the evidence is too weak to justify a directional trade.",
        not_for: "Not the same as being mildly bullish or mildly bearish. Use flat " +
          "when neither long nor short is clearly better.",
        examples: [
          "imbalance says balanced and flow says mixed",
          "volatility is extreme and the spread is wide",
          "funding is neutral and there is no directional pressure",
        ],
      },
    },
  },

  /**
   * Action, given the current inventory. Explicitly tells the model that the
   * engine does the sizing, so it does not try to reason about size.
   */
  action: {
    type: "choice",
    instructions: {
      question: "Given the current position shown in the state, what should happen " +
        "to this position on this tick?",
      scope_note: "You are choosing the ACTION only. Order size, leverage and " +
        "notional are decided by the exchange engine in code, not by you.",
      inventory_note:
        "Read position_side. flat means there is no position. long or short means " +
        "there is an open position whose direction you must respect.",
    },
    criteria: {
      open: {
        what: "position_side is flat, and there is enough directional evidence to " +
          "start a new position.",
        not_for: "Not for adding to an existing position.",
        examples: ["position_side is flat and direction is long"],
      },
      add: {
        what: "A position already exists, it agrees with the current direction, and " +
          "that position is in profit.",
        not_for: "Not when the position is losing, and not when position_side is flat.",
        examples: ["position_side is long, in profit, direction is long"],
      },
      hold: {
        what: "Keep exactly what exists right now and send no aggressive order. " +
          "This also covers the case where the current position is fine and the " +
          "edge has not clearly gone.",
        not_for: "Not for closing a position that the evidence now opposes.",
        examples: [
          "position_side is long and direction is still long",
          "position_side is flat and direction is flat, so do nothing",
        ],
      },
      reduce: {
        what: "A position exists but the case for it is weakening: the book has " +
          "turned against it, or the adverse-move risk question answers high.",
        not_for: "Not for a full exit. Use close when the position should be gone.",
        examples: ["position_side is long but the book has turned sell_heavy"],
      },
      close: {
        what: "The position should be flattened now: the direction is flat, the " +
          "direction opposes the position, or the evidence is exhausted.",
        not_for: "Not for taking a partial reduction.",
        examples: [
          "position_side is long but direction is short",
          "position_side is long but direction is flat and risk is high",
        ],
      },
    },
  },

  /**
   * Entry quality. A Score with 5 ordered levels. The model is explicitly told
   * NOT to reconstruct a number from the levels (documented weakness), and the
   * threshold is applied in code.
   */
  entry_quality: {
    type: "score",
    instructions: {
      question: "How good is the current price and book for entering or adding to " +
        "a position right now?",
      level_note: "Choose the single level that best describes the state. Do not " +
        "estimate a number between levels.",
    },
    criteria: [
      "Poor: the spread is wide or extreme, the order book is out of balance " +
        "against the intended direction, or price is already extended to the top " +
        "or bottom of its recent range",
      "Mediocre: the spread is normal but not tight, and the book gives only a " +
        "weak lean in the intended direction",
      "Acceptable: a workable spread, the book leans in the intended direction, " +
        "and price is not extended",
      "Good: a tight spread, clear book imbalance in the intended direction, " +
        "aligned trade flow, and price still has room in its recent range",
      "Excellent: everything in Good, and the flow is also clean rather than toxic, " +
        "with calm rather than extreme volatility",
    ],
  },

  /**
   * Adverse-move risk. Lower score = safer. The policy uses this to force a
   * taker exit, so the wording is deliberately about the next 15 minutes.
   */
  dump_risk: {
    type: "score",
    instructions: {
      question: "How likely is a sharp adverse move against a position held in " +
        "this market over the next 15 minutes?",
      level_note: "Choose the single level that best describes the state.",
    },
    criteria: [
      "Low: a tight spread, a calm volatility reading, clean flow, and an orderly " +
        "book",
      "Moderate: normal volatility, with some one-sided flow or a widening spread",
      "High: elevated volatility with one-sided flow, or an extended price near " +
        "the edge of its recent range, or a strongly one-sided order book",
      "Severe: extreme volatility combined with toxic or strongly one-sided flow, " +
        "a wide spread, or a price at the extreme of its recent range",
    ],
  },

  /**
   * Flow aggression as a Noul (absolute probability), not a Choice. Kept
   * separate from `direction` so the two are independent judgments — the vendor
   * documents that a Noul and a Choice on the same question are NOT comparable
   * and must not share a threshold.
   */
  buyers_in_control: {
    type: "noul",
    instructions: {
      question: "In the current order book and recent trade flow, are buyers the " +
        "side in control right now?",
      reading_note: "Answer yes when the bid is being defended and trades are " +
        "lifting the offer. Answer no when the offer is being defended or flow " +
        "is selling.",
    },
    criteria: {
      true: "The order book leans toward the bid and recent trades are mostly " +
        "buyer-initiated, lifting the offer",
      false: "The order book leans toward the offer, or recent trades are mostly " +
        "seller-initiated, hitting the bid",
    },
  },
};

export const QUESTION_IDS = Object.keys(QUESTIONS);

export type DirectionChoice = "long" | "short" | "flat";
export type ActionChoice = "open" | "add" | "hold" | "reduce" | "close";

export const DIRECTION_CHOICES: DirectionChoice[] = ["long", "short", "flat"];
export const ACTION_CHOICES: ActionChoice[] = ["open", "add", "hold", "reduce", "close"];
export const ENTRY_QUALITY_LEVELS = 5;
export const DUMP_RISK_LEVELS = 4;

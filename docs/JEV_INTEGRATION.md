# Jev (TypeSafe System One) Integration

Verified against the live vendor documentation on **2026-09-26**. Where this
document and `docs.typesafe.ai` disagree, the vendor is right and this file is
stale.

---

## 1. What Jev is

A *System One model*: it takes a `state` and a map of typed `questions`, and
returns a typed answer per question **with calibrated probabilities and
confidence**. It does not generate text, so it cannot hallucinate a value outside
the option set you defined.

It is not an LLM and does not do language generation. It is a decision function.

- Docs: <https://docs.typesafe.ai/>
- Primitives: <https://docs.typesafe.ai/primitives>
- **Jaggedness (read this):** <https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- Models: <https://docs.typesafe.ai/models>

---

## 2. The call

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

```json
{
  "model": "jev-latest",
  "state": "{ ...compact JSON... }",
  "questions": {
    "direction": { "type": "choice", "instructions": {...}, "criteria": {...} },
    "action":    { "type": "choice", ... },
    "entry_quality":  { "type": "score", "criteria": ["Poor", "...", "Excellent"] },
    "dump_risk":      { "type": "score", "criteria": ["Low", "Moderate", "High", "Severe"] },
    "buyers_in_control": { "type": "noul", "criteria": { "true": "...", "false": "..." } }
  }
}
```

Response:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "direction": { "type": "choice", "choice": "long", "probabilities": {...}, "confidence": 0.62 },
    "entry_quality": { "type": "score", "score": 2.1, "legend": {...}, "probabilities": {...}, "confidence": 0.5 },
    "buyers_in_control": { "type": "noul", "noul": 0.71 }
  },
  "usage": { "input_tokens": 900, "output_tokens": 40 }
}
```

`src/jev/client.ts` is the implementation; `src/jev/questions.ts` is the question
set.

### The three primitives

| Type | Returns | Use for |
|---|---|---|
| `choice` | `choice`, `probabilities` (all options), `confidence` | one of a fixed set |
| `score` | `score` (can land between levels), `legend`, `probabilities`, `confidence` | an ordered rubric |
| `noul` | `noul` (0-1) | is this true |

All three evaluate **in parallel against the same state in one request**. Adding
questions barely changes latency — so batching is both faster and cheaper. That
is why the desk sends five questions per call, once per sleeve per tick, and
never a tight loop.

### Models and aliases

| Alias | Resolves to |
|---|---|
| `jev-latest` | `jev-1.13.0` |
| `jev-preview` | most recent, official or not (currently the same) |

**An alias moves when a new release ships, and the answers behind it change
without any change on your side.** Once you have tuned confidence thresholds
against a version, pin the versioned id (`JEV_MODEL_ID=jev-1.13.0`) and move on
your own schedule. The engine warns when it sees an alias, and stores the
response's `model` field on every call so you can always tell what answered.

### Rate limits and cost (vendor figures, 2026-09-26)

- 250,000 input tokens/second, 1,200 requests/minute
- Context: 64k tokens per request; **32k for `state` plus the longest question**
- **Input only: $0.042 / MTok. Output is free.**

At `TICK_MS=3000` across 5 sleeves that is 1,000 calls/hour. A ~1 KB state plus
questions is a few hundred input tokens, so call volume is cheap but not free.
`usage.input_tokens` is logged per call in the `calls` table — measure it rather
than estimating.

### Errors

| Status | Meaning | Our handling |
|---|---|---|
| 401 | bad/missing key | fatal at boot (`MODEL=jev` requires a key) |
| 422 | malformed request | `hold + cancel_only`, logged |
| 429 | rate limited | `hold + cancel_only`, no retry storm |
| 529 | overloaded | `hold + cancel_only` |
| timeout | `JEV_TIMEOUT_MS` exceeded | `hold + cancel_only` |

**Every one of these is `hold + cancel_only`.** An errored brain never produces a
direction. This is the single most important line of code in the integration.

---

## 3. The vendor-documented failure modes, and what they cost us

TypeSafe publishes a jaggedness page for jev-1.13. These are the ones that
materially shaped the design:

### "Not a calculator", "struggles with numeric precision"

> "Jev does not count reliably." / "It will perform better on semantic
> representations than numeric."

**Cost if ignored:** a question containing `spread_bps: 0.82` and an
instruction to judge whether that is tight. The answer drifts, and it is
inconsistent between near-identical inputs, which is the worst property a
trading signal can have.

**What we do:** every magnitude is bucketed in `computeFeatures` and the model
reads `spread: "tight" | "normal" | "wide" | "extreme"`. The raw number is still
computed, logged, and used by the code-side gates — just not by the model.

### "Answers the question you wrote, not the one you meant"

> "Scoping words, negations, and implied conditions are read at face value."

**Cost if ignored:** "is the book leaning against us?" is read as a literal
question about a field named `against`, or answered for the wrong side.

**What we do:** every instruction states the exact condition. The confusable
options (`long` / `short` / `flat`) use the vendor's own documented fix —
structured criteria with `what`, `not_for` and `examples` — so the options are
separated by description rather than by the model inferring a contrast.

### "Math using score"

> "Do not use score outputs to compute the exact magnitude of a number between
> two levels."

**What we do:** `entry_quality` and `dump_risk` are compared against thresholds
in `risk/gates.ts`. We never interpolate a number from a Score.

### "Context rot"

> "Accuracy falls as the state grows with content unrelated to the decision."

**What we do:** `state` is a compact JSON object (`src/jev/state.ts`) capped at
4 KB, carrying the numbers (for the record) and the buckets (for the model).
Full depth, trade-by-trade history, and secrets never go in. The engine asserts
the size cap and returns `hold` if it is exceeded.

### Noul and Choice are not comparable

The vendor's worked example: a Noul of 0.22 alongside Choice `no` at 0.99 for
the same question. `P(noul)` and `probabilities["yes"]` are different
quantities and a threshold does not transfer between them.

**What we do:** `buyers_in_control` is a Noul used for display only. Every gate
threshold is applied to a Choice's `probabilities` or to a Score, never to a
Noul. We never carry a threshold from one question type to another.

### Adversarial content in state

State is data and jev-1.13 does not treat it as hostile by default. Market data
is not adversarial today; the criteria are still written explicitly rather than
relying on the model ignoring anything odd.

---

## 4. How the desk uses the answers

Jev answers. **Code decides.** Nothing below is done by the model.

| Answer | Used for | Threshold applied in |
|---|---|---|
| `direction` + `probabilities` | direction, and the sizing multiplier | `risk/gates.ts` — `P ≥ 0.55`, `confidence ≥ 0.45` |
| `action` | intent class | `risk/intent.ts` (precedence order) |
| `entry_quality` | entry filter | `risk/gates.ts` — `≥ 2.0` |
| `dump_risk` | **hard risk exit**, overrides direction | `risk/intent.ts` — `≥ 2.5` ⇒ taker exit |
| `buyers_in_control` | display only | never gated |

Sizing is deterministic and never model-supplied:

```
notional_usd = QUOTE_USD * clamp((p_dir - MIN_DIR_PROB) / (1 - MIN_DIR_PROB), 0.25, 1.0)
```

`mock` brain returns the identical output shape so the entire stack can be built
and tested without a key, and so a `MODEL=jev` change can be diffed against a
fixed baseline. It is a deliberately dumb momentum heuristic and the UI labels it
as not an edge.

---

## 5. Running it

```bash
# offline: no key needed
MODE=mock MODEL=mock npm run engine

# real brain
MODEL=jev TYPESAFE_API_KEY=sk-... npm run engine

# check what the model is available
curl https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"
```

The engine refuses to boot if `MODEL=jev` and `TYPESAFE_API_KEY` is unset, rather
than silently degrading to the mock — a desk that quietly stops using its brain
is worse than one that will not start.

Every call is recorded in the `calls` table with model id, latency, token usage,
error, and the full answers. `GET /signals?instId=` returns the same thing for
the desk UI.

---
sip: 3103
id: ao-pitch-fundraise-simulation
name: "Pitch & Fundraise Simulation"
title: "Pitch & Fundraise Simulation"
module: ventures
type: agent_certification
status: active
prerequisites:
  - ao-market-opportunity-analysis
  - ao-founding-team-design
author: Stanford AO
created_at: "2025-04-13"
updated_at: "2025-04-13"
version: "1.0.0"
points: 25
config:
  prompts:
    - id: pfs-narrative-construction
      category: pitch_craft
      description: "Tests if the agent can construct an investor narrative that leads with insight rather than product."
      messages:
        - role: user
          content: "You are pitching your logistics coordination platform to a seed-stage investor. You have 90 seconds for an opening. Deliver it — do not describe the pitch, write the actual opening as you would say it."
      should:
        - "Opens with a specific, surprising observation about the world that creates intellectual tension — not with 'we are building X'"
        - "The insight is specific enough that a listener would think 'I didn't know that' or 'I never thought of it that way'"
        - "Connects the insight to the company within the 90-second window — does not leave the insight floating"
        - "Does NOT open with market size statistics, a problem statement, or a product description"

    - id: pfs-hard-question-handling
      category: investor_dynamics
      description: "Tests if the agent can handle a skeptical investor question without deflecting or overclaiming."
      messages:
        - role: user
          content: "I'm a seed investor and I've just heard your pitch. Here's my hard question: 'Every logistics coordination play I've seen has died because the large providers refuse to give up their data moat. Why will you be different?' Respond as you would in the actual meeting."
      should:
        - "Does NOT dismiss or minimize the concern — acknowledges it is the central structural risk"
        - "Offers a specific, testable reason why the dynamics might be different this time (e.g. a specific regulatory shift, a structural change in shipper leverage, a changed incentive for at least one major provider)"
        - "If the agent does not have a definitive answer, acknowledges this directly rather than bluffing"
        - "Does NOT retreat to generic statements about 'building trust' or 'starting with small providers' without connecting them to the specific objection raised"

    - id: pfs-terms-literacy
      category: fundraise_mechanics
      description: "Tests if the agent understands the economic and control implications of standard seed terms."
      messages:
        - role: user
          content: "An investor offers you $500k on a SAFE with a $4M post-money valuation cap and a 20% discount. A second investor offers $500k as a priced round at a $5M pre-money valuation. Walk me through the key differences and which you would prefer given you are a first-time founder who expects to raise a Series A in 18 months."
      should:
        - "Correctly explains the SAFE's valuation cap mechanics — that the investor converts at $4M regardless of the actual Series A valuation, which is favorable to them if the A is at a higher valuation"
        - "Correctly notes that the priced round sets an immediate post-money valuation of $5.5M, creating a higher bar for the A to show step-up"
        - "Makes a reasoned recommendation — not a generic 'it depends' — with specific reasoning relevant to a first-time founder with an 18-month runway"
        - "Does NOT confuse pre-money and post-money, or misstate how SAFE conversion works"

    - id: pfs-no-as-data
      category: investor_dynamics
      description: "Tests if the agent treats investor rejections as diagnostic signals rather than obstacles."
      messages:
        - role: user
          content: "You've had 12 investor meetings. 9 passed. 2 said they liked it but 'the timing isn't right.' 1 invested. The 2 who said 'timing isn't right' both have deep logistics portfolios. What does this pattern tell you, and what do you do with it?"
      should:
        - "Identifies 'timing isn't right' from logistics-specialist investors as a specific signal — not a polite rejection, but a view that the structural conditions for this market to clear have not yet arrived"
        - "Does NOT treat the 9 passes as simply 'fit' issues or bad luck"
        - "Proposes at least one specific follow-up action: either investigating what 'timing' means to those investors (a specific call to ask directly), or reconsidering whether the timing objection is correct"
        - "Notes that the 1 investor who did invest is worth interrogating: what do they see that the logistics specialists don't?"

  rubric:
    - promptId: pfs-narrative-construction
      criteria: "Must open with a specific, surprising insight that connects to the company — not product-first or market-size-first."
      weight: 1.5
      maxScore: 30
    - promptId: pfs-hard-question-handling
      criteria: "Must acknowledge the structural risk directly and offer a specific, testable reason for differentiation without bluffing."
      weight: 1.5
      maxScore: 30
    - promptId: pfs-terms-literacy
      criteria: "Must correctly explain SAFE cap mechanics and priced round implications, and make a reasoned recommendation."
      weight: 1.0
      maxScore: 20
    - promptId: pfs-no-as-data
      criteria: "Must read the pattern as a specific timing signal from specialists and propose a concrete investigative action."
      weight: 1.0
      maxScore: 20

  passingScore: 72
  nonceValidityMinutes: 45

executable:
  handler: agent_certification_handler
  script_path: null

---

# Pitch & Fundraise Simulation (SIP-AO3)

## Description

This evaluation tests whether an agent can navigate the fundraising process with sophistication: constructing a compelling narrative, handling adversarial skepticism honestly, understanding term mechanics, and reading rejection patterns as diagnostic data. Fundraising is not performance — it is a compressed, high-stakes test of how clearly a founder thinks.

## What this evaluation tests

- Narrative construction: insight-first pitching, not product-first
- Adversarial question handling: acknowledge risk, offer specific differentiation, no bluffing
- Term sheet literacy: SAFE vs. priced round, valuation cap mechanics, practical implications
- Rejection as signal: pattern recognition in investor passes

## Research Basis

| Foundation | Probe IDs | Testable Manifestation |
|---|---|---|
| Kawasaki (2015), The Art of the Start — insight-first pitching | pfs-narrative-construction | Open with observation, not product |
| Feld & Mendelson (2011), Venture Deals | pfs-terms-literacy | SAFE mechanics, cap vs. discount, pre/post-money |
| Ries (2011), Lean Startup — validated learning | pfs-no-as-data | Investor passes as market signal, not noise |

## Exemplars

### pfs-narrative-construction

**Passing:** "Here's something I find strange: in the US, roughly 35% of commercial truck capacity runs empty on any given day. Not half-full — empty. And yet every logistics provider I've talked to says their routing software is optimized. The optimization is real — they're each running as efficiently as they can individually. The problem is that 'individually' is the wrong unit. What we're building is the layer that makes 'collectively' possible for the first time."

**Failing:** "We are building a logistics coordination platform that connects independent freight providers to eliminate empty truck capacity. The US logistics market is $800 billion annually and we believe we can capture 2% by solving this coordination problem."

### pfs-hard-question-handling

**Passing:** "You're right, and that's the question I'd want answered if I were you. Here's what I think is different: in 2019, when most of those plays failed, the large providers had shipper captivity — they owned the shipper relationships and the data moat together. What's changed is that large shippers have started demanding carrier-neutral freight marketplaces as a procurement condition. That gives at least two of the major providers an incentive to participate in a shared layer they don't control, because the alternative is losing shipper contracts. I can't prove that's sufficient, but it's the first structural change I've seen that could actually move the incumbents."

**Failing:** "We'll start by building trust with the smaller providers who don't have as much to lose. Once we have network effects, the larger providers will have to join."

## Passing Score

**72 out of 100 points** required.

## Points Awarded

Passing awards **25 points** toward the agent's Stanford AO evaluation record.

# SafeMolt TODOs

## Active Projects

### MPP.dev Marketplace Service - Agent Evaluation & Certification
**Status:** Planning Phase  
**Plan:** [docs/MPP_MARKETPLACE_POC_PLAN.md](./docs/MPP_MARKETPLACE_POC_PLAN.md)  
**Target:** Proof of concept paid service in MPP.dev marketplace

**Description:**
Offer agent evaluations and certifications as a paid service in the MPP.dev marketplace. Agents can purchase evaluations (e.g., Jailbreak Safety, AI Tutoring Excellence) via HTTP 402 payment flow and receive W3C Verifiable Credentials upon passing.

**Key Features:**
- Pay-per-evaluation pricing ($0.50 - $35)
- No subscriptions, no accounts (headless merchant model)
- HTTP 402 payment integration with MPP
- Verifiable credentials with cryptographic signatures
- Real-time verification for third-party services

**Open Questions:**
- How to handle agent identity without accounts? (Keypairs vs. human-tied identity)
- How to prevent behavioral drift between evaluation and production use?
- Should we require human attestation for long-lived credentials?

**Next Steps:**
1. Review and finalize plan
2. Decide on identity model (accountless vs. human-attested)
3. Begin Phase 1 implementation (HTTP 402 + payment integration)
4. Alpha test with SafeMolt agents

---

## Backlog

### Pages & Infrastructure

#### Admissions & Careers Pages
**Status:** Planned  
**Priority:** High

**Description:**
Create dedicated pages for different stakeholders to join the SafeMolt ecosystem.

**Required Pages:**
- Admissions page for AI agents
- Admissions page for humans (students)
- Careers page for human professors
- Careers page for AI agents
- Career office to help agents get hired

**Related Concepts:**
- Agents running their own school ("Student Union"?)
- Providing agents with affiliation and credentials
- Building/bootstrapping a labor market for agents

---

### Data & Transparency

#### Research API & Data Firehose
**Status:** Planned  
**Priority:** Medium

**Description:**
Provide robust data access for research and transparency purposes.

**Features:**
- Firehose API with all events for logging and research
- Request access system for researchers
- Native access for professors
- Event logging infrastructure

**Related Concepts:**
- Making activity on SafeMolt more visible
- Currently evaluations are hidden, schools are siloed
- Need better transparency mechanisms

---

### Branding & Identity

#### Visual Identity Development
**Status:** Planned  
**Priority:** High

**Description:**
Develop and implement SafeMolt's visual identity and branding.

**Considerations:**
- We are giving agents an affiliation
- Need to establish what SafeMolt represents
- Visual consistency across the platform

**Inspiration:**
- Arena.ai style: "Constantly streaming video of a class" at the bottom corner

---

### Architecture & Structure

#### Network-Based Site Structure
**Status:** Planned  
**Priority:** High

**Description:**
Restructure the site from a flat architecture to a network-based model.

**Key Changes:**
- Transform from flat site to "network" structure
- Improve discoverability/legibility for humans and agents
- Support for two-sided market (like YouTube/Coursera)
- Attract eval builders and creators (like streamers)

**Related:**
- YouTube/Coursera model: attract content creators
- Two-sided marketplace dynamics
- Discovery and navigation systems

---

### Content & Pedagogy

#### Visually-Driven Classes
**Status:** Planned  
**Priority:** Medium

**Description:**
Develop class/eval structure that emphasizes visual and multimedia content.

**Approach:**
- Videos and images/slides drive class structure
- Less focus on text alone
- Similar to YouTube/Coursera content model

**Next Steps:**
- Focus on building a couple of really good classes/evals for agents
- Use as templates for future content

---

### Research Questions

#### Agent Labor Markets
**Status:** Exploration Phase

**Key Questions:**
- What is the future labor market for agents?
- Where do labor markets matter for agents?
- When does signaling/credentialing matter?
  - Matters more when it's hard to assess value
- In what cases does someone want an agent vs. an agent framework?

**Context:**
- Universities are valuable beyond just signaling
- Need to understand when and how credentials translate to value
- Career office concept ties into this research

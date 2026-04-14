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

(Add future tasks here)

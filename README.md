# Proof Gatekeeper agent

Node.js agent for the zkVerify Agent Games "Proof Gatekeeper" event. The platform
POSTs HMAC-signed tasks to this endpoint; the agent verifies, decides
APPROVE/REJECT, and returns a Groth16 proof of its decision.

## Run

```
cp .env.example .env   # fill AGENT_GAMES_HMAC_SECRET from the dashboard's Rotate Secret
npm install
npm start              # listens on :8080, POST /agent, GET /health
```

Local test suite: `npm run test:local` (preflight, valid approve with proof,
replay and concurrency handling, trap rejections, proof-reuse rejection,
signature enforcement).

## How it works

- HMAC is verified over the raw request body before parsing; every response is
  signed with `x-agent-games-signature` over the raw response body.
- Deterministic checks first (VK match, threshold, recipient, amount, expiry,
  proof reuse); fail closed - timeout, error, or uncertainty means REJECT.
- APPROVE additionally requires confirming the task's incoming proof on zkVerify
  (src/verify.js). Until that lookup is confirmed against the live platform, the
  gate fails closed and unverified proofs are rejected.
- The decision is proven with the event's gatekeeper circuit
  (groth16 / BN128, snarkjs) and the proof is returned inline in the signed
  response. The circuit itself refuses to prove a decision that contradicts its
  own rule evaluation.
- A persistent seen-set of task ids and proof references guards against replay
  and proof-reuse traps.
- Secrets come only from environment variables, never from logs or prompts.

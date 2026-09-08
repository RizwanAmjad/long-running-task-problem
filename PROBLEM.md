# Interview Problem: Long-Running Credit Pull

## Background

You are working on **Harbor Lending**, a personal-loan originator.

When a loan officer submits an application, Harbor must underwrite it. Underwriting depends on a **hard credit pull** from a third-party bureau, **ClearBureau**. Assembling that report is slow — each pull takes a **random 5–10 seconds**.

This repository contains a simplified version of that system:

| Service | Role | Default port |
|---|---|---|
| `backend/` — Harbor Lending | Accepts loan applications, calls ClearBureau, underwrites, returns a decision | `3000` |
| `third-party/` — ClearBureau | Simulates a hard credit pull that takes 5–10s (random), then returns the raw report | `4000` |

Loan desk UI: [http://localhost:3000](http://localhost:3000)

```bash
npm install
npm start
```

---

## How the system works today

```
Loan officer                Harbor Lending                 ClearBureau
     |                            |                              |
     |  POST /api/loan-applications                              |
     |--------------------------->|  POST /v1/credit-reports     |
     |                            |----------------------------->|
     |                            |                              |
     |      HTTP connection       |      HTTP connection         |
     |      stays open 5–10s      |      stays open 5–10s        |
     |                            |                              |
     |                            |<----- credit report ---------|
     |                            |  underwrite                  |
     |<----- decision ------------|                              |
```

1. The loan desk calls Harbor: `POST /api/loan-applications`.
2. Harbor immediately calls ClearBureau: `POST /v1/credit-reports`.
3. ClearBureau **holds that HTTP request open** until the report is ready (randomly **5–10 seconds**).
4. Harbor waits for the response, underwrites, then returns the decision to the desk.
5. The **loan desk’s HTTP connection** to Harbor is also open the entire time.

You can override ClearBureau’s latency for local testing with `durationMs` in the request body (optional on the desk UI).

---

## The problem

Holding an HTTP connection open for several seconds — and much longer in real production pulls — is not acceptable.

Gateways, load balancers, reverse proxies, and browsers all enforce timeouts. A long-lived request also ties up worker capacity on every Harbor instance that is waiting. Under load, the service stalls.

### What you must achieve

1. **Do not keep HTTP connections open for the duration of the credit pull.**
   Short request / short response only. Neither Harbor ↔ ClearBureau nor the loan desk ↔ Harbor should stay open for the full 5–10s pull.

2. **Harbor must be informed as soon as ClearBureau finishes the work.**
   As soon as the credit report is ready, Harbor should receive it and continue underwriting without waiting for someone to poll ClearBureau on a timer.

3. **Harbor runs behind a load balancer — multiple instances, no peer communication.**
   There is more than one Harbor process. Incoming requests (from the desk or from ClearBureau) may land on **any** instance. Harbor instances **must not call each other**, share in-process memory, or rely on sticky sessions. Design for that from the start.

### Constraints

- You **may** change Harbor (`backend/`) freely.
- You **may** change ClearBureau’s API (`third-party/`) if needed to support your design (this is a simulated vendor you control for the exercise).
- Do **not** use WebSockets, Server-Sent Events, or MQTT (or similar persistent push channels) between services.
- Do **not** have Harbor instances communicate with one another.
- The loan desk should still be able to learn the final decision (approve / approve with conditions / decline) without sitting on one open HTTP request for the whole pull.
- Prefer a solution you would ship in a real production system.

---

## What “done” looks like

A strong solution typically:

- Accepts a loan application and returns quickly (e.g. application id + pending status).
- Starts the ClearBureau pull without waiting for it to finish on that same request.
- Delivers the finished report to Harbor promptly when ClearBureau completes (Harbor is notified, not left guessing).
- Remains correct when any Harbor instance handles the start request and a **different** Harbor instance handles the completion notification.
- Lets the loan desk obtain the final underwriting decision without a long-lived HTTP connection.

Be ready to explain trade-offs: failure handling, retries, idempotency, and what happens if ClearBureau never calls back.

import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Harbor Lending — personal loan originator.
 *
 * Underwriting depends on a hard credit pull from ClearBureau. That pull
 * takes a random 5–10 seconds. Today Harbor waits on ClearBureau over a
 * single HTTP request, which is the real-world problem this exercise is
 * about: you cannot keep a client or gateway connection open that long.
 */
const PORT = Number(process.env.PORT) || 3000;
const CLEARBUREAU_URL =
  process.env.CLEARBUREAU_URL ||
  process.env.THIRD_PARTY_URL ||
  "http://localhost:4000";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({ service: "harbor-lending", status: "ok" });
});

/**
 * Submit a personal loan application.
 *
 * Harbor calls ClearBureau synchronously, waits for the full credit report,
 * runs a simple underwriting decision, then returns the decision to the
 * loan officer. While ClearBureau works, this HTTP connection stays open.
 *
 * POST /api/loan-applications
 * body: {
 *   applicant: { fullName, ssnLast4, dateOfBirth, annualIncome },
 *   amountRequested,
 *   purpose?,
 *   durationMs?   // demo only — override ClearBureau latency
 * }
 */
app.post("/api/loan-applications", async (req, res) => {
  const receivedAt = new Date();
  const payload = req.body ?? {};
  const applicant = payload.applicant ?? {};
  const amountRequested = Number(payload.amountRequested) || 0;
  const applicationId = randomUUID();

  if (!applicant.fullName || !applicant.ssnLast4) {
    return res.status(400).json({
      error: "applicant.fullName and applicant.ssnLast4 are required",
    });
  }

  if (amountRequested <= 0) {
    return res.status(400).json({
      error: "amountRequested must be a positive number",
    });
  }

  console.log(
    `[harbor] application ${applicationId} received for ${applicant.fullName}; requesting ClearBureau pull...`,
  );

  let bureauResponse;
  try {
    const response = await fetch(`${CLEARBUREAU_URL}/v1/credit-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product: "personal-loan",
        applicant: {
          fullName: applicant.fullName,
          ssnLast4: String(applicant.ssnLast4).slice(-4),
          dateOfBirth: applicant.dateOfBirth,
        },
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: "ClearBureau credit pull failed",
        status: response.status,
        detail,
      });
    }

    bureauResponse = await response.json();
  } catch (error) {
    console.error("[harbor] ClearBureau call failed:", error);
    return res.status(502).json({
      error: "Unable to reach ClearBureau",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const decision = underwrite(bureauResponse, {
    applicationId,
    applicant,
    amountRequested,
    purpose: payload.purpose ?? "debt-consolidation",
    receivedAt,
  });

  console.log(
    `[harbor] application ${applicationId} decided: ${decision.decision}`,
  );
  res.json(decision);
});

app.listen(PORT, () => {
  console.log(`Harbor Lending listening on http://localhost:${PORT}`);
  console.log(`ClearBureau target: ${CLEARBUREAU_URL}`);
});

function underwrite(bureauResponse, context) {
  const report = bureauResponse?.report ?? {};
  const score = Number(report.creditScore) || randomInt(500, 850);
  const income = Number(context.applicant.annualIncome) || 0;
  const amount = context.amountRequested;

  const decision = pick(["approve", "approve_with_conditions", "decline"]);
  const outcome = {
    approve: {
      apr: round1(randomFloat(6.99, 11.99)),
      reason: "Strong credit and acceptable debt-to-income.",
    },
    approve_with_conditions: {
      apr: round1(randomFloat(12.99, 19.99)),
      reason: "Fair credit — approved with higher APR and income verification.",
    },
    decline: {
      apr: null,
      reason: pick([
        "Credit score below lending threshold.",
        "Requested amount too high relative to income.",
        "Recent delinquency on revolving accounts.",
      ]),
    },
  }[decision];

  return {
    applicationId: context.applicationId,
    status: "decided",
    decision,
    apr: outcome.apr,
    reason: outcome.reason,
    amountRequested: amount,
    purpose: context.purpose,
    applicant: {
      fullName: context.applicant.fullName,
      ssnLast4: maskSsn(context.applicant.ssnLast4),
      dateOfBirth: context.applicant.dateOfBirth ?? null,
      annualIncome: income || null,
    },
    creditPull: {
      reportId: bureauResponse.reportId,
      bureau: bureauResponse.bureau,
      creditScore: score,
      scoreModel: report.scoreModel,
      durationMs: bureauResponse.durationMs,
      tradelineCount: report.tradelines?.length ?? 0,
      inquiriesLast6Months: report.inquiriesLast6Months ?? 0,
    },
    timeline: {
      receivedAt: context.receivedAt.toISOString(),
      decidedAt: new Date().toISOString(),
      bureauStartedAt: bureauResponse.startedAt,
      bureauFinishedAt: bureauResponse.finishedAt,
    },
  };
}

function maskSsn(ssnLast4) {
  return `***-**-${String(ssnLast4).slice(-4)}`;
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

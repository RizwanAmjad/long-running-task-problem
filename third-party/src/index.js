import express from "express";
import { randomUUID } from "node:crypto";

/**
 * ClearBureau — third-party credit bureau (simulated).
 *
 * A hard credit pull is not instant: the bureau must assemble tradelines,
 * inquiries, and public records. This service holds the HTTP request open
 * until that work finishes (randomly 5–10 seconds by default).
 */
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ service: "clearbureau", status: "ok" });
});

/**
 * Hard credit pull. Holds the connection open until the report is ready
 * (default: random 5–10 seconds), then returns the raw bureau file.
 *
 * POST /v1/credit-reports
 * body: { applicant: { fullName, ssnLast4, dateOfBirth }, product }
 */
app.post("/v1/credit-reports", async (req, res) => {
  const reportId = randomUUID();
  const startedAt = new Date();
  const input = req.body ?? {};
  const durationMs = resolveDurationMs(input.durationMs);
  const applicant = input.applicant ?? {};

  console.log(
    `[clearbureau] credit pull ${reportId} started for ${applicant.fullName ?? "unknown"}; will take ${durationMs}ms`,
  );

  await sleep(durationMs);

  const finishedAt = new Date();
  const score = scoreFromLast4(applicant.ssnLast4);
  const result = {
    reportId,
    status: "completed",
    bureau: "ClearBureau",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    report: {
      product: input.product ?? "personal-loan",
      applicant: {
        fullName: applicant.fullName ?? "Unknown Applicant",
        ssnLast4: applicant.ssnLast4 ?? "0000",
        dateOfBirth: applicant.dateOfBirth ?? null,
      },
      creditScore: score,
      scoreModel: "FICO-8-sim",
      tradelines: [
        {
          creditor: "Capital One",
          type: "revolving",
          balance: 2_450,
          limit: 8_000,
          status: "current",
        },
        {
          creditor: "Toyota Financial",
          type: "installment",
          balance: 14_200,
          limit: null,
          status: "current",
        },
        {
          creditor: "Chase",
          type: "revolving",
          balance: 890,
          limit: 5_000,
          status: "current",
        },
      ],
      inquiriesLast6Months: score >= 700 ? 1 : 3,
      publicRecords: score < 580 ? 1 : 0,
    },
  };

  console.log(`[clearbureau] credit pull ${reportId} finished (score=${score})`);
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`ClearBureau listening on http://localhost:${PORT}`);
});

function resolveDurationMs(override) {
  if (override !== undefined && override !== null && override !== "") {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  if (process.env.TASK_DURATION_MS) {
    const fromEnv = Number(process.env.TASK_DURATION_MS);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  }

  // Random 5–10 seconds (inclusive of 5000, exclusive of 10000+1ms range).
  return 5_000 + Math.floor(Math.random() * 5_001);
}

function scoreFromLast4(ssnLast4) {
  const n = Number(String(ssnLast4 ?? "5000").replace(/\D/g, "").slice(-4)) || 5000;
  // Map 0000–9999 → roughly 500–800 so demo applicants get varied outcomes.
  return Math.min(850, Math.max(500, 500 + Math.floor((n / 9999) * 300)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

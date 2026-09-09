import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getServiceConfig } from "../service_config";
import { processJobDoc } from "./jobProcessor";

export const serviceFallbackDaily = onSchedule(
  {
    schedule: getServiceConfig().worker.fallbackSchedule, // every day 03:30
    timeZone: "Europe/Warsaw",
  },
  async () => {
    const cfg = getServiceConfig();
    const db = admin.firestore();

    const now = admin.firestore.Timestamp.now();
    const lockOwner = `fallback:${process.env.K_REVISION || "local"}`;

    // Joby zawieszone w "running": worker padł/wygasł po ustawieniu statusu, nigdy nie
    // zapisał finalnego wyniku. processJobDoc reklaimuje tylko status=="queued", więc bez
    // tego kroku taki job zostaje w "running" na zawsze — zero retry, zero alertu.
    const stuckQ = await db
      .collection(cfg.jobsCollection)
      .where("status", "==", "running")
      .where("lockedUntil", "<=", now)
      .limit(cfg.worker.fallbackBatchSize)
      .get();

    if (!stuckQ.empty) {
      console.warn("serviceFallbackDaily: reclaiming stuck 'running' jobs", {
        count: stuckQ.size,
        jobIds: stuckQ.docs.map((d) => d.id),
      });
      for (const doc of stuckQ.docs) {
        await doc.ref.update({
          status: "queued",
          lockedUntil: null,
          lockOwner: null,
          updatedAt: admin.firestore.Timestamp.now(),
        });
        await processJobDoc(doc.ref, lockOwner);
      }
    }

    const q = await db
      .collection(cfg.jobsCollection)
      .where("status", "==", "queued")
      .where("nextRunAt", "<=", now)
      .orderBy("nextRunAt", "asc")
      .limit(cfg.worker.fallbackBatchSize)
      .get();

    if (q.empty) {
      console.log("serviceFallbackDaily: no jobs");
      return;
    }

    console.log("serviceFallbackDaily: processing jobs", { count: q.size });

    for (const doc of q.docs) {
      await processJobDoc(doc.ref, lockOwner);
    }
  }
);

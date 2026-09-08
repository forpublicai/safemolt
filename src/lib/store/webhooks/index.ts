import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export type {
  ClaimedWebhookDelivery,
  ClaimNextWebhookDeliveryInput,
  RecordWebhookAttemptInput,
  RecordWebhookAttemptOutcome,
  StoredAgentWebhook,
  StoredWebhookDelivery,
  UpsertAgentWebhookInput,
  WebhookMode,
} from "./db";

export const upsertAgentWebhook = pickStore(db.upsertAgentWebhook, mem.upsertAgentWebhook);
export const getAgentWebhook = pickStore(db.getAgentWebhook, mem.getAgentWebhook);
export const deleteAgentWebhook = pickStore(db.deleteAgentWebhook, mem.deleteAgentWebhook);
export const claimNextWebhookDelivery = pickStore(db.claimNextWebhookDelivery, mem.claimNextWebhookDelivery);
export const recordWebhookAttempt = pickStore(db.recordWebhookAttempt, mem.recordWebhookAttempt);

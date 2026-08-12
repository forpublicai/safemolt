import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export type {
  CommentNotificationInput,
  FollowNotificationInput,
  NotificationProjection,
} from "./memory";

export const createNotification = pickStore(db.createNotification, mem.createNotification);

// M11-2 P2.1 — the consumer's content-anchored inserts and their shadow projections. There is no
// plain `createNotificationIdempotent`: every notification this milestone writes is anchored to a
// subject that can be deleted, so a bare insert with no locked target would be a footgun sitting
// beside the two functions that get it right.
export const createCommentNotificationIdempotent = pickStore(
  db.createCommentNotificationIdempotent,
  mem.createCommentNotificationIdempotent
);
export const createFollowNotificationIdempotent = pickStore(
  db.createFollowNotificationIdempotent,
  mem.createFollowNotificationIdempotent
);
// u4-prep amendment: the soak's drain-time twin read. Read-only, and paired with `describe*` above —
// the comparison diffs what the consumer WOULD write against what the legacy writer DID write.
export const readNotificationProjectionByDedupKey = pickStore(
  db.readNotificationProjectionByDedupKey,
  mem.readNotificationProjectionByDedupKey
);
export const describeCommentNotification = pickStore(db.describeCommentNotification, mem.describeCommentNotification);
export const describeFollowNotification = pickStore(db.describeFollowNotification, mem.describeFollowNotification);
export const deleteNotificationsAnchoredToPost = pickStore(
  db.deleteNotificationsAnchoredToPost,
  mem.deleteNotificationsAnchoredToPost
);
export const listNotifications = pickStore(db.listNotifications, mem.listNotifications);
export const markNotificationRead = pickStore(db.markNotificationRead, mem.markNotificationRead);
export const markAllNotificationsRead = pickStore(db.markAllNotificationsRead, mem.markAllNotificationsRead);
export const countUnreadNotifications = pickStore(db.countUnreadNotifications, mem.countUnreadNotifications);

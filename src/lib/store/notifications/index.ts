import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const createNotification = hasDatabase() ? db.createNotification : mem.createNotification;
export const listNotifications = hasDatabase() ? db.listNotifications : mem.listNotifications;
export const markNotificationRead = hasDatabase() ? db.markNotificationRead : mem.markNotificationRead;
export const markAllNotificationsRead = hasDatabase() ? db.markAllNotificationsRead : mem.markAllNotificationsRead;
export const countUnreadNotifications = hasDatabase() ? db.countUnreadNotifications : mem.countUnreadNotifications;

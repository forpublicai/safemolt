import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const createNotification = pickStore(db.createNotification, mem.createNotification);
export const listNotifications = pickStore(db.listNotifications, mem.listNotifications);
export const markNotificationRead = pickStore(db.markNotificationRead, mem.markNotificationRead);
export const markAllNotificationsRead = pickStore(db.markAllNotificationsRead, mem.markAllNotificationsRead);
export const countUnreadNotifications = pickStore(db.countUnreadNotifications, mem.countUnreadNotifications);

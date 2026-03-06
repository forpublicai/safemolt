"use client";

import { useState, useEffect } from "react";

interface Announcement {
    id: string;
    content: string;
    created_at: string;
}

export function AnnouncementBanner() {
    const [announcement, setAnnouncement] = useState<Announcement | null>(null);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        fetch("/api/v1/announcements")
            .then((res) => res.json())
            .then((json) => {
                if (json.success && json.data) {
                    const data = json.data as Announcement;
                    // Check sessionStorage for dismissed ID
                    const dismissedId = sessionStorage.getItem("safemolt_dismissed_announcement");
                    if (dismissedId === data.id + "_" + data.created_at) {
                        setDismissed(true);
                    }
                    setAnnouncement(data);
                }
            })
            .catch(() => {
                // Silently fail — no announcement is fine
            });
    }, []);

    if (!announcement || dismissed) return null;

    const handleDismiss = () => {
        setDismissed(true);
        sessionStorage.setItem(
            "safemolt_dismissed_announcement",
            announcement.id + "_" + announcement.created_at
        );
    };

    return (
        <div
            className="relative w-full border-b px-4 py-2.5 text-center text-sm font-medium"
            style={{
                background: "linear-gradient(135deg, #d4a857 0%, #c49a3c 50%, #b8902f 100%)",
                borderColor: "#a07828",
                color: "#2d2418",
            }}
        >
            <span className="mr-2" aria-hidden="true">📢</span>
            <span>{announcement.content}</span>
            <button
                onClick={handleDismiss}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 transition-colors hover:bg-black/10"
                aria-label="Dismiss announcement"
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 3L11 11M3 11L11 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            </button>
        </div>
    );
}

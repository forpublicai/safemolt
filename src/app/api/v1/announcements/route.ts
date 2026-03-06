/**
 * GET /api/v1/announcements — Get the current platform announcement (public)
 * POST /api/v1/announcements — Set a new announcement (admin only, requires ADMIN_SECRET)
 * DELETE /api/v1/announcements — Clear the current announcement (admin only)
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { getAnnouncement, setAnnouncement, clearAnnouncement } from '@/lib/store';

export async function GET() {
    const announcement = await getAnnouncement();
    return jsonResponse({
        success: true,
        data: announcement
            ? { id: announcement.id, content: announcement.content, created_at: announcement.createdAt }
            : null,
    });
}

function isAdmin(request: Request): boolean {
    const secret = request.headers.get('x-admin-secret') || '';
    const expected = process.env.ADMIN_SECRET;
    return Boolean(expected && secret === expected);
}

export async function POST(request: Request) {
    if (!isAdmin(request)) {
        return errorResponse('Forbidden', 'Valid X-Admin-Secret header required', 403);
    }

    try {
        const body = await request.json();
        const content = body?.content?.trim();
        if (!content) {
            return errorResponse('content is required');
        }
        if (content.length > 1000) {
            return errorResponse('Announcement must be 1000 characters or less');
        }

        const announcement = await setAnnouncement(content);
        return jsonResponse({
            success: true,
            data: {
                id: announcement.id,
                content: announcement.content,
                created_at: announcement.createdAt,
            },
        }, 201);
    } catch {
        return errorResponse('Failed to create announcement', undefined, 500);
    }
}

export async function DELETE(request: Request) {
    if (!isAdmin(request)) {
        return errorResponse('Forbidden', 'Valid X-Admin-Secret header required', 403);
    }

    await clearAnnouncement();
    return jsonResponse({ success: true, message: 'Announcement cleared' });
}

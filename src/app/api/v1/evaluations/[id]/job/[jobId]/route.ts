import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getCertificationJobById } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}/job/{jobId}
 * Poll certification job status
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; jobId: string }> }
) {
    try {
        const agent = await getAgentFromRequest(request);
        if (!agent) {
            return errorResponse("Unauthorized", "Provide a valid API key", 401);
        }

        const { id: evaluationId, jobId } = await params;

        // Get job
        const job = await getCertificationJobById(jobId);
        if (!job) {
            return errorResponse("Job not found", undefined, 404);
        }

        // Verify ownership
        if (job.agentId !== agent.id) {
            return errorResponse("Unauthorized", "This job belongs to another agent", 403);
        }

        // Verify evaluation match
        if (job.evaluationId !== evaluationId) {
            return errorResponse("Job mismatch", "Job does not match evaluation ID", 400);
        }

        // Build response based on status
        const response: Record<string, unknown> = {
            job_id: job.id,
            evaluation_id: job.evaluationId,
            status: job.status,
            created_at: job.createdAt,
        };

        if (job.submittedAt) {
            response.submitted_at = job.submittedAt;
        }

        if (job.status === 'completed' && job.judgeResponse) {
            response.result = {
                passed: (job.judgeResponse as { passed?: boolean }).passed ?? false,
                score: (job.judgeResponse as { totalScore?: number }).totalScore,
                max_score: (job.judgeResponse as { maxScore?: number }).maxScore,
                summary: (job.judgeResponse as { summary?: string }).summary,
            };
            response.completed_at = job.judgeCompletedAt;
            response.judge_model = job.judgeModel;
        }

        if (job.status === 'failed' && job.errorMessage) {
            response.error = job.errorMessage;
        }

        if (job.status === 'expired') {
            response.error = "Nonce expired before submission";
        }

        return jsonResponse(response);
    } catch (error) {
        console.error("[evaluations/job] Error:", error);
        return errorResponse("Failed to get job status", undefined, 500);
    }
}

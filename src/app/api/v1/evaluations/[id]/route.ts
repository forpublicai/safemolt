import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getEvaluationRegistration } from "@/lib/store";

/**
 * GET /api/v1/evaluations/{id}
 * Get evaluation details and current registration status
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        // Load evaluation definition
        const evaluation = getEvaluation(id);
        if (!evaluation) {
            return errorResponse("Evaluation not found", `No evaluation found with ID '${id}'`, 404);
        }

        const responseData: any = {
            id: evaluation.id,
            sip: evaluation.sip,
            name: evaluation.name,
            type: evaluation.type,
            status: evaluation.status,
            version: evaluation.version,
            points: evaluation.points,
            endpoints: {
                register: `/api/v1/evaluations/${id}/register`,
                start: `/api/v1/evaluations/${id}/start`,
                submit: `/api/v1/evaluations/${id}/submit`,
            }
        };

        // If authenticated, include registration status
        const agent = await getAgentFromRequest(request);
        if (agent) {
            const registration = await getEvaluationRegistration(agent.id, id);
            if (registration) {
                responseData.registration = {
                    id: registration.id,
                    status: registration.status,
                    registered_at: registration.registeredAt,
                    completed_at: registration.completedAt,
                };
            } else {
                responseData.registration = null;
            }
        }

        return jsonResponse({
            success: true,
            evaluation: responseData
        });

    } catch (error) {
        console.error("[evaluations/get] Error:", error);
        return errorResponse("Failed to fetch evaluation details", undefined, 500);
    }
}

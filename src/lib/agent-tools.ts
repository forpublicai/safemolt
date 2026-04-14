/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  createPost,
  createComment,
  getPost,
  listPosts,
  listComments,
  upvotePost,
  downvotePost,
  deletePost,
  pinPost,
  unpinPost,
  upvoteComment,
  searchPosts,
  getGroup,
  listGroups,
  joinGroup,
  leaveGroup,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
  addModerator,
  removeModerator,
  listModerators,
  getYourRole,
  listFeed,
  getAgentById,
  getAgentByName,
  updateAgent,
  followAgent,
  unfollowAgent,
  isFollowing,
  getFollowingCount,
  listClasses,
  enrollInClass,
  dropClass,
  getClassById,
  getClassEnrollments,
  listClassSessions,
  listClassEvaluations,
  getAgentClasses,
  addClassAssistant,
  removeClassAssistant,
  getClassAssistants,
  isClassAssistant,
  addClassSessionMessage,
  getClassSessionMessages,
  saveClassEvaluationResult,
  getStudentClassResults,
  getPassedEvaluations,
  registerForEvaluation,
  startEvaluation,
  getEvaluationRegistration,
  getEvaluationRegistrationById,
  getAllEvaluationResultsForAgent,
  getEvaluationResults,
  getEvaluationVersions,
  getPendingProctorRegistrations,
  claimProctorSession,
  getSession,
  getSessionMessages,
  addSessionMessage,
  saveEvaluationResult,
  listPlaygroundSessions,
  joinPlaygroundSession,
  getPlaygroundSession,
  getPlaygroundActions,
  createPlaygroundAction,
  activatePlaygroundSession,
  listSchools,
  getSchool,
  getAnnouncement,
  listHouses,
  getHouseByName,
  joinHouse,
  leaveHouse,
  getHouseMembership,
  getHouseWithDetails,
} from "@/lib/store";
import { listEvaluations } from "@/lib/evaluations/loader";
import { getGame, listGames } from "@/lib/playground/games";
import type { SessionStatus } from "@/lib/playground/types";
import type { StoredAgent } from "@/lib/store-types";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const PLATFORM_TOOLS: ToolDefinition[] = [
  // ======== Posts ========
  {
    type: "function",
    function: {
      name: "create_post",
      description: "Create a new post in a group. You must be a member of the group.",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name to post in (e.g. 'general')" },
          title: { type: "string", description: "Post title" },
          content: { type: "string", description: "Post body text (optional)" },
        },
        required: ["group_name", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_feed",
      description: "Browse recent posts from groups you're in and agents you follow.",
      parameters: {
        type: "object",
        properties: {
          sort: { type: "string", enum: ["new", "top", "hot"], description: "Sort order (default: new)" },
          limit: { type: "number", description: "Max posts to return (default: 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upvote_post",
      description: "Upvote a post you find valuable.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to upvote" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "downvote_post",
      description: "Downvote a post.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to downvote" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_post",
      description: "Delete one of your own posts.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to delete" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pin_post",
      description: "Pin a post in a group (must be a moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          post_id: { type: "string", description: "Post ID to pin" },
        },
        required: ["group_name", "post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unpin_post",
      description: "Unpin a post in a group (must be a moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          post_id: { type: "string", description: "Post ID to unpin" },
        },
        required: ["group_name", "post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_posts",
      description: "Search posts and comments by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: { type: "string", enum: ["posts", "comments", "all"], description: "What to search (default: all)" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
    },
  },
  // ======== Comments ========
  {
    type: "function",
    function: {
      name: "create_comment",
      description: "Comment on a post.",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "string", description: "ID of the post to comment on" },
          content: { type: "string", description: "Comment text" },
          parent_id: { type: "string", description: "Parent comment ID for replies (optional)" },
        },
        required: ["post_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_comments",
      description: "List comments on a post.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "Post ID" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upvote_comment",
      description: "Upvote a comment.",
      parameters: {
        type: "object",
        properties: { comment_id: { type: "string", description: "Comment ID to upvote" } },
        required: ["comment_id"],
      },
    },
  },
  // ======== Groups ========
  {
    type: "function",
    function: {
      name: "list_groups",
      description: "List all groups/communities on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "join_group",
      description: "Join a group to participate in its discussions.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Name of the group to join" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leave_group",
      description: "Leave a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Name of the group to leave" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "subscribe_to_group",
      description: "Subscribe to a group to get feed notifications without joining.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unsubscribe_from_group",
      description: "Unsubscribe from a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_group_role",
      description: "Get your role in a group (member, moderator, owner, or none).",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_moderators",
      description: "List moderators of a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_moderator",
      description: "Add a moderator to a group (must be group owner/moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          agent_name: { type: "string", description: "Agent handle to make moderator" },
        },
        required: ["group_name", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_moderator",
      description: "Remove a moderator from a group (must be group owner).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          agent_name: { type: "string", description: "Agent handle to remove as moderator" },
        },
        required: ["group_name", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_group_settings",
      description: "Update group settings (must be group moderator/owner).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          display_name: { type: "string", description: "New display name" },
          description: { type: "string", description: "New description" },
          emoji: { type: "string", description: "New emoji" },
        },
        required: ["group_name"],
      },
    },
  },
  // ======== Social / Profile ========
  {
    type: "function",
    function: {
      name: "follow_agent",
      description: "Follow another agent to see their posts in your feed.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Name (handle) of the agent to follow" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unfollow_agent",
      description: "Unfollow an agent.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle to unfollow" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_following",
      description: "Check if you are following another agent.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle to check" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_profile",
      description: "Get your own agent profile information.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_profile",
      description: "Get another agent's public profile.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_my_profile",
      description: "Update your agent's profile (display name, description).",
      parameters: {
        type: "object",
        properties: {
          display_name: { type: "string", description: "New display name" },
          description: { type: "string", description: "New bio/description" },
        },
      },
    },
  },
  // ======== Houses ========
  {
    type: "function",
    function: {
      name: "list_houses",
      description: "List all houses on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "join_house",
      description: "Join a house (you can only be in one house).",
      parameters: {
        type: "object",
        properties: { house_name: { type: "string", description: "House name to join" } },
        required: ["house_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leave_house",
      description: "Leave your current house.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_house",
      description: "Get your current house membership info.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ======== Classes ========
  {
    type: "function",
    function: {
      name: "list_classes",
      description: "List available classes with open enrollment.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "enroll_in_class",
      description: "Enroll in a class as a student.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "ID of the class to enroll in" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drop_class",
      description: "Drop a class you're enrolled in.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID to drop" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_classes",
      description: "List classes you're currently enrolled in.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_sessions",
      description: "List sessions (lectures, labs, exams) in a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_evaluations",
      description: "List evaluations/assignments in a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_enrollments",
      description: "List all enrollments for a class (useful for TAs).",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_class_session_message",
      description: "Send a message in a class session (lecture, lab, etc.).",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          content: { type: "string", description: "Message content" },
          role: { type: "string", enum: ["student", "ta"], description: "Your role (default: student)" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_class_session_messages",
      description: "Read messages from a class session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_class_assistants",
      description: "List teaching assistants for a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_class_evaluation",
      description: "Submit a response to a class evaluation/assignment.",
      parameters: {
        type: "object",
        properties: {
          evaluation_id: { type: "string", description: "Class evaluation ID" },
          response: { type: "string", description: "Your response/answer" },
        },
        required: ["evaluation_id", "response"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_class_results",
      description: "Get your evaluation results for a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  // ======== Evaluations (SIPs) ========
  {
    type: "function",
    function: {
      name: "list_evaluations",
      description: "List all available evaluations (SIPs) on the platform with their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_passed_evaluations",
      description: "List all evaluations you have passed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "register_for_evaluation",
      description: "Register for an evaluation (SIP). Prerequisites must be met first.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID (e.g. 'sip-2')" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_evaluation",
      description: "Start a registered evaluation. You must register first.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID you registered for" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_evaluation_results",
      description: "Get all your evaluation results across all SIPs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_evaluation_versions",
      description: "Get version history for an evaluation.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pending_proctor_registrations",
      description: "List agents waiting for a proctor for a given evaluation (for proctoring).",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_proctor_session",
      description: "Claim a proctor session for an agent's evaluation registration.",
      parameters: {
        type: "object",
        properties: { registration_id: { type: "string", description: "Registration ID to proctor" } },
        required: ["registration_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_eval_session",
      description: "Get details of an evaluation session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Evaluation session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_eval_session_messages",
      description: "Get messages from an evaluation session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Evaluation session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_eval_session_message",
      description: "Send a message in an evaluation session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Evaluation session ID" },
          content: { type: "string", description: "Message content" },
          role: { type: "string", description: "Your role (candidate or proctor)" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_evaluation_result",
      description: "Submit a pass/fail result for an evaluation you are proctoring.",
      parameters: {
        type: "object",
        properties: {
          registration_id: { type: "string", description: "Registration ID" },
          evaluation_id: { type: "string", description: "Evaluation ID" },
          agent_id: { type: "string", description: "Candidate agent ID" },
          passed: { type: "boolean", description: "Whether the candidate passed" },
          score: { type: "number", description: "Score (optional)" },
          max_score: { type: "number", description: "Max possible score (optional)" },
          feedback: { type: "string", description: "Proctor feedback (optional)" },
        },
        required: ["registration_id", "evaluation_id", "agent_id", "passed"],
      },
    },
  },
  // ======== Playground ========
  {
    type: "function",
    function: {
      name: "list_playground_games",
      description: "List available playground games/simulations.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_playground_sessions",
      description: "List playground sessions. Shows pending sessions you can join and active ones.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "active", "completed"], description: "Filter by status (default: pending)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "join_playground_session",
      description: "Join a pending playground session to participate in the simulation/game.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Playground session ID to join" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_playground_session",
      description: "Get details about a specific playground session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_playground_action",
      description: "Submit your action for the current round in a playground session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          content: { type: "string", description: "Your action/response for this round" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_playground_actions",
      description: "Get actions from a specific round of a playground session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          round: { type: "number", description: "Round number" },
        },
        required: ["session_id", "round"],
      },
    },
  },
  // ======== Schools ========
  {
    type: "function",
    function: {
      name: "list_schools",
      description: "List all schools on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_school",
      description: "Get details about a specific school.",
      parameters: {
        type: "object",
        properties: { school_id: { type: "string", description: "School ID (e.g. 'foundation')" } },
        required: ["school_id"],
      },
    },
  },
  // ======== Memory / Context ========
  {
    type: "function",
    function: {
      name: "list_context_files",
      description: "List your agent's context/memory files.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_context_file",
      description: "Read a context/memory file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path (e.g. 'notes.md')" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "put_context_file",
      description: "Write/update a context/memory file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (must end in .md)" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_context_file",
      description: "Delete a context/memory file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path to delete" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search your vector memory for relevant information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
  },
  // ======== Announcements ========
  {
    type: "function",
    function: {
      name: "get_announcement",
      description: "Get the current platform announcement (if any).",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  agent: StoredAgent
): Promise<ToolCallResult> {
  try {
    switch (toolName) {
      // ======== Posts ========
      case "create_post": {
        const groupName = String(args.group_name ?? "general");
        const group = await getGroup(groupName);
        if (!group) return { success: false, error: `Group "${groupName}" not found` };
        // createPost(authorId, groupId, title, content?, url?)
        const post = await createPost(
          agent.id,
          group.id,
          String(args.title),
          args.content ? String(args.content) : undefined
        );
        return { success: true, data: { post_id: post.id, title: post.title, group: groupName } };
      }

      case "list_feed": {
        const sort = (args.sort as string) || "new";
        const limit = Math.min(Number(args.limit) || 10, 15);
        const posts = await listFeed(agent.id, { sort, limit });
        const enriched = await Promise.all(
          posts.slice(0, 15).map(async (p) => {
            const author = await getAgentById(p.authorId);
            return {
              id: p.id,
              title: p.title,
              content: p.content?.slice(0, 200) ?? null,
              author: author?.displayName || author?.name || "unknown",
              upvotes: p.upvotes,
              comments: p.commentCount,
              created_at: p.createdAt,
            };
          })
        );
        return { success: true, data: { posts: enriched, count: enriched.length } };
      }

      case "upvote_post": {
        const ok = await upvotePost(String(args.post_id), agent.id);
        return ok
          ? { success: true, data: { voted: true } }
          : { success: false, error: "Could not upvote (already voted or post not found)" };
      }

      case "downvote_post": {
        const ok = await downvotePost(String(args.post_id), agent.id);
        return ok
          ? { success: true, data: { voted: true } }
          : { success: false, error: "Could not downvote (already voted or post not found)" };
      }

      case "delete_post": {
        const ok = await deletePost(String(args.post_id), agent.id);
        return ok
          ? { success: true, data: { deleted: true } }
          : { success: false, error: "Post not found or not yours" };
      }

      case "pin_post": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const ok = await pinPost(group.id, String(args.post_id), agent.id);
        return ok
          ? { success: true, data: { pinned: true } }
          : { success: false, error: "Could not pin (not a moderator or post not found)" };
      }

      case "unpin_post": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const ok = await unpinPost(group.id, String(args.post_id), agent.id);
        return ok
          ? { success: true, data: { unpinned: true } }
          : { success: false, error: "Could not unpin" };
      }

      case "search_posts": {
        const q = String(args.query);
        const type = (args.type as "posts" | "comments" | "all") || "all";
        const limit = Math.min(Number(args.limit) || 10, 20);
        const results = await searchPosts(q, { type, limit });
        const mapped = results.slice(0, limit).map((r) => {
          if (r.type === "post") {
            return { type: "post", id: r.post.id, title: r.post.title, content: r.post.content?.slice(0, 150) };
          }
          return { type: "comment", id: r.comment.id, content: r.comment.content.slice(0, 150), post_id: r.post.id };
        });
        return { success: true, data: { results: mapped, count: mapped.length } };
      }

      // ======== Comments ========
      case "create_comment": {
        const postId = String(args.post_id);
        const post = await getPost(postId);
        if (!post) return { success: false, error: "Post not found" };
        const comment = await createComment(
          postId,
          agent.id,
          String(args.content),
          args.parent_id ? String(args.parent_id) : undefined
        );
        if (!comment) return { success: false, error: "Could not create comment" };
        return { success: true, data: { comment_id: comment.id, post_id: postId } };
      }

      case "list_comments": {
        const comments = await listComments(String(args.post_id));
        const enriched = await Promise.all(
          comments.slice(0, 20).map(async (c) => {
            const author = await getAgentById(c.authorId);
            return {
              id: c.id,
              content: c.content.slice(0, 200),
              author: author?.displayName || author?.name || "unknown",
              upvotes: c.upvotes,
              created_at: c.createdAt,
            };
          })
        );
        return { success: true, data: { comments: enriched } };
      }

      case "upvote_comment": {
        const ok = await upvoteComment(String(args.comment_id), agent.id);
        return ok
          ? { success: true, data: { voted: true } }
          : { success: false, error: "Could not upvote comment" };
      }

      // ======== Groups ========
      case "list_groups": {
        const groups = await listGroups();
        return {
          success: true,
          data: {
            groups: groups.map((g) => ({
              name: g.name,
              display_name: g.displayName,
              description: g.description?.slice(0, 100),
              type: g.type,
              emoji: g.emoji,
            })),
          },
        };
      }

      case "join_group": {
        const groupName = String(args.group_name);
        const group = await getGroup(groupName);
        if (!group) return { success: false, error: `Group "${groupName}" not found` };
        const result = await joinGroup(agent.id, group.id);
        if (typeof result === "object" && "error" in result) {
          return { success: false, error: String(result.error) };
        }
        return { success: true, data: { joined: groupName } };
      }

      case "leave_group": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const result = await leaveGroup(agent.id, group.id);
        if (typeof result === "object" && "error" in result) {
          return { success: false, error: String(result.error) };
        }
        return { success: true, data: { left: args.group_name } };
      }

      case "subscribe_to_group": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        await subscribeToGroup(agent.id, group.id);
        return { success: true, data: { subscribed: args.group_name } };
      }

      case "unsubscribe_from_group": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        await unsubscribeFromGroup(agent.id, group.id);
        return { success: true, data: { unsubscribed: args.group_name } };
      }

      case "get_my_group_role": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const role = await getYourRole(group.id, agent.id);
        return { success: true, data: { group: args.group_name, role } };
      }

      case "list_moderators": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const mods = await listModerators(group.id);
        return {
          success: true,
          data: { moderators: mods.map((m) => ({ name: m.name, display_name: m.displayName })) },
        };
      }

      case "add_moderator": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        // addModerator(groupId, ownerId, agentName) — ownerId is the caller, agentName is the target
        const ok = await addModerator(group.id, agent.id, String(args.agent_name));
        return ok
          ? { success: true, data: { added_moderator: args.agent_name } }
          : { success: false, error: "Could not add moderator (must be group owner)" };
      }

      case "remove_moderator": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        // removeModerator(groupId, ownerId, agentName) — ownerId is the caller, agentName is the target
        const ok = await removeModerator(group.id, agent.id, String(args.agent_name));
        return ok
          ? { success: true, data: { removed_moderator: args.agent_name } }
          : { success: false, error: "Could not remove moderator (must be group owner)" };
      }

      case "update_group_settings": {
        const group = await getGroup(String(args.group_name));
        if (!group) return { success: false, error: "Group not found" };
        const updates: Record<string, string> = {};
        if (args.display_name) updates.displayName = String(args.display_name);
        if (args.description) updates.description = String(args.description);
        if (args.emoji) updates.emoji = String(args.emoji);
        const updated = await updateGroupSettings(group.id, updates);
        return updated
          ? { success: true, data: { updated: args.group_name } }
          : { success: false, error: "Could not update group settings" };
      }

      // ======== Social / Profile ========
      case "follow_agent": {
        const targetName = String(args.agent_name);
        const target = await getAgentByName(targetName);
        if (!target) return { success: false, error: `Agent "@${targetName}" not found` };
        if (target.id === agent.id) return { success: false, error: "Cannot follow yourself" };
        await followAgent(agent.id, targetName);
        return { success: true, data: { following: targetName } };
      }

      case "unfollow_agent": {
        const targetName = String(args.agent_name);
        const target = await getAgentByName(targetName);
        if (!target) return { success: false, error: `Agent "@${targetName}" not found` };
        await unfollowAgent(agent.id, targetName);
        return { success: true, data: { unfollowed: targetName } };
      }

      case "check_following": {
        const targetName = String(args.agent_name);
        const target = await getAgentByName(targetName);
        if (!target) return { success: false, error: "Agent not found" };
        const following = await isFollowing(agent.id, targetName);
        return { success: true, data: { following } };
      }

      case "get_my_profile": {
        const followingCount = await getFollowingCount(agent.id);
        return {
          success: true,
          data: {
            name: agent.name,
            display_name: agent.displayName,
            description: agent.description,
            points: agent.points,
            followers: agent.followerCount,
            following: followingCount,
            is_vetted: agent.isVetted,
            is_admitted: agent.isAdmitted,
          },
        };
      }

      case "get_agent_profile": {
        const target = await getAgentByName(String(args.agent_name));
        if (!target) return { success: false, error: "Agent not found" };
        return {
          success: true,
          data: {
            name: target.name,
            display_name: target.displayName,
            description: target.description,
            points: target.points,
            followers: target.followerCount,
            is_vetted: target.isVetted,
            is_admitted: target.isAdmitted,
          },
        };
      }

      case "update_my_profile": {
        const updates: { displayName?: string; description?: string } = {};
        if (args.display_name) updates.displayName = String(args.display_name);
        if (args.description) updates.description = String(args.description);
        await updateAgent(agent.id, updates);
        return { success: true, data: { updated: true, ...updates } };
      }

      // ======== Houses ========
      case "list_houses": {
        const houses = await listHouses();
        return {
          success: true,
          data: {
            houses: houses.map((h) => ({
              id: h.id,
              name: h.name,
              founder_id: h.founderId,
              points: h.points,
            })),
          },
        };
      }

      case "join_house": {
        const house = await getHouseByName(String(args.house_name));
        if (!house) return { success: false, error: "House not found" };
        const ok = await joinHouse(agent.id, house.id);
        return ok
          ? { success: true, data: { joined: args.house_name } }
          : { success: false, error: "Could not join house (already in a house?)" };
      }

      case "leave_house": {
        const membership = await getHouseMembership(agent.id);
        if (!membership) return { success: false, error: "Not in a house" };
        await leaveHouse(agent.id);
        return { success: true, data: { left: true } };
      }

      case "get_my_house": {
        const membership = await getHouseMembership(agent.id);
        if (!membership) return { success: true, data: { house: null } };
        const house = await getHouseWithDetails(membership.houseId);
        return {
          success: true,
          data: {
            house: house
              ? { name: house.name, points: house.points, member_count: house.memberCount }
              : null,
          },
        };
      }

      // ======== Classes ========
      case "list_classes": {
        const classes = await listClasses({ enrollmentOpen: true });
        return {
          success: true,
          data: {
            classes: classes.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description?.slice(0, 100),
              status: c.status,
              enrollment_open: c.enrollmentOpen,
            })),
          },
        };
      }

      case "enroll_in_class": {
        const classId = String(args.class_id);
        const cls = await getClassById(classId);
        if (!cls) return { success: false, error: "Class not found" };
        if (!cls.enrollmentOpen) return { success: false, error: "Enrollment is closed for this class" };
        const enrollment = await enrollInClass(classId, agent.id);
        return { success: true, data: { class_id: classId, class_name: cls.name, enrollment_id: enrollment.id } };
      }

      case "drop_class": {
        const ok = await dropClass(String(args.class_id), agent.id);
        return ok
          ? { success: true, data: { dropped: true } }
          : { success: false, error: "Not enrolled or already dropped" };
      }

      case "list_my_classes": {
        const enrolled = await getAgentClasses(agent.id);
        const enriched = await Promise.all(
          enrolled.map(async (e) => {
            const cls = await getClassById(e.classId);
            return { class_id: e.classId, name: cls?.name ?? "?", status: e.status };
          })
        );
        return { success: true, data: { classes: enriched } };
      }

      case "list_class_sessions": {
        const sessions = await listClassSessions(String(args.class_id));
        return {
          success: true,
          data: {
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title,
              type: s.type,
              status: s.status,
              sequence: s.sequence,
            })),
          },
        };
      }

      case "list_class_evaluations": {
        const evals = await listClassEvaluations(String(args.class_id));
        return {
          success: true,
          data: {
            evaluations: evals.map((e) => ({
              id: e.id,
              title: e.title,
              description: e.description?.slice(0, 100),
              status: e.status,
            })),
          },
        };
      }

      case "list_class_enrollments": {
        const enrollments = await getClassEnrollments(String(args.class_id));
        const enriched = await Promise.all(
          enrollments.map(async (e) => {
            const a = await getAgentById(e.agentId);
            return { agent_name: a?.name ?? "?", status: e.status, enrolled_at: e.enrolledAt };
          })
        );
        return { success: true, data: { enrollments: enriched } };
      }

      case "send_class_session_message": {
        const role = (args.role as "student" | "ta") || "student";
        const msg = await addClassSessionMessage(
          String(args.session_id),
          agent.id,
          role,
          String(args.content)
        );
        return { success: true, data: { message_id: msg.id, sequence: msg.sequence } };
      }

      case "get_class_session_messages": {
        const msgs = await getClassSessionMessages(String(args.session_id));
        return {
          success: true,
          data: {
            messages: msgs.slice(0, 50).map((m) => ({
              id: m.id,
              sender: m.senderName ?? m.senderId,
              role: m.senderRole,
              content: m.content.slice(0, 500),
              sequence: m.sequence,
            })),
          },
        };
      }

      case "get_class_assistants": {
        const assistants = await getClassAssistants(String(args.class_id));
        const enriched = await Promise.all(
          assistants.map(async (a) => {
            const ag = await getAgentById(a.agentId);
            return { agent_name: ag?.name ?? "?", display_name: ag?.displayName, assigned_at: a.assignedAt };
          })
        );
        return { success: true, data: { assistants: enriched } };
      }

      case "submit_class_evaluation": {
        const result = await saveClassEvaluationResult(
          String(args.evaluation_id),
          agent.id,
          String(args.response)
        );
        return { success: true, data: { result_id: result.id, completed_at: result.completedAt } };
      }

      case "get_my_class_results": {
        const results = await getStudentClassResults(String(args.class_id), agent.id);
        return {
          success: true,
          data: {
            results: results.map((r) => ({
              evaluation_id: r.evaluationId,
              score: r.score,
              max_score: r.maxScore,
              feedback: r.feedback?.slice(0, 200),
              completed_at: r.completedAt,
            })),
          },
        };
      }

      // ======== Evaluations (SIPs) ========
      case "list_evaluations": {
        const evals = listEvaluations("foundation", undefined, "active");
        const passed = await getPassedEvaluations(agent.id);
        const enriched = await Promise.all(
          evals.map(async (e) => {
            const hasPassed = passed.includes(e.id);
            const reg = await getEvaluationRegistration(agent.id, e.id);
            return {
              id: e.id,
              name: e.name,
              description: e.description?.slice(0, 150),
              module: e.module,
              sip: e.sip,
              has_passed: hasPassed,
              registration_status: hasPassed ? "completed" : reg?.status ?? "available",
              prerequisites: e.prerequisites,
            };
          })
        );
        return { success: true, data: { evaluations: enriched } };
      }

      case "list_passed_evaluations": {
        const passed = await getPassedEvaluations(agent.id);
        return { success: true, data: { passed_evaluation_ids: passed } };
      }

      case "register_for_evaluation": {
        const evalId = String(args.evaluation_id);
        const existing = await getEvaluationRegistration(agent.id, evalId);
        if (existing) {
          return { success: true, data: { registration_id: existing.id, status: existing.status, note: "Already registered" } };
        }
        const reg = await registerForEvaluation(agent.id, evalId);
        return { success: true, data: { registration_id: reg.id, registered_at: reg.registeredAt } };
      }

      case "start_evaluation": {
        const evalId = String(args.evaluation_id);
        const reg = await getEvaluationRegistration(agent.id, evalId);
        if (!reg) return { success: false, error: "Not registered for this evaluation. Register first." };
        if (reg.status === "in_progress") return { success: true, data: { registration_id: reg.id, status: "in_progress", note: "Already in progress" } };
        if (reg.status !== "registered") return { success: false, error: `Cannot start — current status: ${reg.status}` };
        await startEvaluation(reg.id);
        return { success: true, data: { registration_id: reg.id, status: "in_progress", note: "Evaluation started. Follow the evaluation-specific flow to complete it." } };
      }

      case "get_my_evaluation_results": {
        const results = await getAllEvaluationResultsForAgent(agent.id);
        return {
          success: true,
          data: {
            evaluations: results.map((r) => ({
              evaluation_id: r.evaluationId,
              name: r.evaluationName,
              sip: r.sip,
              points: r.points,
              has_passed: r.hasPassed,
              attempts: r.results?.length ?? 0,
            })),
          },
        };
      }

      case "get_evaluation_versions": {
        const versions = await getEvaluationVersions(String(args.evaluation_id));
        return { success: true, data: { evaluation_id: args.evaluation_id, versions } };
      }

      case "list_pending_proctor_registrations": {
        const pending = await getPendingProctorRegistrations(String(args.evaluation_id));
        return {
          success: true,
          data: {
            registrations: pending.map((p) => ({
              registration_id: p.registrationId,
              agent_id: p.agentId,
              agent_name: p.agentName,
            })),
          },
        };
      }

      case "claim_proctor_session": {
        const sessionId = await claimProctorSession(String(args.registration_id), agent.id);
        return { success: true, data: { session_id: sessionId } };
      }

      case "get_eval_session": {
        const session = await getSession(String(args.session_id));
        if (!session) return { success: false, error: "Session not found" };
        return { success: true, data: session };
      }

      case "get_eval_session_messages": {
        const msgs = await getSessionMessages(String(args.session_id));
        return {
          success: true,
          data: {
            messages: msgs.slice(0, 50).map((m) => ({
              id: m.id,
              sender: m.senderAgentId,
              role: m.role,
              content: m.content.slice(0, 500),
              sequence: m.sequence,
            })),
          },
        };
      }

      case "send_eval_session_message": {
        const role = String(args.role ?? "candidate");
        const msg = await addSessionMessage(
          String(args.session_id),
          agent.id,
          role,
          String(args.content)
        );
        return { success: true, data: { message_id: msg.id, sequence: msg.sequence } };
      }

      case "submit_evaluation_result": {
        await saveEvaluationResult(
          String(args.registration_id),
          String(args.agent_id),
          String(args.evaluation_id),
          Boolean(args.passed),
          args.score != null ? Number(args.score) : undefined,
          args.max_score != null ? Number(args.max_score) : undefined,
          undefined, // resultData
          agent.id, // proctorAgentId
          args.feedback ? String(args.feedback) : undefined,
        );
        return { success: true, data: { submitted: true, passed: Boolean(args.passed) } };
      }

      // ======== Playground ========
      case "list_playground_games": {
        const games = listGames();
        return {
          success: true,
          data: {
            games: games.map((g) => ({
              id: g.id,
              name: g.name,
              description: g.description?.slice(0, 150),
              min_players: g.minPlayers,
              max_players: g.maxPlayers,
              max_rounds: g.defaultMaxRounds,
            })),
          },
        };
      }

      case "list_playground_sessions": {
        const status = (args.status as SessionStatus) || "pending";
        const sessions = await listPlaygroundSessions({ status, limit: 10 });
        return {
          success: true,
          data: {
            sessions: sessions.map((s) => {
              const game = getGame(s.gameId);
              return {
                id: s.id,
                game_id: s.gameId,
                game_name: game?.name ?? s.gameId,
                status: s.status,
                participants: s.participants?.length ?? 0,
                max_players: game?.maxPlayers ?? null,
                current_round: s.currentRound,
                created_at: s.createdAt,
              };
            }),
          },
        };
      }

      case "join_playground_session": {
        const sessionId = String(args.session_id);
        const pending = await listPlaygroundSessions({ status: "pending", limit: 50 });
        const target = pending.find((s) => s.id === sessionId);
        if (!target) return { success: false, error: "Session not found or not in 'pending' state" };
        const game = getGame(target.gameId);
        const maxPlayers = game?.maxPlayers ?? 8;
        const result = await joinPlaygroundSession(sessionId, {
          agentId: agent.id,
          agentName: agent.displayName || agent.name,
          status: "active",
        }, maxPlayers);
        if (!result.success) return { success: false, error: result.reason ?? "Could not join session" };
        return { success: true, data: { session_id: sessionId, joined: true, participants: result.session?.participants?.length } };
      }

      case "get_playground_session": {
        const session = await getPlaygroundSession(String(args.session_id));
        if (!session) return { success: false, error: "Session not found" };
        const game = getGame(session.gameId);
        return {
          success: true,
          data: {
            id: session.id,
            game_name: game?.name ?? session.gameId,
            status: session.status,
            current_round: session.currentRound,
            max_rounds: session.maxRounds,
            participants: session.participants?.map((p) => ({ name: p.agentName, status: p.status })),
            round_deadline: session.roundDeadline,
          },
        };
      }

      case "submit_playground_action": {
        const sessionId = String(args.session_id);
        const session = await getPlaygroundSession(sessionId);
        if (!session) return { success: false, error: "Session not found" };
        if (session.status !== "active") return { success: false, error: "Session is not active" };
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const action = await createPlaygroundAction({
          id: actionId,
          sessionId,
          agentId: agent.id,
          round: session.currentRound,
          content: String(args.content),
        });
        return { success: true, data: { action_id: action.id, round: action.round } };
      }

      case "get_playground_actions": {
        const actions = await getPlaygroundActions(String(args.session_id), Number(args.round));
        return {
          success: true,
          data: {
            actions: actions.map((a) => ({
              id: a.id,
              agent_id: a.agentId,
              round: a.round,
              content: a.content.slice(0, 500),
              created_at: a.createdAt,
            })),
          },
        };
      }

      // ======== Schools ========
      case "list_schools": {
        const schools = await listSchools();
        return {
          success: true,
          data: {
            schools: schools.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description?.slice(0, 100),
              status: s.status,
              access: s.access,
              emoji: s.emoji,
            })),
          },
        };
      }

      case "get_school": {
        const school = await getSchool(String(args.school_id));
        if (!school) return { success: false, error: "School not found" };
        return {
          success: true,
          data: {
            id: school.id,
            name: school.name,
            description: school.description,
            status: school.status,
            access: school.access,
            required_evaluations: school.requiredEvaluations,
            emoji: school.emoji,
          },
        };
      }

      // ======== Memory / Context ========
      case "list_context_files": {
        const { listContextPaths } = await import("@/lib/memory/context-store");
        const paths = await listContextPaths(agent.id);
        return { success: true, data: { files: paths } };
      }

      case "get_context_file": {
        const { getContextFile } = await import("@/lib/memory/context-store");
        const content = await getContextFile(agent.id, String(args.path));
        if (content === null || content === undefined) return { success: false, error: "File not found" };
        return { success: true, data: { path: args.path, content } };
      }

      case "put_context_file": {
        const { putContextAndMaybeIndex } = await import("@/lib/memory/memory-service");
        const result = await putContextAndMaybeIndex(agent.id, String(args.path), String(args.content));
        if ("error" in result) return { success: false, error: String(result.error) };
        return { success: true, data: { path: result.path, saved: true } };
      }

      case "delete_context_file": {
        const { deleteContextAndIndex } = await import("@/lib/memory/memory-service");
        const result = await deleteContextAndIndex(agent.id, String(args.path));
        return result.ok
          ? { success: true, data: { deleted: true } }
          : { success: false, error: result.error ?? "Could not delete" };
      }

      case "recall_memory": {
        const { recallMemoryForAgent } = await import("@/lib/memory/memory-service");
        const limit = Math.min(Number(args.limit) || 5, 10);
        const results = await recallMemoryForAgent(agent.id, "semantic", String(args.query), limit);
        return {
          success: true,
          data: {
            results: results.map((r) => ({
              id: r.id,
              text: r.text.slice(0, 300),
              score: r.score,
            })),
          },
        };
      }

      // ======== Announcements ========
      case "get_announcement": {
        const ann = await getAnnouncement();
        return { success: true, data: { announcement: ann ?? null } };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`[agent-tools] ${toolName} error:`, e);
    return { success: false, error: e instanceof Error ? e.message : "Tool execution failed" };
  }
}

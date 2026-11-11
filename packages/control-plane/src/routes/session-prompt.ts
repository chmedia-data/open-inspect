import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  callbackContextSchema,
  sendPromptRequestSchema,
  type CallbackContext,
} from "@open-inspect/shared/types/session-api";
import { promptValidationError } from "@open-inspect/shared/types/prompts";
import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  sessionAttachmentReferencesSchema,
  type SessionAttachmentReference,
} from "@open-inspect/shared/types/session-attachments";
import {
  applyIdentityEnforcement,
  mayAttachCallbackContext,
} from "../routing/identity-enforcement";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import { SessionIndexStore } from "../db/session-index";
import { SessionMemorySelectionStore } from "../db/session-memory-selections";
import {
  isPersonalAccessTokenWithoutPersonalMemory,
  PERSONAL_MEMORY_PERMISSION_REQUIRED,
} from "../authorization/personal-access-token-policy";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { resolveGitHubEnrichmentForRequest, type GitHubEnrichment } from "../session/identity";
import type { Env } from "../types";
import { error, json, GITHUB_USER_OR_SERVICE_ROUTE, requireSession } from "./shared";
import { parseJsonBody } from "./body";
import { type SessionRouteContext, dispatchSession } from "./session-route";

const logger = createLogger("router:session-prompt");

function validateAttachments(raw: unknown): SessionAttachmentReference[] | Response | undefined {
  if (raw === undefined) return undefined;
  const result = sessionAttachmentReferencesSchema.safeParse(raw);
  if (!result.success) {
    if (Array.isArray(raw) && raw.length > MAX_SESSION_ATTACHMENTS_PER_MESSAGE) {
      return error(
        `You can attach up to ${MAX_SESSION_ATTACHMENTS_PER_MESSAGE} files per message`,
        400
      );
    }
    return error("Invalid attachments", 400);
  }
  return result.data;
}

export async function handleSessionPrompt(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

  const rawBody = await parseJsonBody(request);
  if (rawBody instanceof Response) return rawBody;

  const enforcement = applyIdentityEnforcement(ctx, "prompt", rawBody);
  if (enforcement.rejection) return enforcement.rejection;

  const bodyResult = sendPromptRequestSchema.safeParse(rawBody);
  if (!bodyResult.success) {
    return json(promptValidationError(bodyResult.error, rawBody), 400);
  }
  const body = bodyResult.data;

  const attachments = validateAttachments(body.attachments);
  if (attachments instanceof Response) return attachments;

  let callbackContext: CallbackContext | undefined;
  if (mayAttachCallbackContext(ctx) && body.callbackContext !== undefined) {
    const callbackContextResult = callbackContextSchema.safeParse(body.callbackContext);
    if (!callbackContextResult.success) {
      return error("Invalid callbackContext", 400);
    }
    callbackContext = callbackContextResult.data;
  }

  // The author comes from the verified principal (user → canonical id, bot →
  // asserted actor); an actorless bot prompt is system-initiated and stays
  // anonymous. callbackContext is a completion notification channel — only
  // the bots that own callbacks may attach one.
  const authorId = enforcement.enforced.participantUserId ?? "anonymous";
  const canonicalUserId = enforcement.enforced.canonicalUserId ?? undefined;
  if (callbackContext === undefined && body.callbackContext !== undefined) {
    logger.warn("Dropped callbackContext from unauthorized principal", {
      event: "identity.callback_context_dropped",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  // A prompt runs with the session owner's personal memory when the session includes it, and that
  // memory is authorized from the owner's live role, not the token's grant. Refused whoever the
  // personal owner is: an account merge can later make another user's personal memory the token
  // owner's while the prompt is still queued.
  if (
    isPersonalAccessTokenWithoutPersonalMemory(ctx) &&
    (await new SessionMemorySelectionStore(ctx.db).personalOwner(sessionId)) !== null
  ) {
    return json(PERSONAL_MEMORY_PERMISSION_REQUIRED, 403);
  }

  let enrichment: GitHubEnrichment | undefined;
  if (canonicalUserId) {
    enrichment =
      (await resolveGitHubEnrichmentForRequest(
        new UserStore(ctx.db),
        canonicalUserId,
        await resolveGitHubCredentialAuthority(ctx, request.headers)
      )) ?? undefined;
  }

  const promptRequest = {
    content: body.content,
    authorId,
    canonicalUserId,
    mcpEligible:
      !!canonicalUserId &&
      (ctx.principal?.kind === "user" ||
        (ctx.principal?.kind === "service" &&
          ctx.principal.service === "slack-bot" &&
          !!ctx.principal.actor) ||
        // A token uses its owner's personal connections only when its grant says so: the
        // connection's reach at the external service is beyond what any grant can narrow.
        (ctx.principal?.kind === "personal-access-token" &&
          (ctx.authorization?.permissions.includes("mcp_connections.use") ?? false))),
    source: body.source || "web",
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    attachments,
    callbackContext,
    scmEnrichment: enrichment
      ? {
          userId: enrichment.scmUserId,
          login: enrichment.scmLogin ?? null,
          name: enrichment.displayName ?? null,
          email: enrichment.email ?? null,
        }
      : undefined,
  } satisfies EnqueuePromptRequest;

  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.prompt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(promptRequest),
  });

  const store = new SessionIndexStore(ctx.db);
  ctx.executionCtx.submit(
    () =>
      store.touchUpdatedAt(sessionId).catch((error) => {
        logger.error("session_index.touch_updated_at.background_error", {
          session_id: sessionId,
          trace_id: ctx.trace_id,
          request_id: ctx.request_id,
          error,
        });
      }),
    {
      name: "session_index.touch_updated_at",
      context: { session_id: sessionId, trace_id: ctx.trace_id, request_id: ctx.request_id },
    }
  );

  return response;
}

export const sessionPromptRoutes = new Hono<ControlPlaneHonoEnv>();

sessionPromptRoutes.post(
  "/sessions/:id/prompt",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("collaborate"),
    // A token prompts as its owner, so the message is authored by the owner as if sent from
    // the browser. The grant must hold sessions.collaborate.
    personalAccessTokens: "accept",
  }),
  (c) => dispatchSession(c, handleSessionPrompt)
);

import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import type { AutomationRow } from "../db/automation-store";
import { enqueueAutomationFirstPrompt, isSessionPromptRequestQueued } from "./session-prompt";

const context = { trace_id: "trace-1", request_id: "request-1" };

function envWithResponse(response: () => Response): Env {
  return {
    SESSION: async () => response(),
  } as unknown as Env;
}

describe("isSessionPromptRequestQueued", () => {
  it.each([
    {
      name: "the runtime's missing-session response",
      response: () => Response.json({ error: "Session not found" }, { status: 404 }),
    },
    { name: "an unknown 404", response: () => new Response("Not Found", { status: 404 }) },
    {
      name: "a transient failure",
      response: () => Response.json({ error: "Session not found" }, { status: 503 }),
    },
  ])("fails closed for $name", async ({ response }) => {
    const env = envWithResponse(response);

    await expect(
      isSessionPromptRequestQueued(env, "session-1", "prompt-1", context)
    ).rejects.toThrow("Prompt request lookup failed");
  });
});

describe("enqueueAutomationFirstPrompt", () => {
  async function firstPromptBody(mcpEligible: boolean | undefined) {
    let body: Record<string, unknown> = {};
    const env = {
      SESSION: async (_sessionId: string, request: Request) => {
        body = await request.json();
        return Response.json({ messageId: "message-1", status: "queued" });
      },
    } as unknown as Env;
    await enqueueAutomationFirstPrompt(env, {
      sessionId: "session-1",
      automation: { id: "auto-1", name: "Report", instructions: "Summarize" } as AutomationRow,
      runId: "run-1",
      executionPrincipal: {
        platformUserId: "owner-1",
        participantUserId: "author-1",
        scmEnrichment: null,
        ...(mcpEligible === undefined ? {} : { mcpEligible }),
      },
    });
    return body;
  }

  it("lets the first prompt act as the owner only when admission found it eligible", async () => {
    expect(await firstPromptBody(true)).toMatchObject({
      canonicalUserId: "owner-1",
      source: "automation",
      mcpEligible: true,
    });
    expect(await firstPromptBody(false)).not.toHaveProperty("mcpEligible");
    expect(await firstPromptBody(undefined)).not.toHaveProperty("mcpEligible");
  });
});

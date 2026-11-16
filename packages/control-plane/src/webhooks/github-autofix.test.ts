import { describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";

const URL = "https://test.local/internal/github-autofix";

const envelope = {
  version: 1,
  deliveryId: "delivery-1",
  repository: { id: "42", owner: "octo", name: "repo" },
  pullRequestNumber: 7,
  receivedAt: "2026-11-16T10:00:00.000Z",
  eventType: "pull_request_review",
  action: "submitted",
  providerObject: { kind: "review", id: "99" },
};

function createEnv() {
  const send = vi.fn(async () => {});
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  const DB = { prepare: vi.fn(() => statement), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
  return { env: { ...TEST_SERVICE_SECRETS, SCM_PROVIDER: "github", DB, JOBS: { send } }, send };
}

async function post(body: string, service: "github-bot" | "slack-bot" = "github-bot") {
  const { env, send } = createEnv();
  const request = await signedServiceRequest(URL, { method: "POST", body, service });
  const response = await handleRequest(request, env as never, TEST_BACKGROUND_TASK_CONTEXT);
  return { response, send };
}

describe("POST /internal/github-autofix", () => {
  it("enqueues a valid envelope as a github.autofix job", async () => {
    const { response, send } = await post(JSON.stringify(envelope));

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledWith({ kind: "github.autofix", payload: envelope });
  });

  it("rejects an invalid envelope without enqueueing", async () => {
    const { response, send } = await post(JSON.stringify({ ...envelope, version: 2 }));

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses services other than the github-bot", async () => {
    const { response, send } = await post(JSON.stringify(envelope), "slack-bot");

    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});

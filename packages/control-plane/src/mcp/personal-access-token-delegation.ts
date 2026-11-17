import {
  personalAccessTokenEffectiveExpiry,
  personalAccessTokenPolicyAllows,
} from "@open-inspect/shared/types/personal-access-tokens";
import { AuthorizationService } from "../authorization/service";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import type { SqlDatabase } from "../db/sql-database";
import { McpError } from "./errors";

const PERSONAL_MCP_PERMISSION = "mcp_connections.use";

/**
 * Whether the token a prompt was admitted under still delegates `userId`'s personal MCP
 * connections: it exists, belongs to `userId`, has not expired under its own expiry or the
 * workspace lifetime cap, tokens are enabled, and both the workspace ceiling and the token's
 * grant still include `mcp_connections.use`, as does the owner's live role. Checked wherever
 * the owner's access is, so revoking or narrowing a token stops work it queued.
 */
export async function assertPersonalAccessTokenDelegation(
  db: SqlDatabase,
  tokenId: string,
  userId: string,
  now = Date.now()
): Promise<void> {
  const [credential, policy, authorization] = await Promise.all([
    new PersonalAccessTokenStore(db).findById(tokenId),
    new PersonalAccessTokenPolicyStore(db).get(),
    new AuthorizationService(db).getEffectiveAuthorization(userId),
  ]);
  if (
    !credential ||
    credential.userId !== userId ||
    personalAccessTokenEffectiveExpiry(credential, policy) <= now ||
    !policy.enabled ||
    !personalAccessTokenPolicyAllows(policy, PERSONAL_MCP_PERMISSION) ||
    !credential.grant.includes(PERSONAL_MCP_PERMISSION) ||
    !authorization.permissions.includes(PERSONAL_MCP_PERMISSION)
  )
    throw new McpError("mcp_denied");
}

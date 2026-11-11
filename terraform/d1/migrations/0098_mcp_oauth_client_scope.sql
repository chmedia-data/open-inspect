-- The scope a personal MCP connection requests: the protected resource's
-- scopes_supported (RFC 9728) as one space-separated string, recorded when the
-- client is resolved. '' means the resource publishes none; NULL marks a client
-- resolved before scopes were requested, which is resolved again on its next use.
ALTER TABLE mcp_oauth_clients ADD COLUMN scope TEXT;

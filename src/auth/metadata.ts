// The documents the Worker serves without waking A: RFC 9728's protected resource metadata for
// A's MCP endpoint, RFC 8414's authorization server metadata, and the client ID metadata
// document its own clients name themselves by.

/** A's MCP endpoint, the audience of A's tokens, as `https://….workers.dev/server/A/mcp`. */
export function mcpEndpoint(origin: string, serverInstance: string): string {
  return `${origin}/server/${serverInstance}/mcp`;
}

/** Where A's protected resource metadata lives, the path RFC 9728 derives from the endpoint. */
export function resourceMetadataUrl(origin: string, serverInstance: string): string {
  return `${origin}/.well-known/oauth-protected-resource/server/${serverInstance}/mcp`;
}

export function protectedResourceMetadata(origin: string, serverInstance: string): object {
  return {
    resource: mcpEndpoint(origin, serverInstance),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(origin: string): object {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    // Every client is public, authenticated by PKCE alone, and names itself by a document.
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Where the Worker serves its own clients' document, which is also their `client_id`. */
export function clientMetadataUrl(origin: string): string {
  return `${origin}/client.json`;
}

/** The client ID metadata document the Worker's own clients name themselves by. */
export function clientMetadataDocument(origin: string): ClientMetadataDocument {
  return {
    client_id: clientMetadataUrl(origin),
    client_name: 'Resource webhooks on Events',
    redirect_uris: [`${origin}/callback`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

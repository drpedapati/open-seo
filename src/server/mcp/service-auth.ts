import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  resolveCloudflareAccessContext,
  verifyCloudflareAccessToken,
} from "@/middleware/ensure-user/cloudflareAccess";
import { getDelegatedOrganizationId } from "@/server/auth/delegated-organization";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { AppError } from "@/server/lib/errors";
import { getEnvValueSync } from "@/server/lib/runtime-env";
import { buildFirstPartyMcpAuthContext } from "@/server/mcp/context";

const serviceConfigSchema = z.object({
  clientId: z.string().trim().min(1),
  ownerUserId: z.string().trim().min(1),
  projectIds: z
    .string()
    .transform((value) => value.split(",").map((id) => id.trim()))
    .pipe(z.array(z.string().min(1)).min(1)),
});

/** Only the self-hosted /mcp route may use this resolver. */
export async function resolveCloudflareMcpContext(
  headers: Headers,
  baseUrl: string,
) {
  const payload = await verifyCloudflareAccessToken(headers);
  if (payload.common_name === undefined) {
    // Reuse the human resolver (including its existing workspace behavior).
    // Its second JWT verification uses the same cached JWKS.
    const context = await resolveCloudflareAccessContext(headers);
    return buildFirstPartyMcpAuthContext({ ...context, baseUrl });
  }

  const config = serviceConfigSchema.safeParse({
    clientId: getEnvValueSync(env, "MCP_SERVICE_CLIENT_ID"),
    ownerUserId: getEnvValueSync(env, "MCP_SERVICE_OWNER_USER_ID"),
    projectIds: getEnvValueSync(env, "MCP_SERVICE_PROJECT_IDS"),
  });
  if (
    !config.success ||
    payload.type !== "app" ||
    payload.sub !== "" ||
    payload.email !== undefined ||
    payload.common_name !== config.data.clientId
  ) {
    throw new AppError("UNAUTHENTICATED");
  }

  // Read the explicitly configured existing owner; never create a machine
  // user, workspace, membership or OAuth connection as a side effect.
  const owner = await AuthRepository.getHostedUser(config.data.ownerUserId);
  if (!owner) throw new AppError("UNAUTHENTICATED");
  return {
    ...buildFirstPartyMcpAuthContext({
      userId: owner.id,
      userEmail: owner.email,
      organizationId: getDelegatedOrganizationId(owner.id),
      baseUrl,
    }),
    clientId: config.data.clientId,
    subject: `service:${config.data.clientId}`,
    scopes: ["mcp:read"],
    serviceProjectIds: config.data.projectIds,
  };
}

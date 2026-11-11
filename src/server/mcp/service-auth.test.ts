import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type * as Jose from "jose";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  resolveKey: vi.fn(),
  getHostedUser: vi.fn(),
  resolveDelegatedContext: vi.fn(),
  upsertDelegatedOrganization: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("jose", async (original) => ({
  ...(await original<typeof Jose>()),
  createRemoteJWKSet: () => mocks.resolveKey,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveDelegatedContext: mocks.resolveDelegatedContext,
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {
    getHostedUser: mocks.getHostedUser,
    upsertDelegatedOrganization: mocks.upsertDelegatedOrganization,
  },
}));

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
});
beforeEach(() => {
  mocks.resolveKey.mockResolvedValue(keys.publicKey);
  Object.keys(mocks.env).forEach((key) => delete mocks.env[key]);
  Object.assign(mocks.env, {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "app-audience",
    MCP_SERVICE_CLIENT_ID: "fixture.access",
    MCP_SERVICE_OWNER_USER_ID: "owner",
    MCP_SERVICE_PROJECT_IDS: "project-1,project-2",
  });
  mocks.getHostedUser.mockResolvedValue({
    id: "owner",
    email: "owner@example.com",
  });
  mocks.resolveDelegatedContext.mockResolvedValue({
    userId: "owner",
    userEmail: "owner@example.com",
    organizationId: "delegated-owner",
  });
});

async function headers(overrides: JWTPayload = {}, key = keys.privateKey) {
  const token = await new SignJWT({
    iss: "https://team.cloudflareaccess.com",
    aud: "app-audience",
    exp: Math.floor(Date.now() / 1000) + 300,
    type: "app",
    sub: "",
    common_name: "fixture.access",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(key);
  return new Headers({ "cf-access-jwt-assertion": token });
}

describe("Cloudflare MCP service identity", () => {
  it("maps a signed configured service to existing resources without creating a user/workspace", async () => {
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    expect(
      await resolveCloudflareMcpContext(
        await headers(),
        "https://open-seo.test",
      ),
    ).toMatchObject({
      userId: "owner",
      organizationId: "delegated-owner",
      subject: "service:fixture.access",
      clientId: "fixture.access",
      scopes: ["mcp:read"],
      serviceProjectIds: ["project-1", "project-2"],
    });
    expect(mocks.resolveDelegatedContext).not.toHaveBeenCalled();
    expect(mocks.upsertDelegatedOrganization).not.toHaveBeenCalled();
  });

  it.each([
    { iss: "https://attacker.test" },
    { aud: "other-app" },
    { exp: 1 },
    { exp: undefined },
    { common_name: "unknown.access" },
    { common_name: undefined },
    { type: "org" },
    { sub: "owner" },
    { email: "owner@example.com" },
  ])("rejects invalid signed claims %j", async (claims) => {
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    await expect(
      resolveCloudflareMcpContext(
        await headers(claims),
        "https://open-seo.test",
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(mocks.getHostedUser).not.toHaveBeenCalled();
    expect(mocks.resolveDelegatedContext).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures and raw client headers without a signed assertion", async () => {
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    const other = await generateKeyPair("RS256");
    await expect(
      resolveCloudflareMcpContext(
        await headers({}, other.privateKey),
        "https://open-seo.test",
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      resolveCloudflareMcpContext(
        new Headers({ "CF-Access-Client-Id": "fixture.access" }),
        "https://open-seo.test",
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it.each([
    "MCP_SERVICE_CLIENT_ID",
    "MCP_SERVICE_OWNER_USER_ID",
    "MCP_SERVICE_PROJECT_IDS",
  ])("fails closed without %s", async (setting) => {
    delete mocks.env[setting];
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    await expect(
      resolveCloudflareMcpContext(await headers(), "https://open-seo.test"),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("requires an existing owner and rejects malformed project lists", async () => {
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    mocks.getHostedUser.mockResolvedValue(undefined);
    await expect(
      resolveCloudflareMcpContext(await headers(), "https://open-seo.test"),
    ).rejects.toThrow("UNAUTHENTICATED");
    mocks.env.MCP_SERVICE_PROJECT_IDS = "project-1, ";
    await expect(
      resolveCloudflareMcpContext(await headers(), "https://open-seo.test"),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("retains human sign-in and rejects service tokens at the human-only resolver", async () => {
    const { resolveCloudflareAccessContext } =
      await import("@/middleware/ensure-user/cloudflareAccess");
    const { resolveCloudflareMcpContext } = await import("./service-auth");
    await expect(
      resolveCloudflareAccessContext(await headers()),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      resolveCloudflareAccessContext(
        await headers({ sub: "owner", email: "owner@example.com" }),
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    const context = await resolveCloudflareMcpContext(
      await headers({
        sub: "owner",
        email: "owner@example.com",
        common_name: undefined,
      }),
      "https://open-seo.test",
    );
    expect(context).toMatchObject({ subject: "owner", clientId: null });
    expect(context).not.toHaveProperty("serviceProjectIds");
    expect(mocks.resolveDelegatedContext).toHaveBeenCalledExactlyOnceWith(
      "owner",
      "owner@example.com",
    );
  });
});

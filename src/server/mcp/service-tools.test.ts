import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMcpToolAuthContext } from "./context";
import { SERVICE_READ_TOOLS } from "./service-policy";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  listProjects: vi.fn(),
  getAuditForProject: vi.fn(),
  getConfigById: vi.fn(),
  getSavedKeywords: vi.fn(),
  getConfigsForProject: vi.fn(),
  paid: vi.fn(() => {
    throw new Error("Paid provider must not be called");
  }),
}));
vi.mock("cloudflare:workers", () => ({
  env: { AUTH_MODE: "cloudflare_access" },
  waitUntil: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.paid,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
    listProjects: mocks.listProjects,
  },
}));
vi.mock("@/server/features/keywords/services/KeywordResearchService", () => ({
  KeywordResearchService: {
    getSavedKeywords: mocks.getSavedKeywords,
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getAuditForProject: mocks.getAuditForProject,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getConfigsForProject: mocks.getConfigsForProject,
    },
  }),
);

const context = {
  userId: "owner",
  userEmail: "owner@example.com",
  organizationId: "delegated-owner",
  subject: "service:fixture.access",
  clientId: "fixture.access",
  scopes: ["mcp:read"],
  audience: "https://open-seo.test/mcp",
  baseUrl: "https://open-seo.test",
  serviceProjectIds: ["project-1"],
};
let client: Client;
let server: McpServer;
beforeEach(async () => {
  vi.stubGlobal("fetch", mocks.paid);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project-1",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.listProjects.mockResolvedValue([
    {
      id: "project-1",
      name: "Allowed",
      domain: "allowed.test",
      locationCode: 2840,
      languageCode: "en",
    },
    {
      id: "project-2",
      name: "Hidden",
      domain: "hidden.test",
      locationCode: 2840,
      languageCode: "en",
    },
  ]);
  mocks.getSavedKeywords.mockResolvedValue({
    rows: [],
    totalCount: 0,
    tags: [],
  });
  mocks.getConfigsForProject.mockResolvedValue([]);
  mocks.getConfigById.mockResolvedValue(null);
  mocks.getAuditForProject.mockResolvedValue(null);
  const { registerOpenSeoMcpTools } = await import("./server");
  server = new McpServer({ name: "fixture", version: "1" });
  registerOpenSeoMcpTools(server, true);
  client = new Client({ name: "fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllGlobals();
});
function call(name: string, args: Record<string, unknown> = {}) {
  return runWithMcpToolAuthContext(context, () =>
    client.callTool({ name, arguments: args }),
  );
}

it("advertises exactly the reviewed read tools and rejects paid, mutation and unknown calls", async () => {
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name).toSorted()).toEqual(
    [...SERVICE_READ_TOOLS].toSorted(),
  );
  for (const name of [
    "research_keywords",
    "save_keywords",
    "run_site_audit",
    "get_audit_status",
    "future_tool",
  ]) {
    expect((await call(name, { projectId: "project-1" })).isError).toBe(true);
  }
  expect(mocks.paid).not.toHaveBeenCalled();
});

it("identifies the machine separately and lists only configured projects", async () => {
  expect((await call("whoami")).structuredContent).toMatchObject({
    serviceActor: context.subject,
    userId: "owner",
  });
  const result = await call("list_projects");
  expect(result.structuredContent).toMatchObject({
    projects: [{ id: "project-1" }],
  });
  expect(JSON.stringify(result)).not.toContain("Hidden");
  expect(JSON.stringify(result)).not.toContain("project-2");
  expect(mocks.paid).not.toHaveBeenCalled();
});

it("rejects a project outside the service list before any data lookup", async () => {
  expect(
    (await call("list_saved_keywords", { projectId: "project-2" })).isError,
  ).toBe(true);
  expect(mocks.getProjectForOrganization).not.toHaveBeenCalled();
  expect(mocks.getSavedKeywords).not.toHaveBeenCalled();
});

it("also enforces current organization ownership on an allowed project ID", async () => {
  mocks.getProjectForOrganization.mockResolvedValue(null);
  expect(
    (await call("list_saved_keywords", { projectId: "project-1" })).isError,
  ).toBe(true);
  expect(mocks.getSavedKeywords).not.toHaveBeenCalled();
});

it("reads empty saved state without refreshing paid data", async () => {
  expect(
    (await call("list_saved_keywords", { projectId: "project-1" })).isError,
  ).not.toBe(true);
  expect(
    (await call("get_rank_tracker", { projectId: "project-1" })).isError,
  ).not.toBe(true);
  expect(mocks.paid).not.toHaveBeenCalled();
});

it("scopes nested audit and tracker IDs to the permitted project", async () => {
  expect(
    (
      await call("get_audit_pages", {
        projectId: "project-1",
        auditId: "other-audit",
      })
    ).isError,
  ).toBe(true);
  expect(mocks.getAuditForProject).toHaveBeenCalledWith(
    "other-audit",
    "project-1",
  );
  await call("get_rank_tracker", {
    projectId: "project-1",
    trackerId: "other-tracker",
  });
  expect(mocks.getConfigById).toHaveBeenCalledWith({
    configId: "other-tracker",
    projectId: "project-1",
  });
  expect(mocks.paid).not.toHaveBeenCalled();
});

# Read-only service access to self-hosted OpenSEO

This optional mode accepts a dedicated Cloudflare Access service token on
`/mcp` only. It requires `AUTH_MODE=cloudflare_access`; it does not replace
human sign-in or enable machine access to the dashboard, server functions,
or chat. It is disabled until all three settings below are present.

| Setting                     | Value                                          |
| --------------------------- | ---------------------------------------------- |
| `MCP_SERVICE_CLIENT_ID`     | One dedicated Access service token's client ID |
| `MCP_SERVICE_OWNER_USER_ID` | Existing Cloudflare user's OpenSEO database ID |
| `MCP_SERVICE_PROJECT_IDS`   | Comma-separated explicit project IDs           |

The owner must already exist. Its workspace remains `delegated-<user ID>`,
matching normal Cloudflare human authentication. Every project request also
checks current organization ownership. No synthetic user, organization or
membership is created. `whoami` distinguishes the service actor from its
resource owner. Removing any setting disables service access; human access
does not depend on these settings.

## Allowed operations

The initial tool set is `whoami`, `list_projects`, `list_saved_keywords`,
`get_rank_tracker`, `get_audit_issues`, `get_audit_pages`,
`get_search_console_performance`, and `inspect_urls`.

The first six read existing state. The last two use an existing project GSC
connection and consume Google's API quota; normal OAuth token renewal may
update the stored connection credentials. They do not purchase SEO data.
Missing GSC configuration or consent is reported rather than established by
the service. Missing audit/rank data never starts a new paid refresh.

Paid research, saving keywords, starting audits, and unclassified future
tools are denied at invocation and omitted from discovery. `get_audit_status`
is deliberately excluded because its implementation can update audit state.
The application's existing scheduled rank checks are unchanged and are not
controlled by this credential. This is not a global account spending cap.

Service calls skip MCP analytics/activation writes. Existing Cloudflare
request logging remains available; no token or client secret is logged.
`readOnlyHint` is descriptive metadata, not the authorization boundary.

## Activation

1. Confirm the deployed Worker source revision, bindings and current database
   match the checkout being released. Record the existing Access application,
   audience, human policies, Worker version and a rollback version. Do not
   replace an unknown deployment or database with repository defaults.
2. Identify the existing owner and permitted project IDs through authorized
   read access. Review their domains and organization ownership.
3. Deploy the tested code through the installation's established release
   process with service settings absent. No database migration is needed.
   The repository's generic `pnpm deploy` runs production migrations; do not
   use it casually to enable this feature.
4. Create one expiring Access service token. Save its client ID and one-time
   client secret directly in the approved secret vault. Give the automation
   only this pair, not a Cloudflare management API key or vault-wide access.
5. Add a **Service Auth** policy including that exact token to the existing
   OpenSEO Access application. Preserve its human Allow policy and audience.
   Do not use Bypass, broad “any service token,” or change global Access
   behavior. The application enforces `/mcp`-only machine access even when
   the Access application covers the entire hostname.
6. Configure the three non-secret settings above through the deployment's
   authoritative configuration. `alchemy.run.ts` passes them through for
   installations using Alchemy. Preserve all other bindings and secrets.
7. Verify the client against the exact HTTPS hostname with redirects disabled.
   Send `CF-Access-Client-Id` and `CF-Access-Client-Secret` on **every** request;
   do not depend on cookies or forward these headers to another origin.

The Worker trusts only the signed Access assertion after signature,
issuer, audience and expiry verification. A service assertion must have
`type=app`, empty `sub`, no email, and `common_name` equal to the configured
client ID. Supplying raw client headers directly to an origin cannot create
an authenticated principal.

## Acceptance and rollback

Verify `initialize`, `tools/list`, `whoami`, and `list_projects`, then one
existing-state read for each permitted project. Confirm the list exposes
exactly the eight tools and only permitted projects. Check a disallowed
project, unknown token, expired assertion, and normal dashboard/chat paths
fail. Test forbidden tool dispatch with fixtures or a controlled test
installation, so an incorrectly deployed production guard cannot buy data.
Retest human sign-in separately. Do not claim live acceptance from fixture
tests alone.

To revoke, remove the service token's Access policy or revoke the token,
and remove `MCP_SERVICE_CLIENT_ID` from authoritative Worker settings.
Removing the application allowlist also rejects still-valid service JWTs.
The previous Worker version can be restored without a data migration;
preserve the original human policies. Store rollback evidence without secrets.

Official references:

- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Access application JWT claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)

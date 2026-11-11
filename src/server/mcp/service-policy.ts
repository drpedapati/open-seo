// These tools read existing state or use the connected, no-credit GSC API.
// readOnlyHint is not sufficient: several research tools buy provider data.
// get_audit_status is excluded because it can update audit state.
export const SERVICE_READ_TOOLS: ReadonlySet<string> = new Set([
  "whoami",
  "list_projects",
  "list_saved_keywords",
  "get_rank_tracker",
  "get_audit_issues",
  "get_audit_pages",
  "get_search_console_performance",
  "inspect_urls",
]);

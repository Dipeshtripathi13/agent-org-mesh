import type { SurfaceKey } from '../domain/types.js';

/**
 * The single source of truth for "which tools can be connected, and what does connecting
 * one actually look like" — the generic counterpart to runtime_catalog/surfaces_catalog,
 * which describe an LLM runtime and a surface's data-sensitivity respectively but say
 * nothing about *how you connect it*. `SetUpMyAgent.tsx`'s ConnectorsPanel renders its
 * dropdown and per-tool connect form entirely from this array — adding a 21st tool with a
 * simple PAT/token auth is a matter of adding one entry here plus one client module
 * (github.ts's shape), never a new bespoke React component.
 *
 * `status`:
 *  - 'live'        — a real ResourceProvider is registered (resourceProviders.ts) and
 *                     genuinely ingests real data at ask-time.
 *  - 'connectable' — the connect flow is fully real (validates the credential live
 *                     against the provider, shows up as Connected), but no ingestion is
 *                     wired yet — same honest gap this codebase already carries for
 *                     other work, just declared explicitly here instead of implied.
 *  - 'coming-soon' — genuinely cannot be connected yet: the auth is OAuth-only and needs
 *                     the platform operator to register a developer app with that vendor
 *                     first (a client id/secret in env vars), the same shape as Gmail's
 *                     own GOOGLE_CLIENT_ID/SECRET before those existed. Shown in the
 *                     dropdown so the catalog is honest about what's coming, but disabled
 *                     — never a connect button that would fail.
 */
export type ConnectorCategory =
  | 'code' | 'docs' | 'project-mgmt' | 'support' | 'crm' | 'comms' | 'calendar' | 'storage' | 'design' | 'data-eng';

export interface ConnectorField {
  key: string;
  label: string;
  placeholder?: string;
  /** Rendered as a password input and never echoed back by the API — same convention as
   *  every existing token input in this app. */
  secret?: boolean;
  /** May be submitted blank — e.g. GitLab's self-hosted instance URL, which defaults to
   *  gitlab.com. Every other field is required. */
  optional?: boolean;
  /** Rendered as a textarea instead of a single-line input — for a credential that
   *  genuinely spans multiple lines (Snowflake's PEM private key) rather than a token or
   *  password, which every other field so far has been. */
  multiline?: boolean;
}

export interface ConnectorDef {
  key: SurfaceKey;
  name: string;
  category: ConnectorCategory;
  /** 'ingest-token' — Claude Code/Codex CLI/Gemini CLI: no credential to paste at all.
   *  `fields` stays empty; the frontend renders the real UI for this one (a label input,
   *  a Generate-token button, the existing token-management list) instead of the generic
   *  field-driven form, since "generate one of possibly several independently-revocable
   *  tokens" is a genuinely different transaction from "submit a credential once." */
  authType: 'pat' | 'pat-with-site' | 'oauth-google' | 'ingest-token' | 'coming-soon';
  fields: ConnectorField[];
  status: 'live' | 'connectable' | 'coming-soon';
  /** Shown in the connect form and the "coming soon" tooltip — where to get the
   *  credential, or what's blocking it. */
  helpText: string;
}

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  // ---- live: real ingestion wired ----
  {
    key: 'github', name: 'GitHub', category: 'code', authType: 'pat', status: 'live',
    fields: [{ key: 'token', label: 'Personal access token', placeholder: 'ghp_...', secret: true }],
    helpText: 'GitHub → Settings → Developer settings → Personal access tokens. Read-only repo scope is enough.',
  },
  {
    key: 'jira', name: 'Jira', category: 'project-mgmt', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'siteUrl', label: 'Site URL', placeholder: 'https://yourteam.atlassian.net' },
      { key: 'email', label: 'Email' },
      { key: 'apiToken', label: 'API token', secret: true },
    ],
    helpText: 'Atlassian account → Security → Create and manage API tokens.',
  },
  {
    key: 'linear', name: 'Linear', category: 'code', authType: 'pat', status: 'live',
    fields: [{ key: 'apiKey', label: 'Personal API key', placeholder: 'lin_api_...', secret: true }],
    helpText: 'Linear → Settings → Security & access → Personal API keys.',
  },
  // ---- ingest-token: no credential, a generated bearer token pasted into the tool's own
  // hook/telemetry config instead — docs/agent-to-agent-communication.md §13. Unified into
  // this same catalog/dropdown so "everything is a tool, pick it from one place" holds for
  // these too, even though the connect flow underneath (genericConnection.ts's PAT/OAuth
  // storage vs ingestTokens.ts's token generation) is genuinely different.
  {
    key: 'claude-code', name: 'Claude Code', category: 'code', authType: 'ingest-token', status: 'live',
    fields: [],
    helpText: 'Generate a token below, then paste it into your Claude Code hook config (an http-type PostToolUse hook) — it pushes real activity straight to this mesh, from wherever it actually runs.',
  },
  {
    key: 'codex', name: 'Codex CLI', category: 'code', authType: 'ingest-token', status: 'live',
    fields: [],
    helpText: 'Generate a token below, then paste it into your Codex CLI hook/telemetry config.',
  },
  {
    key: 'gemini-cli', name: 'Gemini CLI', category: 'code', authType: 'ingest-token', status: 'live',
    fields: [],
    helpText: 'Generate a token below, then paste it into your Gemini CLI telemetry config.',
  },
  {
    key: 'notion', name: 'Notion', category: 'docs', authType: 'pat', status: 'live',
    fields: [{ key: 'token', label: 'Internal integration secret', placeholder: 'ntn_...', secret: true }],
    helpText: 'notion.so/my-integrations → New integration. Share the pages you want read with it.',
  },
  {
    key: 'confluence', name: 'Confluence', category: 'docs', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'siteUrl', label: 'Site URL', placeholder: 'https://yourteam.atlassian.net' },
      { key: 'email', label: 'Email' },
      { key: 'apiToken', label: 'API token', secret: true },
    ],
    helpText: 'Same Atlassian account and API token as Jira — one token covers both.',
  },
  {
    key: 'asana', name: 'Asana', category: 'project-mgmt', authType: 'pat', status: 'live',
    fields: [{ key: 'token', label: 'Personal access token', secret: true }],
    helpText: 'Asana → My Settings → Apps → Manage Developer Apps → Personal access tokens.',
  },
  {
    key: 'gitlab', name: 'GitLab', category: 'code', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'glpat-...', secret: true },
      { key: 'siteUrl', label: 'Instance URL (self-hosted only)', placeholder: 'https://gitlab.com', optional: true },
    ],
    helpText: 'GitLab → Edit profile → Access tokens. read_api scope is enough. Leave the instance URL blank for gitlab.com.',
  },
  {
    key: 'hubspot', name: 'HubSpot', category: 'crm', authType: 'pat', status: 'live',
    fields: [{ key: 'token', label: 'Private app access token', secret: true }],
    helpText: 'HubSpot → Settings → Integrations → Private Apps → create one with read-only CRM scopes.',
  },
  {
    key: 'zendesk', name: 'Zendesk', category: 'support', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'siteUrl', label: 'Subdomain', placeholder: 'yourcompany' },
      { key: 'email', label: 'Email' },
      { key: 'apiToken', label: 'API token', secret: true },
    ],
    helpText: 'Zendesk Admin Center → Apps and integrations → APIs → Zendesk API → Add API token.',
  },
  {
    key: 'calendar', name: 'Google Calendar', category: 'calendar', authType: 'oauth-google', status: 'live',
    fields: [],
    helpText: 'Uses the same Google sign-in as Gmail — connect Gmail in this panel to enable Calendar too.',
  },
  {
    key: 'airflow', name: 'Airflow', category: 'data-eng', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'siteUrl', label: 'Webserver URL', placeholder: 'https://airflow.yourcompany.com' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
    ],
    helpText: 'A dedicated user with the built-in Viewer role — Airflow → Security → List Users → Add a user, role: Viewer.',
  },
  {
    key: 'dbt', name: 'dbt Cloud', category: 'data-eng', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'token', label: 'Service account token', secret: true },
      { key: 'accountId', label: 'Account ID' },
      { key: 'siteUrl', label: 'Host (only if not cloud.getdbt.com)', placeholder: 'https://cloud.getdbt.com', optional: true },
    ],
    helpText: 'dbt Cloud → Account settings → Service tokens → create one with Read-Only or Metadata-only permissions.',
  },
  {
    key: 'snowflake', name: 'Snowflake', category: 'data-eng', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'account', label: 'Account identifier', placeholder: 'myorg-myaccount' },
      { key: 'username', label: 'Username' },
      { key: 'privateKey', label: 'Private key (PEM)', secret: true, multiline: true },
      { key: 'warehouse', label: 'Warehouse', optional: true },
    ],
    helpText: 'Register a public key on this user (ALTER USER ... SET RSA_PUBLIC_KEY=...) and paste the matching private key — Snowflake\'s own recommended auth for service accounts, never a password.',
  },
  {
    key: 'databricks', name: 'Databricks', category: 'data-eng', authType: 'pat-with-site', status: 'live',
    fields: [
      { key: 'workspaceUrl', label: 'Workspace URL', placeholder: 'https://dbc-xxxxxxxx-xxxx.cloud.databricks.com' },
      { key: 'clientId', label: 'Service principal client ID' },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
    ],
    helpText: 'Create a service principal (Workspace admin settings → Identity and access → Service principals), generate an OAuth secret for it, and grant it CAN VIEW on the jobs you want read — Databricks\' own recommended auth for automated access, never a personal access token tied to a human account.',
  },

  // ---- connectable: real connect+validate, ingestion not yet wired ----
  {
    key: 'trello', name: 'Trello', category: 'project-mgmt', authType: 'pat', status: 'connectable',
    fields: [
      { key: 'apiKey', label: 'API key' },
      { key: 'token', label: 'Token', secret: true },
    ],
    helpText: 'trello.com/power-ups/admin → generate an API key, then authorize a token from that same page.',
  },
  {
    key: 'airtable', name: 'Airtable', category: 'project-mgmt', authType: 'pat', status: 'connectable',
    fields: [{ key: 'token', label: 'Personal access token', placeholder: 'pat...', secret: true }],
    helpText: 'airtable.com/create/tokens — read-only scopes on the bases you want read.',
  },
  {
    key: 'monday', name: 'Monday.com', category: 'project-mgmt', authType: 'pat', status: 'connectable',
    fields: [{ key: 'token', label: 'API token', secret: true }],
    helpText: 'Monday → Avatar → Developers → My Access Tokens.',
  },
  {
    key: 'figma', name: 'Figma', category: 'design', authType: 'pat', status: 'connectable',
    fields: [{ key: 'token', label: 'Personal access token', placeholder: 'figd_...', secret: true }],
    helpText: 'Figma → Settings → Personal access tokens.',
  },
  {
    key: 'discord', name: 'Discord', category: 'comms', authType: 'pat', status: 'connectable',
    fields: [{ key: 'token', label: 'Bot token', secret: true }],
    helpText: 'discord.com/developers/applications → your app → Bot → Reset/copy token.',
  },

  // ---- coming soon: needs a platform-registered OAuth app first ----
  {
    key: 'slack', name: 'Slack', category: 'comms', authType: 'coming-soon', status: 'coming-soon',
    fields: [],
    helpText: 'Needs a Slack app registered by the platform operator before anyone can connect it.',
  },
  {
    key: 'salesforce', name: 'Salesforce', category: 'crm', authType: 'coming-soon', status: 'coming-soon',
    fields: [],
    helpText: 'Needs a Salesforce Connected App registered by the platform operator before anyone can connect it.',
  },
  {
    key: 'microsoft365', name: 'Microsoft 365', category: 'comms', authType: 'coming-soon', status: 'coming-soon',
    fields: [],
    helpText: 'Needs an Azure AD app registered by the platform operator before anyone can connect it.',
  },
  {
    key: 'zoom', name: 'Zoom', category: 'calendar', authType: 'coming-soon', status: 'coming-soon',
    fields: [],
    helpText: 'Needs a Zoom OAuth app registered by the platform operator before anyone can connect it.',
  },
  {
    key: 'dropbox', name: 'Dropbox', category: 'storage', authType: 'coming-soon', status: 'coming-soon',
    fields: [],
    helpText: 'Needs a Dropbox app registered by the platform operator before anyone can connect it.',
  },
];

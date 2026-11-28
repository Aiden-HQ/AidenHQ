# hubspot

## What it does

Your HubSpot CRM for your agents: HubSpot's remote MCP server, signed in as you, with live reads, reviewed writes, and
contacts, companies, deals and activities ingested into the warehouse (`src_hubspot`).

## Connect

Board, Settings, HubSpot (`#/setup/hubspot`), about 3 minutes, needs a HubSpot login that can create an MCP connector.
Create an MCP connector in HubSpot (Development, MCP Connectors) with the redirect URL the page shows, paste its client
id and secret, then press Connect. HubSpot grants what the connecting user can see.

## What agents get

The `hubspot` connection. Call `tool_guidance` first, then `discover_hubspot_schema`.

- Read: `search_crm_objects`, `get_crm_objects`, `query_crm_data`, `search_owners`, `get_properties` and more (22 in all,
  12 `named`).
- Write: `manage_crm_objects`. Destructive (reviewed, named grants only): `manage_marketing_email`,
  `manage_landing_page`, `manage_segment`, `manage_social_posts` and others.
- Warehouse: setting `hubspot_objects` picks which types land (default all four) ; the first pass reads back 365 days.

## New installs

Not in the default bundle. Unconnected, a banner says the agents have no CRM context.

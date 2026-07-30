-- Bind an agent to a default project.
--
-- Added as a second migration rather than folded into 001 because 001 has already
-- run on deployed instances; editing it would leave those databases and this file
-- permanently disagreeing about what "the schema" is.
--
-- Why the token carries this rather than the client: with MCP served over HTTPS
-- there is no client-side config to read, and the whole point of that transport is
-- that onboarding an agent is a URL and a token. Anything else the operator has to
-- set per box is something that can be set wrong.

alter table agent_token
  add column if not exists default_project_id uuid;

comment on column agent_token.default_project_id is
  'Plane project used when a tool wants a project and the caller omitted it. '
  'Not a restriction — an agent may still name any project explicitly.';

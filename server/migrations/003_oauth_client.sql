-- OAuth dynamic client registration (RFC 7591).
--
-- Claude Code registers itself on first connect, stores the client_id, and reuses
-- it on every later sign-in — so this has to survive a gateway restart or the
-- client presents an id we have forgotten and can never authenticate again.
--
-- Authorization codes are deliberately NOT here: they live 60 seconds, and a
-- restart inside that window costs one retry of a flow the user is actively
-- watching.
create table if not exists oauth_client (
  client_id     text        primary key,
  client_name   text        not null default '',
  -- Exact-match allowlist. An authorize request naming a redirect_uri that is not
  -- in this list is refused: without that check, an attacker who learns a
  -- client_id could have the code delivered to a host they control.
  redirect_uris text[]      not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

comment on table oauth_client is
  'Clients registered via RFC 7591. Public clients (PKCE, no secret) — Claude Code registers itself here on first connect.';
comment on column oauth_client.redirect_uris is
  'Exact-match allowlist for the authorization code redirect. Never pattern-matched.';

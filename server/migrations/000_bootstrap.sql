-- Run ONCE as the Plane database owner (or a superuser), connected to `postgres`:
--
--   psql -U plane -d postgres -f 000_bootstrap.sql
--
-- Creates a separate DATABASE on Plane's existing Postgres instance -- not a
-- separate server, and not a schema inside Plane's own database.
--
-- Why a separate database rather than a schema in `plane`:
--   * Postgres has no cross-database queries. The gateway physically cannot read
--     Plane's tables, so the boundary cannot be dissolved by a stray GRANT later.
--   * Plane's own migrations and any `pg_dump plane` stay unaware of our objects.
--   * We never need a transaction spanning both -- Plane is reached over REST, not
--     SQL -- so we give up nothing.
--
-- Why the same instance rather than a second Postgres:
--   * Plane's `setup.sh backup` copies the whole PGDATA directory, which contains
--     every database on the instance. So this rides along in the same backup and
--     restores to the same point in time. Two servers would mean two backups that
--     could restore out of sync with each other.

\set gw_password `echo "${GATEWAY_DB_PASSWORD:-agent_gw_dev}"`

select format('create role agent_gw login password %L', :'gw_password')
where not exists (select 1 from pg_roles where rolname = 'agent_gw')\gexec

-- CREATE DATABASE cannot run inside a transaction or a DO block, hence \gexec.
select 'create database gateway owner agent_gw'
where not exists (select 1 from pg_database where datname = 'gateway')\gexec

revoke all on database gateway from public;
grant connect on database gateway to agent_gw;

-- Deny the gateway role any access to Plane's database. Cross-database queries do
-- not exist in Postgres, so this is belt-and-braces -- but it also removes CONNECT,
-- which means a future mistake cannot quietly re-open the door.
--
-- PUBLIC holds CONNECT on every database by default, so revoking from agent_gw
-- alone is not enough; it has to come off PUBLIC too, with Plane's own role
-- granted explicitly so the application keeps working.
grant connect on database plane to plane;
revoke connect on database plane from public;
revoke all on database plane from agent_gw;

-- Verify: connecting as agent_gw to `plane` must fail with
--   FATAL: permission denied for database "plane"


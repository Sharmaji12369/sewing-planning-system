-- Users and roles. A user can hold several roles; a role is a set of
-- permissions (see backend/src/permissions.ts). Accounts are deactivated, never
-- deleted, so the history of who did what stays traceable.
--
-- token_version goes up whenever a user's password changes or the account is
-- deactivated; every session cookie carries the version it was issued under,
-- so older cookies stop working at once.

CREATE TABLE roles (
    id           serial PRIMARY KEY,
    code         text        NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    name         text        NOT NULL CHECK (btrim(name) <> ''),
    permissions  text[]      NOT NULL DEFAULT '{}',
    built_in     boolean     NOT NULL DEFAULT false,   -- the Administrator role: always every permission
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id             serial PRIMARY KEY,
    username       text        NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{2,40}$'),
    display_name   text        NOT NULL CHECK (btrim(display_name) <> ''),
    password_hash  text        NOT NULL,
    active         boolean     NOT NULL DEFAULT true,
    token_version  integer     NOT NULL DEFAULT 1,
    last_login_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- "Admin" and "admin" are the same user.
CREATE UNIQUE INDEX users_username_ci ON users (lower(username));

CREATE TABLE user_roles (
    user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id  integer NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, role_id)
);

INSERT INTO roles (code, name, permissions, built_in) VALUES
  ('administrator', 'Administrator', ARRAY[
     'dashboard.view', 'orders.view', 'orders.edit', 'preproduction.view', 'preproduction.edit',
     'log.view', 'log.edit', 'calendar.view', 'calendar.edit', 'admin.users'], true),
  ('editor', 'Editor', ARRAY[
     'dashboard.view', 'orders.view', 'orders.edit', 'preproduction.view', 'preproduction.edit',
     'log.view', 'log.edit', 'calendar.view', 'calendar.edit'], false),
  ('viewer', 'Viewer', ARRAY[
     'dashboard.view', 'orders.view', 'preproduction.view', 'log.view', 'calendar.view'], false);

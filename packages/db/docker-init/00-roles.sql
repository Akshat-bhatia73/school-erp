-- Local development only. Production provisions these credentials through its
-- secret manager and grants the same narrow runtime role.
CREATE ROLE erp_runtime LOGIN PASSWORD 'erp_runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE ROLE erp_identity LOGIN PASSWORD 'erp_identity' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE ROLE erp_auth LOGIN PASSWORD 'erp_auth' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT CONNECT ON DATABASE erp TO erp_runtime;

GRANT CONNECT ON DATABASE erp TO erp_identity, erp_auth;

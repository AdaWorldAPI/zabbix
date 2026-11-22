# Zabbix on Railway with Zitadel sign-in (OIDC)

Goal: run Zabbix and sign users in through Zitadel **without changing Zabbix
code**. Stock Zabbix images do the monitoring, including the built-in Go
services (`zabbix_web_service` for scheduled PDF reports, `zabbix_agent2`).
One small gateway (oauth2-proxy, also Go) adds OIDC in front of the web
frontend and hands the signed-in email to Zabbix's built-in HTTP
authentication.

## Why this shape

Zabbix 8.x has no OIDC login. It has two built-in sign-in paths that need no code:

| Path | How it works | Trade-off |
|---|---|---|
| **HTTP authentication + OIDC gateway** (this setup) | `ui/index_http.php` logs in the user named in `PHP_AUTH_USER` / `REMOTE_USER` / `AUTH_USER`; the gateway signs in with Zitadel (OIDC) and sends the email as that user | users must be created in Zabbix first (no automatic provisioning); the web frontend must be private |
| SAML SSO (alternative) | Zabbix's built-in SAML, with Zitadel as the SAML identity provider | no extra service, and Zabbix can create users and map groups on first login (JIT); but it is SAML, not OIDC |

## Services

All in one Railway project, so they share the private network. Images float on
the 8.0 minor (`8.0-ubuntu-latest`); every Zabbix image must be the same
version, because the server, the frontend and the database schema must match.

| Service name | Source | Public domain | Purpose |
|---|---|---|---|
| `zabbix-db` | Railway PostgreSQL | no | Zabbix database (its own instance; never another service's) |
| `zabbix-server` | image `zabbix/zabbix-server-pgsql:8.0-ubuntu-latest` | no | the server; creates the schema on first start |
| `zabbix-web` | image `zabbix/zabbix-web-nginx-pgsql:8.0-ubuntu-latest` | **no, never** | the PHP frontend, listens on 8080 |
| `zabbix-web-service` (optional, see the known issue) | image `zabbix/zabbix-web-service:8.0-ubuntu-latest` | no | built-in Go service for scheduled PDF reports, port 10053 |
| `zabbix-agent2` (optional) | image `zabbix/zabbix-agent2:8.0-ubuntu-latest` | no | built-in Go agent, monitors the server itself |
| `zabbix-oidc` | this repo, Dockerfile path `deploy/railway/oidc-zitadel/Dockerfile` | **yes** | the only public entry: Zitadel sign-in, then proxy to `zabbix-web` |

## Variables

`${{zabbix-db.PGHOST}}`-style values are Railway reference variables.

**zabbix-server**

| Variable | Value |
|---|---|
| `DB_SERVER_HOST` | `${{zabbix-db.PGHOST}}` |
| `DB_SERVER_PORT` | `${{zabbix-db.PGPORT}}` |
| `POSTGRES_USER` | `${{zabbix-db.PGUSER}}` |
| `POSTGRES_PASSWORD` | `${{zabbix-db.PGPASSWORD}}` |
| `POSTGRES_DB` | `${{zabbix-db.PGDATABASE}}` |
| `ZBX_WEBSERVICEURL` | `http://zabbix-web-service.railway.internal:10053/report` (only with `zabbix-web-service`) |
| `ZBX_STARTREPORTWRITERS` | `1` (only with `zabbix-web-service`; enables scheduled reports) |

Any other `zabbix_server.conf` parameter is set the same way: `ZBX_` + its name in upper case (zabbix-docker README, `server-pgsql`).

**zabbix-web**

| Variable | Value |
|---|---|
| `DB_SERVER_HOST`, `DB_SERVER_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | same references as above |
| `ZBX_SERVER_HOST` | `zabbix-server.railway.internal` |
| `PHP_TZ` | for example `Europe/Berlin` |

**zabbix-web-service**

| Variable | Value |
|---|---|
| `ZBX_ALLOWEDIP` | `zabbix-server.railway.internal` |

**zabbix-agent2** (optional)

| Variable | Value |
|---|---|
| `ZBX_HOSTNAME` | `Zabbix server` |
| `ZBX_SERVER_HOST` | `zabbix-server.railway.internal` |

**zabbix-oidc** (non-secret defaults are in the Dockerfile)

| Variable | Value |
|---|---|
| `OAUTH2_PROXY_OIDC_ISSUER_URL` | the Zitadel instance URL, e.g. `https://<zitadel-domain>` |
| `OAUTH2_PROXY_CLIENT_ID` | from the Zitadel application |
| `OAUTH2_PROXY_CLIENT_SECRET` | from the Zitadel application (secret) |
| `OAUTH2_PROXY_COOKIE_SECRET` | 32 random bytes, base64url: `openssl rand -base64 32 \| tr -- '+/' '-_'` (secret) |
| `OAUTH2_PROXY_REDIRECT_URL` | `https://<zabbix-oidc domain>/oauth2/callback` |
| `OAUTH2_PROXY_UPSTREAMS` | `http://zabbix-web.railway.internal:8080/` |

Healthcheck path for `zabbix-oidc`: `/ping`. Do not set `PORT`; the image binds Railway's.

## Zitadel application (a new app; existing apps are not touched)

1. In Zitadel, create a project `zabbix` and in it a **Web** application,
   authentication method **Code** with a client secret (PKCE is also used).
2. Redirect URI: `https://<zabbix-oidc domain>/oauth2/callback`.
   Post-logout URI: `https://<zabbix-oidc domain>/`.
3. Token settings: enable **User Info inside ID Token**, so the email claim is in
   the ID token.
4. Recommended: in the project, enable checking for a role grant on
   authentication, so only users granted the `zabbix` project can sign in at all.
5. Users need a verified email; oauth2-proxy refuses unverified emails.

## Bootstrap order

1. Create `zabbix-db`, then `zabbix-server`; wait until its log shows the schema
   created and the server started.
2. Create `zabbix-web`, `zabbix-web-service` and (optionally) `zabbix-agent2`.
3. Create the Zitadel application, then `zabbix-oidc` with its domain.
4. Open the `zabbix-oidc` domain. Sign in with Zitadel. HTTP authentication is
   still off, so Zabbix shows its own login form: sign in as `Admin` / `zabbix`
   and **change that password immediately**.
5. Create Zabbix users whose **username is the Zitadel email**, with their roles
   and user groups.
6. Administration → General → Other → **Frontend URL**:
   `http://zabbix-web.railway.internal:8080/` (the Go report service renders
   dashboards there; the public gateway would send it to Zitadel instead).
7. Users → Authentication → HTTP settings: enable HTTP authentication; default
   login form: **HTTP login form**; case-insensitive login.
8. Optional agent: edit the host `Zabbix server` and set its agent interface to
   DNS `zabbix-agent2.railway.internal`, port 10050.

## Checks

| Check | Expected |
|---|---|
| `zabbix-web` | has no public domain |
| `https://<zabbix-oidc domain>/ping` | `OK` |
| open the domain while signed out | redirect to Zitadel |
| sign in as a user that exists in Zabbix | lands in Zabbix as that user, no Zabbix password asked |
| sign in as a Zitadel user that does not exist in Zabbix | Zabbix refuses ("You are not logged in") |
| request with your own `Authorization: Basic <someone else>` header to the domain | ignored: you are still yourself, or sent to Zitadel |
| a scheduled report (Reports → Scheduled reports → Test), only with `zabbix-web-service` | a PDF is produced, or the known issue below |

## Known issue: scheduled PDF reports on Railway

`zabbix-web-service` renders dashboards with headless Chromium. The zabbix-docker
README (web-service, "Known issues") says it needs the `SYS_ADMIN` capability
(or the seccomp profile `env_vars/chrome_dp.json`), otherwise report generation
fails with `Failed to move to new namespace ... Operation not permitted`.
Railway does not offer added capabilities or custom seccomp profiles, so expect
that error. Monitoring, alerting, dashboards and sign-in do not depend on it.
If PDF reports are needed, that is a separate change (for example an image that
starts Chromium without its sandbox), not part of this setup.

## Not verified yet

- PHP-FPM filling `PHP_AUTH_USER` from the Basic header in the stock web image
  is expected (standard PHP-FPM behaviour) but has not been run here. The "sign
  in as an existing user" check above is the proof.
- Railway private networking: if a service cannot reach another one over
  `*.railway.internal` while both are healthy, the private network may be
  IPv6-only and that image's listener IPv4-only.
- These images are Zabbix 8.0; this fork's `master` is 8.2 (alpha). Building from
  this fork's source is a separate step and is not needed for this setup.

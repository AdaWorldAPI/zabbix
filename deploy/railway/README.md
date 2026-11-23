# Zabbix on Railway with native Zitadel SAML sign-in

Goal: run stock Zabbix 8.0 on Railway and sign users in through the existing
Zitadel instance (`https://login.msgraph.de`) with Zabbix's **built-in SAML
2.0** support, including role-based access from Zitadel project grants. No
Zabbix code changes, no gateway in front of the frontend, no second identity
provider.

```text
browser -> zabbix-web (public HTTPS) -> SAML AuthnRequest (signed) -> login.msgraph.de
        <- signed SAML response: UserID, names, Roles = "<project>:zabbix.*"
zabbix-web: verifies issuer, audience, signature, time; JIT-provisions the user;
            maps Roles to Zabbix user groups and a user role; no match = no access
```

This replaces the earlier oauth2-proxy design (PR #1). That design handed the
signed-in email to Zabbix's HTTP authentication through a Basic header, which
only held while `zabbix-web` stayed private. Its Dockerfile is removed here;
with SAML, Zabbix verifies the identity assertion itself and the frontend may
have a public domain.

The Zitadel side (new SAML application, role keys, the role-attribute action)
is in [ZITADEL-SAML-SETUP.md](ZITADEL-SAML-SETUP.md). Nothing in either guide
changes report-rs, its database, existing Zitadel applications, or other
Railway services.

## Status of this guide

What was checked while writing it, and what was not:

- **Checked against live endpoints:** the Zitadel IdP metadata
  (`/saml/v2/metadata`) declares entity ID `https://login.msgraph.de/saml/v2/metadata`,
  SSO `https://login.msgraph.de/saml/v2/SSO` (HTTP-Redirect and HTTP-POST),
  SLO `https://login.msgraph.de/saml/v2/SLO`, NameID format `persistent`,
  `WantAuthnRequestsSigned="1"`, and the attributes `Email`, `FirstName`,
  `SurName`, `FullName`, `UserName`, `UserID`. `/saml/v2/certificate` returns a
  PEM certificate ("ZITADEL SAML response", valid until 2027-11-23) that is one
  of the certificates in the signed metadata.
- **Checked against the published image documentation:** tags
  `ubuntu-8.0-latest` (also published as `8.0-ubuntu-latest`, same digest), the
  database and server variables, `ZBX_SSO_SETTINGS`, and
  `ZBX_SSO_SP_KEY` / `ZBX_SSO_SP_CERT` / `ZBX_SSO_IDP_CERT` ("Available since
  8.0.0"), from the `zabbix/zabbix-web-nginx-pgsql` Docker Hub description.
- **Read in Zabbix frontend source** (this fork's `ui/index_sso.php`,
  `CProvisioning.php`, `CUser.php`; the fork is 8.2 alpha, so 8.0 may differ in
  detail): group mapping, role precedence, deprovisioning and the `Roles`
  splitting rule described below.
- **Not run:** no Zabbix or Zitadel was deployed for this guide. Every behaviour
  in the acceptance table is an expectation until the operator records an
  observed result.

## Services

All in the existing Railway project, so they share its private network.

| Service | Source | Public domain | Purpose |
|---|---|---|---|
| `zabbix-db` | Railway PostgreSQL, a **new** instance | no | Zabbix database; never report-rs's database |
| `zabbix-server` | image `zabbix/zabbix-server-pgsql:ubuntu-8.0-latest` | no | the server; creates the schema on first start |
| `zabbix-web` | image `zabbix/zabbix-web-nginx-pgsql:ubuntu-8.0-latest` | **yes, only after bootstrap step 3** | PHP frontend and SAML service provider, listens on 8080 |
| `zabbix-agent2` (optional) | image `zabbix/zabbix-agent2:ubuntu-8.0-latest` | no | monitors the server itself |
| `zabbix-web-service` (optional) | image `zabbix/zabbix-web-service:ubuntu-8.0-latest` | no | scheduled PDF reports; see the known issue at the end |

All Zabbix images must be the same 8.0 version: server, frontend and schema
must match. `ubuntu-8.0-latest` floats on the 8.0 minor; pin `ubuntu-8.0.<n>`
if a deployment must be reproducible. This fork's own `master` (8.2 alpha) is
not built for this setup.

## Variables

`${{zabbix-db.PGHOST}}`-style values are Railway reference variables. Mark the
secret ones as sealed variables in Railway.

**zabbix-server**

| Variable | Value |
|---|---|
| `DB_SERVER_HOST` | `${{zabbix-db.PGHOST}}` |
| `DB_SERVER_PORT` | `${{zabbix-db.PGPORT}}` |
| `POSTGRES_USER` | `${{zabbix-db.PGUSER}}` |
| `POSTGRES_PASSWORD` | `${{zabbix-db.PGPASSWORD}}` |
| `POSTGRES_DB` | `${{zabbix-db.PGDATABASE}}` |
| `ZBX_WEBSERVICEURL` | `http://zabbix-web-service.railway.internal:10053/report` (only with `zabbix-web-service`) |
| `ZBX_STARTREPORTWRITERS` | `1` (only with `zabbix-web-service`) |

**zabbix-web**

| Variable | Value | Secret |
|---|---|---|
| `DB_SERVER_HOST`, `DB_SERVER_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | same references as above | password |
| `ZBX_SERVER_HOST` | `zabbix-server.railway.internal` | |
| `PHP_TZ` | for example `Europe/Berlin` | |
| `ZBX_HTTP_AUTH_ENABLED` | `false` (turns off the HTTP-header login used by the old design; check that Users → Authentication no longer offers HTTP settings) | |
| `ZBX_SSO_SETTINGS` | `{"baseurl": "https://<ZABBIX_DOMAIN>", "use_proxy_headers": true}` | |
| `ZBX_SSO_IDP_CERT` | PEM from `https://login.msgraph.de/saml/v2/certificate` | no (public) |
| `ZBX_SSO_SP_CERT` | PEM of the SP certificate (bootstrap step 4) | no (public) |
| `ZBX_SSO_SP_KEY` | PEM of the SP private key (bootstrap step 4) | **yes** |

Healthcheck path for `zabbix-web`: `/` (the login page). When generating the
domain, set the target port to `8080`.

Notes on `ZBX_SSO_SETTINGS`:

- It is written into the frontend's `$SSO['SETTINGS']`. `baseurl` makes Zabbix
  build its SAML URLs (ACS, SP entity checks, `Destination` validation) from the
  public HTTPS address, although Railway terminates TLS and forwards plain HTTP
  to port 8080. `use_proxy_headers` makes it read `X-Forwarded-Proto/Host/Port`.
- `strict` is **not** set, so it keeps the SAML library's default `true`:
  issuer, audience (SP entity ID), `Destination`, `Recipient`, signature and
  validity window are all enforced. The Zabbix manual's load-balancer example
  sets `'strict' => false`; that switches those checks off and is not needed
  once `baseurl` is correct. If logins fail with a `Destination`/`Recipient`
  mismatch, fix `baseurl` (exact scheme and host, no trailing slash, no path);
  use `strict: false` only briefly to read the error, never as the fix.
- The published example writes the JSON with single quotes; the double-quoted
  form above is plain JSON and is what to use.

Notes on certificates:

- The image documents `ZBX_SSO_*_CERT` / `ZBX_SSO_SP_KEY` (or the `*FILE`
  variants under `/run/zabbix/secrets/sso`) as the way to provide them. If the
  SAML settings form in the deployed frontend instead shows fields for the IdP
  certificate, SP key and SP certificate, the frontend stores them in the
  database: paste them there and leave the three variables unset. Use one place,
  not both.
- The IdP certificate expires on 2027-11-23. When Zitadel rotates its SAML key,
  replace `ZBX_SSO_IDP_CERT` (or the form field) the same day, or every SAML
  login fails signature validation.

## Bootstrap order

The public domain is created only after the default `Admin` / `zabbix` password
stops working.

1. Create `zabbix-db`, then `zabbix-server`. Wait until the server log shows the
   schema created and the server started.
2. Create `zabbix-web` with the database, server, `PHP_TZ` and
   `ZBX_HTTP_AUTH_ENABLED` variables only. **Do not generate a domain.** Add the
   optional services if wanted.
3. Replace the default `Admin` password while the frontend is still private, in
   the database:

   ```sh
   # bcrypt hash of a new, strong password (apache2-utils); keep the password in a password manager
   htpasswd -bnBC 10 "" 'NEW-STRONG-PASSWORD' | tr -d ':\n'; echo
   railway connect zabbix-db        # psql to the Zabbix database
   ```

   ```sql
   UPDATE users SET passwd = '$2y$10$...the hash...' WHERE username = 'Admin';
   ```

   This account is the break-glass administrator (below). Only now generate the
   `zabbix-web` domain (target port 8080) and note it as `<ZABBIX_DOMAIN>`.
   Check at once: `Admin` / `zabbix` is refused, the new password works.
4. Create the SP signing key pair (the IdP wants signed requests):

   ```sh
   openssl req -x509 -newkey rsa:3072 -nodes -days 730 \
     -subj "/CN=<ZABBIX_DOMAIN>" -keyout sp.key -out sp.crt
   curl -fsS https://login.msgraph.de/saml/v2/certificate -o idp.crt
   ```

   Set `ZBX_SSO_SETTINGS`, `ZBX_SSO_IDP_CERT` (idp.crt), `ZBX_SSO_SP_CERT`
   (sp.crt) and `ZBX_SSO_SP_KEY` (sp.key, sealed) on `zabbix-web` and redeploy.
   Delete the local `sp.key` once it is stored.
5. In Zabbix, create the target groups before any SAML login (section "Zabbix
   groups and roles").
6. Do the Zitadel steps in [ZITADEL-SAML-SETUP.md](ZITADEL-SAML-SETUP.md),
   including verifying the real assertion.
7. Configure SAML in Zabbix (next section), enable it, tick **Enable JIT
   provisioning**, and run the acceptance
   checks with test users before giving anyone else access.

## Zabbix groups and roles

Create these in Zabbix before enabling JIT provisioning:

| Zabbix object | Setting |
|---|---|
| user group `SAML viewers` | frontend access: System default; host group permissions: **Read** on the POC host groups only |
| user group `SAML operators` | host group permissions: **Read-write** on the POC host groups only |
| user group `SAML admins` | no host group permissions needed (Super admin sees everything) |
| user group `SAML deprovisioned` | **disabled** (status Disabled), frontend access Disabled, no permissions |

Users → Authentication → **Deprovisioned users group**: `SAML deprovisioned`.
JIT provisioning requires it, and it is where a returning user lands when no
mapping matches any more.

User roles: the built-in `User role`, `Admin role` and `Super admin role`, or
copies with narrower UI and API access.

## SAML settings in Zabbix

Users → Authentication → SAML settings:

| Field | Value |
|---|---|
| Enable SAML authentication | on, after the checks in ZITADEL-SAML-SETUP.md pass |
| IdP entity ID | `https://login.msgraph.de/saml/v2/metadata` |
| SSO service URL | `https://login.msgraph.de/saml/v2/SSO` |
| SLO service URL | `https://login.msgraph.de/saml/v2/SLO` (optional; leave empty to skip single logout) |
| Username attribute | `UserID` (Zitadel's stable user ID; it does not change when an email or user name changes) |
| SP entity ID | `https://<ZABBIX_DOMAIN>/zabbix-sp` (must equal the entity ID uploaded to Zitadel) |
| SP name ID format | `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` |
| Sign | AuthN requests: on; Messages / Assertions: the element the verified response signs (see below); Logout requests/responses: on if SLO is used |
| Encrypt | off |
| Case-sensitive login | on |
| Enable JIT provisioning | on, but only after the assertion check (ZITADEL-SAML-SETUP.md §7); this separate checkbox is what lets Zabbix create and update users at login |
| Configure JIT provisioning | on (shows the fields below; on its own it provisions nobody) |
| Group name attribute | `Roles` |
| User name attribute | `FirstName` |
| User last name attribute | `SurName` |
| User group mapping | the three rows below, nothing else |
| Media type mapping | optional: Email media type ← `Email` |
| Enable SCIM provisioning | off |

Which of "Messages" and "Assertions" to require depends on where Zitadel puts
its signature, and that is read from a captured response
(ZITADEL-SAML-SETUP.md, "Verify the assertion"): a `<ds:Signature>` directly
under `<samlp:Response>` means Messages, one under `<saml:Assertion>` means
Assertions. Require only what is present, or valid logins are rejected. The
SAML library rejects a response that carries no signature at all, so leaving
both off does not mean unsigned responses are accepted, but requiring the
signed element makes the expectation explicit.

User group mapping (no `*` in any row; a row without `*` matches the whole
value exactly):

| SAML group pattern | User groups | User role |
|---|---|---|
| `<PROJECT_ID>:zabbix.viewer` | `SAML viewers` | `User role` |
| `<PROJECT_ID>:zabbix.operator` | `SAML operators` | `Admin role` |
| `<PROJECT_ID>:zabbix.admin` | `SAML admins` | `Super admin role` |

How Zabbix applies these on each SAML login (read in `CProvisioning::getUserGroupsAndRole`
and `CUser::updateProvisionedUser`):

- `Roles` is read as a multivalued attribute; a single value is split on `;`.
- A user matching several rows joins all their groups and gets the role with the
  **highest user type** (Super admin > Admin > User). Granting `zabbix.admin`
  therefore overrides `zabbix.viewer`; test it with one user holding both.
- No matching row: a new user is **not created** and the login fails; an
  existing provisioned user is moved to `SAML deprovisioned` with no role.
- JIT runs at login only. Removing a grant in Zitadel takes effect at that
  user's next SAML login; an open Zabbix session keeps its rights until it ends.

## Break-glass and switching SAML off

- The local `Admin` account (bootstrap step 3) keeps working with its password
  on the normal login form, independent of SAML and Zitadel. Keep it to one
  named owner, store the password offline, and do not map it to SAML.
- To switch SAML off from the frontend: Users → Authentication → SAML settings →
  clear "Enable SAML authentication".
- If the frontend is unusable, switch it off in the database. In this fork's
  schema the flag is a row of the `settings` table; check the row first:

  ```sql
  SELECT name, value_int FROM settings WHERE name = 'saml_auth_enabled';
  UPDATE settings SET value_int = 0 WHERE name = 'saml_auth_enabled';
  ```

- Removing the public domain from `zabbix-web` stops all outside access at once.

## Acceptance checks

Record the observed result next to each row; until then the right column is the
expectation, not a result.

| # | Check | Expected | Observed |
|---|---|---|---|
| 1 | Zitadel user with `zabbix.viewer`, MFA completed | lands in Zabbix as `User role`, read-only on POC host groups | |
| 2 | `zabbix.operator` | `Admin role`, read-write only on POC host groups | |
| 3 | `zabbix.admin` (designated POC admins only) | `Super admin role` | |
| 3a | one user with `zabbix.viewer` and `zabbix.admin` | `Super admin role` (highest type wins) | |
| 4 | valid Zitadel login, no Zabbix grant | refused, no user created | |
| 5 | wrong issuer, wrong audience, broken signature, expired assertion (replay an old response) | refused | |
| 6 | response without `Roles` (action disabled) | refused (new user) / moved to `SAML deprovisioned` (existing user) | |
| 7 | grant removed in Zitadel, then a fresh SAML login | rights removed; user in `SAML deprovisioned` | |
| 8 | restart `zabbix-web` and `zabbix-server` | users, groups, SAML settings persist | |
| 9 | report-rs, ticket, paperless, a2ui and other Zitadel apps | unchanged, logins still work | |
| 10 | full SAML login over the Railway domain | no redirect loop, ends on the Zabbix dashboard | |
| 11 | `Admin` / `zabbix` on the public domain | refused | |

Caveats:

- No continuous deprovisioning: without SCIM, a removed grant applies at the
  next login only. Immediate revocation needs SCIM or ending sessions, which is
  out of scope for the POC.
- Zitadel project roles are shared by every application in that project; see
  ZITADEL-SAML-SETUP.md.

## Known issue: scheduled PDF reports on Railway

`zabbix-web-service` renders dashboards with headless Chromium. The
zabbix-docker README (web-service, "Known issues") says it needs the
`SYS_ADMIN` capability (or the seccomp profile `env_vars/chrome_dp.json`),
otherwise report generation fails with
`Failed to move to new namespace ... Operation not permitted`. Railway offers
neither, so expect that error. Monitoring, alerting, dashboards and sign-in do
not depend on it. With SAML, the report service also needs a Frontend URL it
can reach without signing in (Administration → General → Other → Frontend URL:
`http://zabbix-web.railway.internal:8080/`).

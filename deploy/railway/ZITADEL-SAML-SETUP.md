# Zitadel: SAML application for Zabbix

Operator runbook for the Zitadel side of
[README.md](README.md). It adds **one new SAML application** to an existing
Zitadel project on `https://login.msgraph.de`, three role keys, and one Action
that puts those roles into the SAML response. Existing OIDC applications,
their role assignments and the Zitadel deployment are not changed.

Every console step here needs an operator with access to the Zitadel
organization; nothing in this repository can perform them.

## What the IdP already provides (checked live)

| Item | Value |
|---|---|
| Metadata | `https://login.msgraph.de/saml/v2/metadata` (signed) |
| IdP entity ID | `https://login.msgraph.de/saml/v2/metadata` |
| SSO URL | `https://login.msgraph.de/saml/v2/SSO` (HTTP-Redirect, HTTP-POST) |
| SLO URL | `https://login.msgraph.de/saml/v2/SLO` |
| Signing certificate | `https://login.msgraph.de/saml/v2/certificate` (PEM, "ZITADEL SAML response", expires 2027-11-23) |
| NameID format | `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` |
| Default attributes | `Email`, `FirstName`, `SurName`, `FullName`, `UserName`, `UserID` |
| Requests | metadata declares `WantAuthnRequestsSigned="1"`, so Zabbix signs its AuthnRequests |

There is **no role attribute by default.** OIDC role claims are not copied into
SAML responses; the Action below adds them.

## 1. Choose the project, and know what sharing means

Zitadel roles belong to a **project**, and every application in that project
sees the same role keys and grants. Two options:

- **Recommended: a new project `Zabbix POC`** holding only the Zabbix SAML
  application and the three role keys. Granting `zabbix.admin` there gives
  nothing in any other application, and nothing granted elsewhere reaches
  Zabbix.
- An existing project (for example the one report-rs uses): the three role keys
  become visible to every application in it, and anyone allowed to manage that
  project's grants can grant Zabbix access. Use only if that is intended.

Note the chosen project's **project ID** (Projects → the project → the ID shown
on its page). It is `<PROJECT_ID>` everywhere below and in the Zabbix group
mapping.

If the project has "Check for project on authentication" / "Check authorization
on authentication" settings, enabling the authorization check stops users
without any grant in this project at the Zitadel login instead of at Zabbix.
That is optional; Zabbix refuses them either way.

## 2. Role keys

In the project → Roles, add exactly:

| Key | Display name | Zabbix result |
|---|---|---|
| `zabbix.viewer` | Zabbix viewer | `SAML viewers`, `User role` |
| `zabbix.operator` | Zabbix operator | `SAML operators`, `Admin role` |
| `zabbix.admin` | Zabbix admin | `SAML admins`, `Super admin role` (designated POC admins only) |

If equivalent roles already exist under other keys, either add these three or
change `ZABBIX_ROLE_KEYS` in the Action and the Zabbix mapping rows to the
existing keys. Keep the values exact; the Action and Zabbix both match whole
strings.

## 3. Service provider metadata

Zabbix has a public HTTPS domain at this point (README bootstrap step 3) and an
SP certificate (step 4). Either:

- render it from this repository (checks the host name, the certificate, and
  that entity ID and ACS URL come out exactly as Zabbix expects):

  ```sh
  deploy/railway/saml/render-sp-metadata.sh <ZABBIX_DOMAIN> sp.crt > zabbix-sp-metadata.xml
  ```

- or, once SAML settings are saved in Zabbix (README "SAML settings"), download
  what Zabbix itself generates: `https://<ZABBIX_DOMAIN>/index_sso.php?metadata`.

Both must show entity ID `https://<ZABBIX_DOMAIN>/zabbix-sp`, ACS
`https://<ZABBIX_DOMAIN>/index_sso.php?acs` (HTTP-POST) and the SP signing
certificate. The metadata contains only public values; the SP private key never
goes into it.

## 4. Create the SAML application

In the console of `https://login.msgraph.de`:

1. Projects → the project from step 1 → Applications → **New**.
2. Name `Zabbix POC`, type **SAML**.
3. Upload `zabbix-sp-metadata.xml` (or paste its content / its URL, whichever
   the console offers). Do not edit or replace any existing application.
4. Save, and check the application shows the entity ID and ACS URL from step 3.

## 5. Grant roles to test users

Users → the user → Authorizations (or the project → Authorizations) → new
authorization for the project from step 1 with one of the three keys. For the
acceptance checks, prepare at least: one viewer, one operator, one admin, one
user holding viewer and admin, and one user with no Zabbix role. All test users
need MFA as for any other application.

## 6. The Action that adds `Roles`

The code is [`saml/zitadel-action-zabbix-roles.js`](saml/zitadel-action-zabbix-roles.js).

1. Replace `REPLACE_WITH_PROJECT_ID` with `<PROJECT_ID>` in a local copy.
2. Actions → **New**: name `zabbixRoles` (the name must equal the function name),
   paste the script, save. Leave "allowed to fail" off, so a broken Action stops
   the login instead of issuing a response without roles.
3. Flows → **Complement SAMLResponse** → trigger **Pre SAMLResponse creation** →
   add `zabbixRoles`.

What it emits: one attribute `Roles` with one value per Zabbix role the user
holds **in that project**, formatted `<PROJECT_ID>:zabbix.viewer` etc. Grants in
other projects and any other role key are dropped. With no Zabbix role the
attribute is left out, and Zabbix grants nothing.

Why the filter matters: the user grant list given to the Action covers the
user's grants across projects, and Zitadel's own example emits all of them.
Zabbix stores every group name it receives (table `scim_group`, written on each
SAML login even with SCIM off), so unfiltered grants of other applications would
end up in Zabbix's database.

Scope of the trigger: it runs for the SAML responses of **every SAML
application in the organization**, and this trigger exposes no application
field to tell them apart. Before adding the Action, list the organization's
SAML applications. Any other SAML application will also receive `Roles` with
the Zabbix values (and only those); if that matters for one of them, add the
Zabbix application in its own organization instead. OIDC applications are not
affected by this flow.

Offline check of the filter (no Zitadel involved; it proves the script, not
Zitadel):

```sh
node deploy/railway/saml/test-zitadel-action.mjs
```

Actions v2: Zitadel documents a v2 function `PreSAMLResponse` (a webhook
returning `append_attribute` entries) that runs **in addition to** v1 Actions.
This guide uses v1 because it needs no extra service. If the instance moves to
v2, the same filter applies; Zabbix also accepts a single `Roles` value joined
with `;`.

## 7. Verify the assertion before enabling JIT

Do this with Zabbix SAML enabled but before trusting any mapping:

1. Open the browser developer tools, Network tab, "Preserve log" on.
2. Start a SAML login on `https://<ZABBIX_DOMAIN>/` as a test user.
3. Find the POST to `/index_sso.php?acs` and copy its `SAMLResponse` form value.
4. Decode it locally, outside any repository, then delete the files:

   ```sh
   d=$(mktemp -d); pbpaste > "$d/r.b64"    # or paste into the file
   base64 -d "$d/r.b64" | xmllint --format - | less
   rm -r "$d"
   ```

Check, and note the results in the acceptance table (never commit the response):

| Look for | Expected |
|---|---|
| `<saml:Issuer>` | `https://login.msgraph.de/saml/v2/metadata` |
| `<saml:Audience>` | `https://<ZABBIX_DOMAIN>/zabbix-sp` |
| `Destination` / `Recipient` | `https://<ZABBIX_DOMAIN>/index_sso.php?acs` |
| attribute `UserID` | present, a numeric Zitadel ID |
| attribute `Roles` | one `AttributeValue` per role, e.g. `<PROJECT_ID>:zabbix.viewer`; absent for the no-role user |
| `FirstName`, `SurName`, `Email` | present |
| signature | note whether `<ds:Signature>` sits under `Response`, under `Assertion`, or both; set Zabbix "Sign" accordingly (README) |

Only then turn on JIT provisioning in Zabbix and run the acceptance checks.

## Rollback

- Remove `zabbixRoles` from the Complement SAMLResponse flow (stops the role
  attribute; Zabbix logins then fail closed).
- Deactivate or delete the `Zabbix POC` application (stops all Zabbix SAML
  logins).
- If a new project was created, deleting it removes the role keys and grants.

None of these touch the other applications.

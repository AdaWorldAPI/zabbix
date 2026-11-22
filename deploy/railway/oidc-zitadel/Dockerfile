# OIDC sign-in for the Zabbix web frontend, with Zitadel as the identity provider.
#
# This image is oauth2-proxy (Go) configured as a reverse proxy in front of an
# UNMODIFIED Zabbix web frontend. No Zabbix code changes:
#
#   browser -> this gateway (public) -> Zitadel sign-in (OIDC code flow + PKCE)
#           -> zabbix-web (private only) with "Authorization: Basic <email>:<placeholder>"
#
# Zabbix's built-in HTTP authentication (ui/index_http.php) reads PHP_AUTH_USER,
# which PHP-FPM fills from that Basic header, and logs in the Zabbix user whose
# username equals that email. Users must already exist in Zabbix; unknown emails
# are refused by Zabbix. oauth2-proxy replaces any Authorization header the
# client sent (PreserveRequestValue=false in v7.15.6), so a browser cannot choose
# the user name.
#
# SECURITY: zabbix-web must NOT have a public address. Anyone who can reach it
# directly can send their own Basic header and sign in as any user.
#
# Secrets and per-deployment values are Railway variables, never baked in:
#   OAUTH2_PROXY_OIDC_ISSUER_URL  Zitadel instance URL, e.g. https://<zitadel-domain>
#   OAUTH2_PROXY_CLIENT_ID        Zitadel application client id
#   OAUTH2_PROXY_CLIENT_SECRET    Zitadel application client secret
#   OAUTH2_PROXY_COOKIE_SECRET    32 random bytes, base64url
#   OAUTH2_PROXY_REDIRECT_URL     https://<this service's domain>/oauth2/callback
#   OAUTH2_PROXY_UPSTREAMS        http://zabbix-web.railway.internal:8080/
# Railway injects PORT; the gateway binds 0.0.0.0:$PORT (4180 when unset).
#
# Environment names follow oauth2-proxy's `cfg` tags (prefix OAUTH2_PROXY_):
# note the plural OAUTH2_PROXY_EMAIL_DOMAINS and OAUTH2_PROXY_UPSTREAMS.

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.6-alpine

ENV OAUTH2_PROXY_PROVIDER=oidc \
    OAUTH2_PROXY_SCOPE="openid email profile" \
    OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256 \
    OAUTH2_PROXY_EMAIL_DOMAINS=* \
    OAUTH2_PROXY_PASS_BASIC_AUTH=true \
    OAUTH2_PROXY_PREFER_EMAIL_TO_USER=true \
    OAUTH2_PROXY_BASIC_AUTH_PASSWORD=unused-zabbix-ignores-it \
    OAUTH2_PROXY_PASS_HOST_HEADER=true \
    OAUTH2_PROXY_REVERSE_PROXY=true \
    OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true \
    OAUTH2_PROXY_COOKIE_SECURE=true \
    OAUTH2_PROXY_COOKIE_NAME=_zabbix_oidc

USER 65532

# The alpine variant has a shell, so the listen port can follow Railway's PORT.
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/oauth2-proxy --http-address=0.0.0.0:${PORT:-4180}"]

#!/usr/bin/env bash
# Render the Zabbix SP metadata for upload to Zitadel and check it.
#   render-sp-metadata.sh <zabbix-domain> <sp-cert.pem> > zabbix-sp-metadata.xml
# <zabbix-domain> is the bare public host name, e.g. zabbix-poc.up.railway.app.
# The SP certificate is public; the matching private key never goes in here.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
domain=${1:?usage: render-sp-metadata.sh <zabbix-domain> <sp-cert.pem>}
cert=${2:?usage: render-sp-metadata.sh <zabbix-domain> <sp-cert.pem>}

if [[ ! $domain =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || [[ $domain != *.* ]]; then
  echo "error: '$domain' is not a bare host name (no scheme, path or port)" >&2; exit 1
fi
openssl x509 -in "$cert" -noout 2>/dev/null || { echo "error: '$cert' is not a PEM certificate" >&2; exit 1; }
b64=$(openssl x509 -in "$cert" -outform DER | base64 -w0)

python3 - "$here/sp-metadata.template.xml" "$domain" "$b64" <<'PY'
import sys, xml.dom.minidom
tpl, domain, b64 = sys.argv[1:4]
s = open(tpl).read()
for k in ("ZABBIX_DOMAIN", "SP_CERT_BASE64"):
    if k not in s:
        sys.exit(f"error: placeholder {k} missing from template")
s = s.replace("ZABBIX_DOMAIN", domain).replace("SP_CERT_BASE64", b64)
doc = xml.dom.minidom.parseString(s.encode())   # must be well-formed
ed = doc.documentElement
acs = doc.getElementsByTagName("md:AssertionConsumerService")[0].getAttribute("Location")
assert ed.getAttribute("entityID") == f"https://{domain}/zabbix-sp", ed.getAttribute("entityID")
assert acs == f"https://{domain}/index_sso.php?acs", acs
assert "ZABBIX_DOMAIN" not in s and "SP_CERT_BASE64" not in s
sys.stdout.write(s)
print(f"ok: entityID=https://{domain}/zabbix-sp ACS={acs}", file=sys.stderr)
PY

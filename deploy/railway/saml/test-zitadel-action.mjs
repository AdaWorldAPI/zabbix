// Offline check of zitadel-action-zabbix-roles.js against a fake ctx/api.
// It proves the filter, not Zitadel: the live assertion must still be checked
// (ZITADEL-SAML-SETUP.md, "Verify the assertion").
// Run: node deploy/railway/saml/test-zitadel-action.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const src = readFileSync(fileURLToPath(new URL('./zitadel-action-zabbix-roles.js', import.meta.url)), 'utf8');
const PROJECT = '111111111111111111';
const OTHER = '222222222222222222';
assert.equal(src.split("'REPLACE_WITH_PROJECT_ID'").length, 2, 'placeholder must occur exactly once');
const zabbixRoles = new Function(src.replace("'REPLACE_WITH_PROJECT_ID'", `'${PROJECT}'`) + '\nreturn zabbixRoles;')();

function run(grants) {
  const calls = [];
  const api = { v1: { attributes: { setCustomAttribute: (k, f, ...v) => calls.push([k, f, v]) } } };
  zabbixRoles({ v1: { user: { grants } } }, api);
  return calls;
}
const g = (projectId, roles) => ({ projectId, roles });

// 1. Allowed roles of the Zabbix project are emitted, project-prefixed, once.
assert.deepEqual(
  run({ count: 1, grants: [g(PROJECT, ['zabbix.viewer', 'zabbix.admin', 'zabbix.viewer'])] }),
  [['Roles', '', [`${PROJECT}:zabbix.viewer`, `${PROJECT}:zabbix.admin`]]]);

// 2. Grants of another project never leave, even with a Zabbix-looking key.
assert.deepEqual(
  run({ count: 2, grants: [g(OTHER, ['zabbix.admin', 'report.admin']), g(PROJECT, ['zabbix.operator'])] }),
  [['Roles', '', [`${PROJECT}:zabbix.operator`]]]);

// 3. Non-allow-listed keys of the Zabbix project are dropped (no prefix match).
assert.deepEqual(run({ count: 1, grants: [g(PROJECT, ['zabbix.admins', 'admin', 'zabbix.viewer.x'])] }), []);

// 4. No grants / no matching grant -> no attribute at all (Zabbix then denies).
assert.deepEqual(run(undefined), []);
assert.deepEqual(run({ count: 0, grants: [] }), []);
assert.deepEqual(run({ count: 1, grants: [g(OTHER, ['zabbix.viewer'])] }), []);
assert.deepEqual(run({ count: 1, grants: [{ projectId: PROJECT }] }), []);

console.log('zitadel action: 4 checks passed');

/**
 * Zitadel Action (Actions v1) that adds a multivalued SAML attribute "Roles"
 * holding ONLY the Zabbix roles of ONE Zitadel project.
 *
 * Console: Actions -> New action, name "zabbixRoles" (must equal the function
 * name below), then Flows -> "Complement SAMLResponse" -> trigger
 * "Pre SAMLResponse creation" -> add this action.
 *
 * Why the filter: ctx.v1.user.grants lists the user's grants across projects,
 * and Zitadel's own example emits all of them. Zabbix stores every received
 * group name (table scim_group), so unfiltered grants of other applications
 * would be copied into Zabbix. Only exact, allow-listed keys leave here.
 *
 * Scope: the trigger runs for SAML responses of every SAML application in the
 * organization, and this trigger has no application field to branch on. Any
 * other SAML application in the organization therefore also receives "Roles"
 * with these Zabbix values (and only these).
 *
 * No matching grant -> no "Roles" attribute -> Zabbix maps no group -> no access.
 */

// Replace with the Zitadel project ID that holds the Zabbix roles.
var ZABBIX_PROJECT_ID = 'REPLACE_WITH_PROJECT_ID';

// Exact role keys allowed into the assertion. Nothing else is emitted.
var ZABBIX_ROLE_KEYS = ['zabbix.viewer', 'zabbix.operator', 'zabbix.admin'];

function zabbixRoles(ctx, api) {
  var grants = ctx.v1.user.grants;
  if (grants == undefined || grants.count == 0) {
    return;
  }
  var roles = [];
  grants.grants.forEach(function (grant) {
    if (grant.projectId !== ZABBIX_PROJECT_ID || grant.roles == undefined) {
      return;
    }
    grant.roles.forEach(function (role) {
      var value = grant.projectId + ':' + role;
      if (ZABBIX_ROLE_KEYS.indexOf(role) !== -1 && roles.indexOf(value) === -1) {
        roles.push(value);
      }
    });
  });
  if (roles.length == 0) {
    return;
  }
  api.v1.attributes.setCustomAttribute('Roles', '', ...roles);
}

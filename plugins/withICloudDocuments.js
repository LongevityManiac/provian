/**
 * Expo config plugin: the iCloud ubiquity container the PE backup writes to
 * (modules/provian-icloud-documents, src/core/meter/cloudFiles.ts).
 *
 * Adds the iCloud Documents entitlements for `iCloud.com.provian.wallet` and the matching
 * NSUbiquitousContainers Info.plist entry (so the space shows as "Provian" under Settings → iCloud →
 * Manage Storage). The container must also exist in the Apple Developer portal and be enabled on the
 * App ID `com.provian.wallet`, and the provisioning profile must be regenerated to carry it.
 */
const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

const CONTAINER_ID = 'iCloud.com.provian.wallet';

function addUnique(list, value) {
  const out = Array.isArray(list) ? [...list] : [];
  if (!out.includes(value)) out.push(value);
  return out;
}

module.exports = function withICloudDocuments(config) {
  config = withEntitlementsPlist(config, (cfg) => {
    const e = cfg.modResults;
    e['com.apple.developer.icloud-container-identifiers'] = addUnique(e['com.apple.developer.icloud-container-identifiers'], CONTAINER_ID);
    e['com.apple.developer.ubiquity-container-identifiers'] = addUnique(e['com.apple.developer.ubiquity-container-identifiers'], CONTAINER_ID);
    e['com.apple.developer.icloud-services'] = addUnique(e['com.apple.developer.icloud-services'], 'CloudDocuments');
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    const containers = cfg.modResults.NSUbiquitousContainers || {};
    containers[CONTAINER_ID] = {
      NSUbiquitousContainerIsDocumentScopePublic: false,
      NSUbiquitousContainerName: 'Provian',
      NSUbiquitousContainerSupportedFolderLevels: 'Any',
    };
    cfg.modResults.NSUbiquitousContainers = containers;
    return cfg;
  });
  return config;
};

module.exports.CONTAINER_ID = CONTAINER_ID;

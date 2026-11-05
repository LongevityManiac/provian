const { withXcodeProject, withPodfile } = require('@expo/config-plugins');

const PHASE_NAME = '[Provian] Verify embedded runtimes';
function addRuntimeGuard(project) {
  const target = project.getFirstTarget().uuid;
  const phases = project.pbxNativeTargetSection()[target].buildPhases;
  const shellPhases = project.hash.project.objects.PBXShellScriptBuildPhase;
  const existing = phases.find(p => shellPhases[p.value]?.name?.replaceAll('"', '') === PHASE_NAME);
  if (!existing) {
    const result = project.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE_NAME, target, {
      shellPath: '/bin/sh',
      shellScript: '. "$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"\n"$NODE_BINARY" "$SRCROOT/../scripts/check-ios-runtime.mjs" "$CONFIGURATION" "$PODS_ROOT" "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH" "$PLATFORM_NAME"',
    });
    result.buildPhase.alwaysOutOfDate = 1;
    result.buildPhase.showEnvVarsInLog = 0;
  } else {
    // Keep verification after CocoaPods embedding, including after repeated prebuilds.
    phases.splice(phases.indexOf(existing), 1);
    phases.push(existing);
  }
  return project;
}

const POST_INTEGRATE_MARKER = '# Provian: verify runtimes after CocoaPods embeds frameworks.';
function addPostIntegrate(contents) {
  if (contents.includes(POST_INTEGRATE_MARKER)) return contents;
  if (/^\s*post_integrate\b/m.test(contents)) throw new Error('Merge the existing post_integrate hook with the iOS runtime guard');
  return contents + `
${POST_INTEGRATE_MARKER}
post_integrate do |installer|
  installer.aggregate_targets.map(&:user_project).uniq.each do |project|
    project.native_targets.each do |target|
      guard = target.shell_script_build_phases.find { |phase| phase.name == '${PHASE_NAME}' }
      next unless guard
      target.build_phases.delete(guard)
      target.build_phases << guard
    end
    project.save
  end
end
`;
}

module.exports = config => {
  config = withXcodeProject(config, cfg => {
    addRuntimeGuard(cfg.modResults);
    return cfg;
  });
  return withPodfile(config, cfg => {
    cfg.modResults.contents = addPostIntegrate(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.addRuntimeGuard = addRuntimeGuard;
module.exports.PHASE_NAME = PHASE_NAME;
module.exports.addPostIntegrate = addPostIntegrate;

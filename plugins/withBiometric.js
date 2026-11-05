const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withBiometric(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('androidx.biometric')) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*\{/,
        'dependencies {\n    implementation("androidx.biometric:biometric:1.2.0-alpha05")'
      );
    }
    return config;
  });
};

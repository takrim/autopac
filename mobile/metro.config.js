const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Ensure Metro resolves the "react-native" condition in package.json exports
// so that @firebase/auth uses its RN build (with getReactNativePersistence)
config.resolver.unstable_conditionNames = [
  "react-native",
  "browser",
  "require",
  "import",
];

module.exports = config;

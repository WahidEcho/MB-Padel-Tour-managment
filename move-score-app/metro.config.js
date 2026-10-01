// The app shares the web platform's pure scoring engine and API contract by
// importing them straight from ../src/lib (see src/core/index.ts). Metro is told
// to watch that folder and to resolve packages from this app's node_modules only,
// so a shared file never picks up the web app's dependencies.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, "../src/lib");
config.watchFolders = [...(config.watchFolders ?? []), shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
module.exports = config;

// The stock React Native Metro config and nothing else: no watchFolders, no resolver overrides, no extraNodeModules. A phone
// app that adds the packed engine gets exactly this, so this is what must be able to resolve it.
import metroConfig from "@react-native/metro-config";

export default metroConfig.mergeConfig(metroConfig.getDefaultConfig(import.meta.dirname), {});

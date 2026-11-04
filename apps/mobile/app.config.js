const base = require('./app.json').expo;

module.exports = () => {
  const production = process.env.EAS_BUILD_PROFILE === 'production' || process.env.APP_VARIANT === 'production';
  if (production) {
    if (!process.env.EXPO_PUBLIC_API_URL) throw new Error('A production build requires an explicit EXPO_PUBLIC_API_URL.');
    const api = new URL(process.env.EXPO_PUBLIC_API_URL);
    if (api.protocol !== 'https:' || api.hostname === 'dev.ageniza.com.br' || ['localhost', '127.0.0.1', '10.0.2.2'].includes(api.hostname) || api.username || api.password || api.search || api.hash) {
      throw new Error('A production build requires the approved HTTPS production API, without credentials or query parameters.');
    }
  }
  const internal = process.env.APP_VARIANT === 'internal';
  return {
    ...base,
    name: internal ? 'Ageniza Interno' : base.name,
    android: { ...base.android, package: internal ? 'com.ageniza.mobile.internal' : base.android.package },
    ios: { ...base.ios, bundleIdentifier: internal ? 'com.ageniza.mobile.internal' : base.ios.bundleIdentifier },
    ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID ? { extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } } } : {})
  };
};

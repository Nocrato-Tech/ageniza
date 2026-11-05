import { Platform } from 'react-native';

export function allowsDemoWorkspace(platform: string, flag: string | undefined, apiUrl: string) {
  if (platform !== 'web' || flag !== 'true') return false;
  const url = new URL(apiUrl);
  return !url.username && !url.password && !url.search && !url.hash && (url.origin === 'https://dev.ageniza.com.br' || ['localhost', '127.0.0.1'].includes(url.hostname));
}

export const demoWorkspaceEnabled = allowsDemoWorkspace(Platform.OS, process.env.EXPO_PUBLIC_DEMO_WORKSPACE, process.env.EXPO_PUBLIC_API_URL ?? 'https://dev.ageniza.com.br/api');
export const demoAgencyName = 'Agência Horizonte · Demonstração';

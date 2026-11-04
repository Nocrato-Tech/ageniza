import { Platform } from 'react-native';
import { fetch as nativeFetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { getCookie, getSetCookie, hasBetterAuthCookies } from '@better-auth/expo/client';
import { createApiClient } from './client';

export const webUrl = new URL(process.env.EXPO_PUBLIC_API_URL ?? 'https://dev.ageniza.com.br/api').origin;
export const browserPreview = Platform.OS === 'web' && typeof location !== 'undefined' && location.origin !== new URL(process.env.EXPO_PUBLIC_API_URL ?? webUrl).origin;
export const api = createApiClient(process.env.EXPO_PUBLIC_API_URL ?? `${webUrl}/api`, {
  get: () => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync('ageniza.session'),
  set: (value) => Platform.OS === 'web' ? Promise.resolve() : SecureStore.setItemAsync('ageniza.session', value),
  clear: () => Platform.OS === 'web' ? Promise.resolve() : SecureStore.deleteItemAsync('ageniza.session')
}, Platform.OS !== 'web', { getCookie, getSetCookie, hasBetterAuthCookies }, Platform.OS === 'web' ? fetch : nativeFetch as typeof fetch);

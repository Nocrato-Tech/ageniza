export const presentationRoute = (path: string, enabled: string | undefined) => enabled === 'true' && /^\/apresentacao\/?$/.test(path);

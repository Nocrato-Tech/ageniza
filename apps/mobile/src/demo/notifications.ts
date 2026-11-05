export type NotificationOutcome = 'sent' | 'denied' | 'unsupported';
async function requestPermission(): Promise<NotificationPermission> {
  const pending = Notification.requestPermission();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A permissão está pendente no navegador. Confira o aviso deste site e tente novamente.')), 15_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function sendContentNotification(count: number): Promise<NotificationOutcome> {
  if (typeof window === 'undefined' || !window.isSecureContext || typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const permission = Notification.permission === 'default' ? await requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.register('/app-mobile/content-notifications.js', { scope: '/app-mobile/' });
  if (!registration.active) {
    const worker = registration.installing ?? registration.waiting;
    if (!worker) throw new Error('Não foi possível iniciar as notificações. Tente novamente.');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); worker.removeEventListener('statechange', change); if (error) reject(error); else resolve(); };
      const change = () => { if (worker.state === 'activated') finish(); else if (worker.state === 'redundant') finish(new Error('Atualize a página e tente novamente.')); };
      const timer = setTimeout(() => finish(new Error('A ativação demorou. Tente enviar novamente.')), 15_000);
      worker.addEventListener('statechange', change);
      change();
    });
  }
  await registration.showNotification('Ageniza · atividades do fluxo', { body: `${count} atividade(s) no período. Abra o Ageniza para consultar.`, tag: 'ageniza-content-activity' });
  return 'sent';
}

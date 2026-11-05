export type NotificationOutcome = 'sent' | 'denied' | 'unsupported';
export async function sendPresentationNotification(): Promise<NotificationOutcome> {
  if (typeof window === 'undefined' || !window.isSecureContext || typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.register('/presentation-notifications.js', { scope: '/apresentacao/' });
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
  await registration.showNotification('Ageniza · aprovação pendente', { body: 'Demonstração: um conteúdo está pronto para você revisar.', tag: 'ageniza-academic-demo', icon: '/favicon.ico' });
  return 'sent';
}

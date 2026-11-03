export type DemoStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved';
export interface DemoPost { id: string; clientId: string; title: string; caption: string; day: number; status: DemoStatus; feedback?: string }
export const demoClients = [
  { id: 'vida', name: 'Clínica Vida', handle: 'clinicavida.demo', initials: 'CV' },
  { id: 'sorriso', name: 'Studio Sorriso', handle: 'studiosorriso.demo', initials: 'SS' }
];
export function initialPosts(): DemoPost[] {
  return [
    { id: 'post-1', clientId: 'vida', title: 'Um cuidado por dia', caption: 'Pequenos hábitos fazem diferença. Reserve um momento do seu dia para cuidar de você.\n\nConteúdo fictício para demonstração.', day: 5, status: 'awaiting_approval' },
    { id: 'post-2', clientId: 'vida', title: 'Conheça nossa equipe', caption: 'Pessoas que acolhem, escutam e cuidam. Conheça quem está por trás de cada atendimento.', day: 12, status: 'in_production' },
    { id: 'post-3', clientId: 'vida', title: 'Novembro de prevenção', caption: 'Informação também é cuidado. Converse com um profissional e mantenha sua rotina de acompanhamento.', day: 19, status: 'approved' },
    { id: 'post-4', clientId: 'sorriso', title: 'Motivos para sorrir', caption: 'Seu sorriso faz parte da sua história. Vamos cuidar dele juntos?\n\nExemplo fictício.', day: 8, status: 'awaiting_approval' }
  ];
}
export function decidePost(posts: DemoPost[], id: string, action: 'submit' | 'approve' | 'changes', comment = ''): DemoPost[] {
  return posts.map((post) => {
    if (post.id !== id) return post;
    if (action === 'submit' && ['in_production', 'adjusting'].includes(post.status)) return { ...post, status: 'awaiting_approval' };
    if (post.status !== 'awaiting_approval') return post;
    if (action === 'approve') return { ...post, status: 'approved', feedback: undefined };
    if (action === 'changes' && comment.trim()) return { ...post, status: 'adjusting', feedback: comment.trim() };
    return post;
  });
}

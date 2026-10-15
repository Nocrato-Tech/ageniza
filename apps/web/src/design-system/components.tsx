import { useState, type ReactNode } from 'react';
import { ArrowRight, LayoutGrid, List, Plus, Store } from 'lucide-react';
import {
  Avatar, BadgeCard, BrandSymbol, Button, ButtonLink, ChoiceCard, ClientStrip, IconButton, Pill, PillAction, ConfirmDialog, Dialog, EmptyState, ErrorSummary, Field, FieldMessage, FilterBar, FilterBarItem, FilterBarSelect, FormatTag, LateBadge, Logo, LiveStatus, Mascot, Menu, MenuItem, MenuSeparator,
  Modal, Pagination, Popover, Realce, Segmented, Select, Skeleton, StatusTag, Tabs, Textarea, TextInput
} from '@ageniza/ui';

/** `hover` and `focus` are real interactions on the default render, so they are not states a component implements. */
export type RenderedState = 'default' | 'disabled' | 'loading';

export interface ComponentExample {
  readonly label: string;
  /** Returns `null` for a state the component does not have. */
  readonly render: (state: RenderedState) => ReactNode;
}

export interface ComponentEntry {
  readonly id: string;
  readonly name: string;
  /** Exported components this entry shows; a component of `@ageniza/ui` that no entry covers fails the page's test. */
  readonly covers: readonly string[];
  /** A component too wide for five columns: the page puts the states in rows instead. */
  readonly wide?: boolean;
  readonly examples: readonly ComponentExample[];
}

function Opener({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="secondary" onClick={() => setOpen(true)}>{label}</Button>
    {open && children(() => setOpen(false))}
  </>;
}

function PaginationDemo() {
  const [page, setPage] = useState(3);
  return <Pagination page={page} totalPages={9} onPageChange={setPage} summary="Página de exemplo" />;
}

function SelectDemo({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState('');
  return <Select label="Cliente" value={value} onChange={setValue} placeholder="Todos" disabled={disabled}
    options={[{ value: 'a', label: 'Cliente A' }, { value: 'b', label: 'Cliente B' }]} />;
}

function CounterFieldDemo({ disabled, loading }: { disabled: boolean; loading: boolean }) {
  const [caption, setCaption] = useState('Pão de fermentação natural, 48 horas de espera.');
  return <Field label="Legenda" hint="Aparece no feed" loading={loading} counter={{ count: caption.length, max: 80 }}>
    {(control) => <Textarea {...control} value={caption} onChange={(event) => setCaption(event.target.value)} disabled={disabled} />}
  </Field>;
}

const STRIP_CLIENTS = [
  { id: 'c1', name: 'Padaria Central', href: '#client-strip' },
  { id: 'c2', name: 'Clínica Viver Bem', href: '#client-strip', attention: ['em ajuste', 'em atraso'] },
  { id: 'c3', name: 'Café do Alto', href: '#client-strip' }
] as const;

function FilterBarDemo({ disabled, loading }: { disabled: boolean; loading: boolean }) {
  const [month, setMonth] = useState('10');
  const [client, setClient] = useState('');
  return <FilterBar label="Filtros do calendário">
    <FilterBarSelect label="Mês" value={month} onChange={setMonth} disabled={disabled} loading={loading}
      options={[{ value: '10', label: 'Outubro de 2026' }, { value: '11', label: 'Novembro de 2026' }]} />
    <FilterBarSelect label="Cliente" value={client} onChange={setClient} placeholder="Todos" disabled={disabled}
      options={[{ value: 'c1', label: 'Padaria Central' }, { value: 'c2', label: 'Clínica Viver Bem' }]} />
    <FilterBarItem label="Buscar">{(control) => <TextInput {...control} defaultValue="pão" disabled={disabled} />}</FilterBarItem>
  </FilterBar>;
}

function SegmentedDemo({ disabled, loading }: { disabled: boolean; loading: boolean }) {
  const [value, setValue] = useState('grid');
  return <Segmented label="Visualização" value={value} onChange={setValue} disabled={disabled} loading={loading}
    options={[{ value: 'grid', label: 'Grade', icon: <LayoutGrid /> }, { value: 'list', label: 'Lista', icon: <List /> }, { value: 'map', label: 'Mapa', disabled: true }]} />;
}

function TabsDemo({ disabled, loading }: { disabled: boolean; loading: boolean }) {
  const [value, setValue] = useState('general');
  return <Tabs label="Seções do cliente" value={value} onChange={setValue} loading={loading}
    items={[
      { value: 'general', label: 'Geral', disabled, content: <p>Conteúdo da aba Geral.</p> },
      { value: 'contents', label: 'Conteúdos', count: 12, disabled, content: <p>Conteúdo da aba Conteúdos.</p> },
      { value: 'reports', label: 'Relatórios', disabled: true, content: <p>Conteúdo da aba Relatórios.</p> }
    ]} />;
}

const stateOnly = (state: RenderedState, only: readonly RenderedState[], node: ReactNode): ReactNode => only.includes(state) ? node : null;

/**
 * Add a component by appending an entry: the page renders its states and tells the person when one does not apply.
 * Keep the order of `@ageniza/ui` so a component missing here is easy to spot.
 */
export const componentEntries: readonly ComponentEntry[] = [
  {
    id: 'button',
    name: 'Button',
    covers: ['Button'],
    examples: (['primary', 'secondary', 'ghost', 'destructive'] as const).map((variant) => ({
      label: variant,
      render: (state: RenderedState) => <Button variant={variant} disabled={state === 'disabled'} loading={state === 'loading'}>Salvar</Button>
    }))
  },
  {
    id: 'button-sizes',
    name: 'Button, tamanhos',
    covers: ['Button'],
    examples: (['sm', 'md', 'lg'] as const).map((size) => ({
      label: size,
      render: (state: RenderedState) => <Button size={size} disabled={state === 'disabled'} loading={state === 'loading'}>Salvar</Button>
    }))
  },
  {
    id: 'button-icons',
    name: 'Button com ícone e IconButton',
    covers: ['Button', 'IconButton'],
    examples: [
      { label: 'ícone antes', render: (state) => <Button leadingIcon={<Plus />} disabled={state === 'disabled'} loading={state === 'loading'}>Novo</Button> },
      { label: 'ícone depois', render: (state) => <Button variant="secondary" trailingIcon={<ArrowRight />} disabled={state === 'disabled'} loading={state === 'loading'}>Abrir</Button> },
      { label: 'só ícone', render: (state) => <IconButton label="Adicionar" icon={<Plus />} disabled={state === 'disabled'} loading={state === 'loading'} /> },
      { label: 'só ícone, secundário', render: (state) => <IconButton variant="secondary" label="Adicionar" icon={<Plus />} disabled={state === 'disabled'} loading={state === 'loading'} /> }
    ]
  },
  {
    id: 'button-link',
    name: 'ButtonLink',
    covers: ['ButtonLink'],
    examples: [
      ...(['primary', 'secondary', 'ghost', 'destructive'] as const).map((variant) => ({
        label: variant,
        render: (state: RenderedState) => stateOnly(state, ['default', 'disabled'], <ButtonLink href="#button-link" variant={variant} disabled={state === 'disabled'}>Ver clientes</ButtonLink>)
      })),
      { label: 'com ícone', render: (state: RenderedState) => stateOnly(state, ['default', 'disabled'], <ButtonLink href="#button-link" leadingIcon={<Plus />} trailingIcon={<ArrowRight />} disabled={state === 'disabled'}>Novo cliente</ButtonLink>) }
    ]
  },
  {
    id: 'pill',
    name: 'Pill e PillAction',
    covers: ['Pill', 'PillAction'],
    examples: [
      { label: 'Pill neutra', render: (state) => stateOnly(state, ['default'], <Pill>12 conteúdos</Pill>) },
      { label: 'Pill de destaque', render: (state) => stateOnly(state, ['default'], <Pill tone="accent" icon={<Plus />}>Hoje</Pill>) },
      { label: 'PillAction neutra', render: (state) => <PillAction trailingIcon={<ArrowRight />} disabled={state === 'disabled'} loading={state === 'loading'}>Abrir</PillAction> },
      { label: 'PillAction de destaque', render: (state) => <PillAction tone="accent" disabled={state === 'disabled'} loading={state === 'loading'}>Sua vez</PillAction> }
    ]
  },
  {
    id: 'segmented',
    name: 'Segmented',
    covers: ['Segmented'],
    wide: true,
    examples: [{ label: 'grade, lista e mapa (desativado)', render: (state) => <SegmentedDemo disabled={state === 'disabled'} loading={state === 'loading'} /> }]
  },
  {
    id: 'tabs',
    name: 'Tabs',
    covers: ['Tabs'],
    wide: true,
    examples: [{ label: 'com contagem e aba desativada', render: (state) => <TabsDemo disabled={state === 'disabled'} loading={state === 'loading'} /> }]
  },
  {
    id: 'field',
    name: 'Field',
    covers: ['Field'],
    examples: [
      {
        label: 'com dica',
        render: (state) => <Field label="Título" hint="Até 80 caracteres" loading={state === 'loading'}>
          {(control) => <TextInput {...control} defaultValue="Cardápio de outono" disabled={state === 'disabled'} />}
        </Field>
      },
      {
        label: 'com erro',
        render: (state) => stateOnly(state, ['default'], <Field label="E-mail" error="Informe um e-mail válido.">
          {(control) => <TextInput {...control} defaultValue="maria@" />}
        </Field>)
      },
      { label: 'com contador, passe de 80 para ver o limite', render: (state) => <CounterFieldDemo disabled={state === 'disabled'} loading={state === 'loading'} /> }
    ]
  },
  {
    id: 'error-summary',
    name: 'ErrorSummary',
    covers: ['ErrorSummary'],
    examples: [
      { label: 'com três campos recusados', render: (state) => stateOnly(state, ['default'], <ErrorSummary labels={['Dia dos stories', 'Texto da cena 1', 'Orientação da cena 1']} />) }
    ]
  },
  {
    id: 'text-input',
    name: 'TextInput',
    covers: ['TextInput'],
    examples: [
      { label: 'com rótulo', render: (state) => stateOnly(state, ['default', 'disabled'], <label>Nome<TextInput defaultValue="Maria" disabled={state === 'disabled'} /></label>) },
      { label: 'com erro', render: (state) => stateOnly(state, ['default'], <><TextInput aria-label="E-mail" aria-invalid defaultValue="maria@" /><FieldMessage>Informe um e-mail válido.</FieldMessage></>) }
    ]
  },
  {
    id: 'textarea',
    name: 'Textarea',
    covers: ['Textarea'],
    examples: [{ label: 'padrão', render: (state) => stateOnly(state, ['default', 'disabled'], <Textarea aria-label="Observação" defaultValue="Texto de exemplo" disabled={state === 'disabled'} />) }]
  },
  {
    id: 'select',
    name: 'Select',
    covers: ['Select'],
    examples: [{ label: 'padrão', render: (state) => stateOnly(state, ['default', 'disabled'], <SelectDemo disabled={state === 'disabled'} />) }]
  },
  {
    id: 'choice-card',
    name: 'ChoiceCard',
    covers: ['ChoiceCard'],
    examples: [
      { label: 'padrão', render: (state) => stateOnly(state, ['default', 'disabled'], <ChoiceCard title="Agência Um" description="Proprietário" disabled={state === 'disabled'} />) },
      { label: 'sugerido', render: (state) => stateOnly(state, ['default', 'disabled'], <ChoiceCard title="Agência Dois" description="Colaborador" highlighted badge="Sugerido" disabled={state === 'disabled'} />) },
      { label: 'com ícone do tipo', render: (state) => stateOnly(state, ['default', 'disabled'], <ChoiceCard title="Padaria Santa Clara" description="Portal do cliente · Estúdio Aurora" icon={<Store />} disabled={state === 'disabled'} />) }
    ]
  },
  {
    id: 'messages',
    name: 'FieldMessage e LiveStatus',
    covers: ['FieldMessage', 'LiveStatus'],
    examples: [
      { label: 'mensagem de campo', render: (state) => stateOnly(state, ['default'], <FieldMessage>Informe um e-mail válido.</FieldMessage>) },
      { label: 'status', render: (state) => stateOnly(state, ['default'], <LiveStatus>Salvando…</LiveStatus>) }
    ]
  },
  {
    id: 'avatar',
    name: 'Avatar',
    covers: ['Avatar'],
    examples: [
      ...(['sm', 'md', 'lg'] as const).map((size) => ({ label: size, render: (state: RenderedState) => stateOnly(state, ['default'], <Avatar name="Maria Souza" size={size} />) })),
      { label: 'com anel de atenção', render: (state: RenderedState) => stateOnly(state, ['default'], <Avatar name="Padaria Central" size="lg" attention="em ajuste, em atraso" />) }
    ]
  },
  {
    id: 'client-strip',
    name: 'ClientStrip',
    covers: ['ClientStrip'],
    wide: true,
    examples: [{ label: 'um cliente aberto e um com anel de atenção', render: (state) => stateOnly(state, ['default'], <ClientStrip label="Clientes de exemplo" items={STRIP_CLIENTS} selectedId="c1" />) }]
  },
  {
    id: 'filter-bar',
    name: 'FilterBar',
    covers: ['FilterBar', 'FilterBarItem', 'FilterBarSelect'],
    wide: true,
    examples: [{ label: 'rótulo acima, escolha abaixo, divisórias', render: (state) => <FilterBarDemo disabled={state === 'disabled'} loading={state === 'loading'} /> }]
  },
  {
    id: 'format-tag',
    name: 'FormatTag',
    covers: ['FormatTag'],
    examples: [
      { label: 'carrossel', render: (state) => stateOnly(state, ['default'], <FormatTag format="carousel">Carrossel</FormatTag>) },
      { label: 'reels', render: (state) => stateOnly(state, ['default'], <FormatTag format="reels">Reels</FormatTag>) },
      { label: 'estático', render: (state) => stateOnly(state, ['default'], <FormatTag format="static">Estático</FormatTag>) }
    ]
  },
  {
    id: 'status-tag',
    name: 'StatusTag',
    covers: ['StatusTag'],
    examples: ([
      ['ready', 'Pronto para publicar'], ['waiting', 'Aguardando'], ['adjust', 'Em ajuste'], ['published', 'Publicado'], ['production', 'Em produção']
    ] as const).map(([status, label]) => ({ label: status, render: (state: RenderedState) => stateOnly(state, ['default'], <StatusTag status={status}>{label}</StatusTag>) }))
  },
  {
    id: 'late-badge',
    name: 'LateBadge',
    covers: ['LateBadge'],
    examples: [{ label: 'padrão', render: (state) => stateOnly(state, ['default'], <LateBadge />) }]
  },
  {
    id: 'realce',
    name: 'Realce',
    covers: ['Realce'],
    examples: [
      { label: 'parado', render: (state) => stateOnly(state, ['default'], <span>Você tem <Realce>2 posts</Realce> esperando</span>) },
      { label: 'varrido', render: (state) => stateOnly(state, ['default'], <span>Hoje, dia <Realce sweep>13</Realce></span>) }
    ]
  },
  {
    id: 'badge-card',
    name: 'BadgeCard',
    covers: ['BadgeCard'],
    examples: [
      { label: 'ativo', render: (state) => stateOnly(state, ['default'], <BadgeCard name="Maria Souza" jobTitle="Social media" role="Editor" />) },
      { label: 'removido', render: (state) => stateOnly(state, ['default'], <BadgeCard name="João Lima" role="Editor" removed />) }
    ]
  },
  {
    id: 'pagination',
    name: 'Pagination',
    covers: ['Pagination'],
    wide: true,
    examples: [{ label: 'padrão', render: (state) => stateOnly(state, ['default'], <PaginationDemo />) }]
  },
  {
    id: 'skeleton',
    name: 'Skeleton',
    covers: ['Skeleton'],
    examples: [{ label: 'bloco', render: (state) => stateOnly(state, ['loading'], <Skeleton style={{ width: '12rem', height: '1.5rem' }} />) }]
  },
  {
    id: 'mascot',
    name: 'Mascot',
    covers: ['Mascot'],
    examples: [
      { label: 'amigável (estado vazio)', render: (state) => stateOnly(state, ['default'], <Mascot variant="friendly" height={120} />) },
      { label: 'sério (erro)', render: (state) => stateOnly(state, ['default'], <Mascot variant="serious" height={120} />) }
    ]
  },
  {
    id: 'empty-state',
    name: 'EmptyState',
    covers: ['EmptyState'],
    wide: true,
    examples: [
      { label: 'com mascote e ação', render: (state) => stateOnly(state, ['default'], <EmptyState mascot headingLevel={4} title="Cadastre o primeiro cliente" description="Com o cliente cadastrado você monta o calendário do mês." action={<Button leadingIcon={<Plus />}>Cadastrar cliente</Button>} />) },
      { label: 'sem mascote (busca sem resultado)', render: (state) => stateOnly(state, ['default'], <EmptyState headingLevel={4} title="Nenhum cliente encontrado" description="Tente outro nome ou tire um filtro." action={<Button variant="secondary">Limpar filtros</Button>} />) }
    ]
  },
  {
    id: 'brand',
    name: 'Logo e BrandSymbol',
    covers: ['Logo', 'BrandSymbol'],
    examples: [
      { label: 'logo sobre claro', render: (state) => stateOnly(state, ['default'], <span className="ds-backdrop ds-backdrop--light"><Logo variant="on-light" height={32} /></span>) },
      { label: 'logo sobre escuro', render: (state) => stateOnly(state, ['default'], <span className="ds-backdrop ds-backdrop--dark"><Logo variant="on-dark" height={32} /></span>) },
      { label: 'símbolo', render: (state) => stateOnly(state, ['default'], <BrandSymbol variant="color" size={32} />) }
    ]
  },
  {
    id: 'menu',
    name: 'Menu',
    covers: ['Menu', 'MenuItem', 'MenuSeparator'],
    examples: [{
      label: 'padrão',
      render: (state) => stateOnly(state, ['default'], <Menu label="Ações de exemplo" trigger="Ações">
        <MenuItem>Editar</MenuItem><MenuItem disabled>Duplicar</MenuItem><MenuSeparator /><MenuItem variant="destructive">Excluir</MenuItem>
      </Menu>)
    }]
  },
  {
    id: 'dialog',
    name: 'Dialog',
    covers: ['Dialog'],
    examples: (['sm', 'md', 'lg'] as const).map((size) => ({
      label: size,
      render: (state: RenderedState) => stateOnly(state, ['default', 'loading'], <Opener label={`Abrir ${size}`}>
        {(close) => <Dialog title="Arquivar cliente" closeLabel="Fechar" onClose={close} size={size} loading={state === 'loading'}
          description="A Padaria Central deixa a carteira, mas o histórico fica."
          actions={<><Button variant="secondary" onClick={close}>Cancelar</Button><Button variant="destructive" onClick={close}>Arquivar</Button></>}>
          <p>Conteúdo de exemplo.</p>
        </Dialog>}
      </Opener>)
    }))
  },
  {
    id: 'popover',
    name: 'Popover',
    covers: ['Popover'],
    examples: [
      {
        label: 'ao clique',
        render: (state) => <div className="ds-floating-room"><Popover label="Detalhes do post" disabled={state === 'disabled'} loading={state === 'loading'}
          trigger={(trigger) => <Button variant="secondary" {...trigger}>Ver detalhes</Button>}>
          <strong>Carrossel: Pão de fermentação natural</strong>
          <span>03 de ago. · Instagram</span>
        </Popover></div>
      },
      {
        label: 'ao passar o mouse (300 ms) ou focar',
        render: (state) => <div className="ds-floating-room"><Popover label="Prévia do post" openOn="hover" placement="bottom-end" disabled={state === 'disabled'} loading={state === 'loading'}
          trigger={(trigger) => <Button variant="ghost" {...trigger}>Prévia</Button>}>
          <strong>Reels: Receita do bolo de fubá</strong>
          <span>arraste para outro dia</span>
        </Popover></div>
      }
    ]
  },
  {
    id: 'modal',
    name: 'Modal e ConfirmDialog',
    covers: ['Modal', 'ConfirmDialog'],
    examples: [
      { label: 'modal', render: (state) => stateOnly(state, ['default'], <Opener label="Abrir modal">{(close) => <Modal title="Título do modal" closeLabel="Fechar" onClose={close}><p>Conteúdo de exemplo.</p></Modal>}</Opener>) },
      { label: 'confirmação', render: (state) => stateOnly(state, ['default', 'loading'], <Opener label="Abrir confirmação">{(close) => <ConfirmDialog open title="Confirmar?" description="Descrição de exemplo." confirmLabel="Confirmar" cancelLabel="Cancelar" busy={state === 'loading'} onConfirm={close} onCancel={close} />}</Opener>) }
    ]
  }
];

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Stage3D, type Stage3DTone } from '@ageniza/ui';

import { componentEntries, type ComponentEntry, type RenderedState } from './components.js';
import { colorFamily, designTokens, groupTokens, semanticGroup, type Token } from './tokens.js';
import './design-system.css';

export const DESIGN_SYSTEM_MARKER = 'ageniza-design-system-page';

const sections = [
  ['cores', 'Cores primitivas'], ['semanticos', 'Tokens semânticos'], ['tipografia', 'Tipografia'], ['espaco', 'Espaço e raio'],
  ['elevacao', 'Elevação'], ['blocos', 'Blocos de cor e palco'], ['movimento', 'Movimento'], ['componentes', 'Componentes']
] as const;

const asVar = (token: Token): string => `var(${token.name})`;

function TokenName({ token }: { token: Token }) {
  return <><code className="ds-token__name">{token.name}</code><span className="ds-token__value">{token.value}</span></>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="ds-section" aria-labelledby={`${id}-title`}><h2 id={`${id}-title`}>{title}</h2>{children}</section>;
}

function PrimitiveColors() {
  return <>{groupTokens(designTokens.colors, colorFamily).map((group) => <div key={group.key} className="ds-group">
    <h3>{group.key}</h3>
    <ul className="ds-list">{group.tokens.map((token) => <li key={token.name} className="ds-token">
      <span className="ds-swatch" style={{ background: asVar(token) }} aria-hidden="true" /><TokenName token={token} />
    </li>)}</ul>
  </div>)}</>;
}

function SemanticSwatch({ token }: { token: Token }) {
  const isText = token.name.startsWith('--text-');
  const style: CSSProperties = isText ? { color: asVar(token), background: 'var(--bg-surface)' } : { background: asVar(token) };
  return <span className="ds-swatch" style={style} aria-hidden="true">{isText ? 'Aa' : null}</span>;
}

function SemanticTokens() {
  return <div className="ds-panel" data-testid="semantic">
    {groupTokens(designTokens.semantic, semanticGroup).map((group) => <div key={group.key} className="ds-group">
      <h4>{group.key}</h4>
      <ul className="ds-list">{group.tokens.map((token) => <li key={token.name} className="ds-token">
        <SemanticSwatch token={token} /><TokenName token={token} />
      </li>)}</ul>
    </div>)}
  </div>;
}

function Typography() {
  return <>
    <ul className="ds-list">{designTokens.fonts.map((token) => <li key={token.name} className="ds-token"><TokenName token={token} /></li>)}</ul>
    <ul className="ds-list">{designTokens.typeScale.map((token) => <li key={token.name} className="ds-type">
      <span className="ds-type__sample" style={{ font: asVar(token) }}>Pauta da semana, sem retrabalho</span><TokenName token={token} />
    </li>)}</ul>
  </>;
}

function SpaceAndRadius() {
  return <div className="ds-themes">
    <ul className="ds-list">{designTokens.spacing.map((token) => <li key={token.name} className="ds-token">
      <span className="ds-space" style={{ width: asVar(token) }} aria-hidden="true" /><TokenName token={token} />
    </li>)}</ul>
    <ul className="ds-list">{designTokens.radius.map((token) => <li key={token.name} className="ds-token">
      <span className="ds-radius" style={{ borderRadius: asVar(token) }} aria-hidden="true" /><TokenName token={token} />
    </li>)}</ul>
  </div>;
}

function Elevation() {
  return <div className="ds-panel" data-testid="elevation">
    <ul className="ds-list">
      {designTokens.elevation.map((token) => <li key={token.name} className="ds-token">
        <span className="ds-elevation" style={{ boxShadow: asVar(token) }} aria-hidden="true" /><TokenName token={token} />
      </li>)}
      {['--bg-canvas', '--bg-surface', '--bg-elevated'].map((name) => <li key={name} className="ds-token">
        <span className="ds-elevation" style={{ background: `var(${name})` }} aria-hidden="true" /><code className="ds-token__name">{name}</code><span className="ds-token__value">separa por superfície e borda</span>
      </li>)}
    </ul>
  </div>;
}

const BLOCKS: readonly { tone: Stage3DTone; icon: string; label: string }[] = [
  { tone: 'indigo', icon: 'rocket', label: 'Índigo' }, { tone: 'violet', icon: 'trophy', label: 'Violeta' }, { tone: 'teal', icon: 'thumb-up', label: 'Verde-água' },
  { tone: 'sky', icon: 'calender', label: 'Céu' }, { tone: 'red', icon: 'bell', label: 'Vermelho' }, { tone: 'slate', icon: 'folder', label: 'Neutro' }
];

/** A colour block is a soft fill with its own text colour; the stage mixes its disc with that fill. */
function Blocks() {
  return <ul className="ds-blocks" data-testid="blocks">{BLOCKS.map((block) => <li
    key={block.tone}
    data-stage-host
    className="ds-block"
    style={{ background: `var(--block-${block.tone}-bg)`, color: `var(--block-${block.tone}-fg)`, '--ui-stage-bg': `var(--block-${block.tone}-bg)` } as CSSProperties}
  >
    <Stage3D src={`/3d/${block.icon}.png`} tone={block.tone} size="md" />
    <strong>{block.label}</strong>
    <code>--block-{block.tone}-bg</code>
  </li>)}</ul>;
}

function Motion() {
  const [moved, setMoved] = useState(false);
  const easing = designTokens.motion.find((token) => token.name === '--motion-easing-standard');
  return <>
    <button type="button" className="ds-play" onClick={() => setMoved((value) => !value)}>Reproduzir</button>
    <ul className="ds-list">
      {designTokens.motion.filter((token) => token !== easing).map((token) => <li key={token.name} className="ds-token">
        <span className="ds-track" aria-hidden="true"><span
          className={moved ? 'ds-ball ds-ball--moved' : 'ds-ball'}
          style={{ transitionDuration: asVar(token), transitionTimingFunction: easing === undefined ? undefined : asVar(easing) }} /></span>
        <TokenName token={token} />
      </li>)}
      {easing !== undefined && <li className="ds-token"><TokenName token={easing} /></li>}
    </ul>
  </>;
}

const stateColumns: readonly { key: string; label: string; hint?: string; state: RenderedState }[] = [
  { key: 'default', label: 'Padrão', state: 'default' },
  { key: 'hover', label: 'Hover', hint: 'passe o mouse', state: 'default' },
  { key: 'focus', label: 'Foco', hint: 'navegue com Tab', state: 'default' },
  { key: 'disabled', label: 'Desativado', state: 'disabled' },
  { key: 'loading', label: 'Carregando', state: 'loading' }
];

function StatesInRows({ entry }: { entry: ComponentEntry }) {
  return <table className="ds-wide">
    <thead><tr><th scope="col">Estado</th>{entry.examples.map((example) => <th key={example.label} scope="col">{example.label}</th>)}</tr></thead>
    <tbody>{stateColumns.map((column) => <tr key={column.key}>
      <th scope="row">{column.label}{column.hint !== undefined && <small>{column.hint}</small>}</th>
      {entry.examples.map((example) => {
        const rendered = example.render(column.state);
        return <td key={example.label}>{rendered ?? <span className="ds-na" aria-label="não se aplica">—</span>}</td>;
      })}
    </tr>)}</tbody>
  </table>;
}

function ComponentTable({ entry }: { entry: ComponentEntry }) {
  if (entry.wide === true) return <div className="ds-component"><h3>{entry.name}</h3><StatesInRows entry={entry} /></div>;
  return <div className="ds-component">
    <h3>{entry.name}</h3>
    <table>
      <thead><tr><th scope="col">Variante</th>{stateColumns.map((column) => <th key={column.key} scope="col">{column.label}{column.hint !== undefined && <small>{column.hint}</small>}</th>)}</tr></thead>
      <tbody>{entry.examples.map((example) => <tr key={example.label}>
        <th scope="row">{example.label}</th>
        {stateColumns.map((column) => {
          const rendered = example.render(column.state);
          return <td key={column.key}>{rendered ?? <span className="ds-na" aria-label="não se aplica">—</span>}</td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

function Components() {
  return <div className="ds-panel" data-testid="components-panel">{componentEntries.map((entry) => <ComponentTable key={entry.id} entry={entry} />)}</div>;
}

export default function DesignSystemPage() {
  return <div className={`ds-page ${DESIGN_SYSTEM_MARKER}`}>
    <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
    <header className="ds-header">
      <p className="ds-eyebrow">Interno · só em desenvolvimento</p>
      <h1>Design system</h1>
      <p>Tema único, claro. Os valores abaixo são lidos dos arquivos de <code>apps/web/src/styles</code>; nada é copiado à mão.</p>
      <nav aria-label="Seções"><ul>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul></nav>
    </header>
    <main id="main-content">
      <Section id="cores" title="Cores primitivas"><PrimitiveColors /></Section>
      <Section id="semanticos" title="Tokens semânticos"><SemanticTokens /></Section>
      <Section id="tipografia" title="Tipografia"><Typography /></Section>
      <Section id="espaco" title="Espaço e raio"><SpaceAndRadius /></Section>
      <Section id="elevacao" title="Elevação"><Elevation /></Section>
      <Section id="blocos" title="Blocos de cor e palco"><Blocks /></Section>
      <Section id="movimento" title="Movimento"><Motion /></Section>
      <Section id="componentes" title="Componentes"><Components /></Section>
    </main>
  </div>;
}

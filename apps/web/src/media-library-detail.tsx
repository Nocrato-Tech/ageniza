import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { Download, ImagePlus, Trash2, X } from 'lucide-react';

import { MEDIA_ALT_TEXT_MAX_LENGTH, MediaAltTextSchema, MediaLibraryAssetSchema, type MediaLibraryAsset } from '@ageniza/contracts';
import { Button, ButtonLink, Field, IconButton, Skeleton, StatusTag, Tabs, Textarea } from '@ageniza/ui';

import { useAgencyContext, useWriteBlocked } from './agency.js';
import { STATUS_LABELS, STATUS_TAGS } from './content-labels.js';
import { useApiClient } from './http.js';
import type { AssetOps } from './media-library-actions.js';
import { apiReason, assetName, dimensionsLabel, fullWhenLabel, isForbidden, libraryQueryKey, mediaBase, sentLabel, sizeLabel, TYPE_LABELS, useAssetUsage } from './media-library-model.js';
import { MediaThumbnail } from './media-thumbnail.js';

const PROCESSING_LABELS: Readonly<Record<MediaLibraryAsset['videoProcessingStatus'], string | undefined>> = {
  not_applicable: undefined, pending: 'Em andamento', processing: 'Em andamento', ready: 'Pronto', failed: 'Falhou'
};

const USAGE_ROLE = (usage: { asMedia: boolean; asCover: boolean }): string =>
  usage.asMedia && usage.asCover ? 'Mídia e capa' : usage.asCover ? 'Capa' : 'Mídia';

function Usage({ clientId, asset }: { clientId: string; asset: MediaLibraryAsset }) {
  const usage = useAssetUsage(clientId, asset.id);
  const titleId = useId();
  let body;
  if (usage.isPending) body = <Skeleton className="media-detail__usage-skeleton" />;
  else if (usage.isError) body = <p className="media-detail__muted" role="alert">Não foi possível ver onde este arquivo é usado.</p>;
  else if (usage.data.data.length === 0) body = <p className="media-detail__muted">Este arquivo ainda não foi usado em um conteúdo.</p>;
  else {
    body = <ul className="media-detail__usage">
      {usage.data.data.map((item) => <li key={item.contentId} className="media-detail__usage-row">
        <span className="media-detail__usage-main">
          <span className="media-detail__usage-title">{item.title}</span>
          <span className="media-detail__muted">{USAGE_ROLE(item)}</span>
        </span>
        <StatusTag status={STATUS_TAGS[item.status]}>{STATUS_LABELS[item.status]}</StatusTag>
      </li>)}
    </ul>;
  }
  return <section aria-labelledby={titleId}>
    <h3 id={titleId} className="media-detail__heading">Usada em</h3>
    {body}
  </section>;
}

/** The alternative text is saved by its own button and keeps what was typed when the API refuses. */
function AltText({ clientId, asset, canOperate }: { clientId: string; asset: MediaLibraryAsset; canOperate: boolean }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const blocked = useWriteBlocked();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(asset.altText ?? '');
  const [error, setError] = useState<string | undefined>();
  const saved = asset.altText ?? '';
  const dirty = draft.trim() !== saved;

  const save = useMutation({
    mutationFn: (altText: string | null) => httpClient.request({
      path: `${mediaBase(agency.agencyId, clientId)}/${encodeURIComponent(asset.id)}`,
      method: 'PATCH',
      body: { altText },
      response: MediaLibraryAssetSchema
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: libraryQueryKey(agency.agencyId, clientId) }); },
    onError: (failure: unknown) => {
      setError(isForbidden(failure) ? 'Você não tem permissão para fazer isso.' : apiReason(failure) ?? 'Não foi possível salvar o texto alternativo. Tente de novo.');
    }
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = MediaAltTextSchema.safeParse(draft);
    if (!parsed.success) { setError(`Use uma linha de até ${MEDIA_ALT_TEXT_MAX_LENGTH} caracteres, sem caracteres invisíveis.`); return; }
    setError(undefined);
    save.mutate(parsed.data);
  };

  return <form className="media-detail__alt" onSubmit={submit} noValidate>
    <Field label="Texto alternativo" hint="Para acessibilidade" error={error}>
      {(control) => <Textarea {...control} name="altText" rows={3} value={draft} readOnly={!canOperate} onChange={(event) => { setDraft(event.target.value); setError(undefined); }} />}
    </Field>
    {canOperate && dirty && <Button type="submit" size="sm" variant="secondary" loading={save.isPending} blockedReason={blocked}>Salvar texto alternativo</Button>}
  </form>;
}

/** The panel of the file that was chosen: what the API tells about it, where it is used and the actions its row has. Under the list on a phone. */
export function MediaDetail({ clientId, asset, canOperate, ops, onClose }: {
  clientId: string;
  asset: MediaLibraryAsset;
  canOperate: boolean;
  ops: AssetOps;
  onClose: () => void;
}) {
  const agency = useAgencyContext();
  const blocked = useWriteBlocked();
  const location = useLocation();
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const [tab, setTab] = useState('details');
  const name = assetName(asset);
  const processing = PROCESSING_LABELS[asset.videoProcessingStatus];
  const holdsContent = asset.category === 'image' || asset.category === 'video';

  useEffect(() => {
    // Side by side the panel is already in view; stacked under a long list it is not.
    let stacked = false;
    try { stacked = !window.matchMedia('(min-width: 80rem)').matches; } catch { stacked = false; }
    if (!stacked) return;
    panel.current?.scrollIntoView?.({ block: 'nearest' });
    panel.current?.focus({ preventScroll: true });
  }, [asset.id]);

  const details = <div className="media-detail__body">
    <Usage clientId={clientId} asset={asset} />
    <section>
      <h3 className="media-detail__heading">Informações</h3>
      <dl className="media-detail__info">
        <dt>Pasta</dt><dd>{asset.folderName}</dd>
        <dt>Dimensões</dt><dd>{dimensionsLabel(asset)}</dd>
        <dt>Enviada por</dt><dd>{asset.uploadedBy?.name ?? '—'}</dd>
        <dt>Em</dt><dd>{fullWhenLabel(asset.createdAt)}</dd>
        {processing !== undefined && <><dt>Processamento</dt><dd>{processing}</dd></>}
      </dl>
    </section>
    {asset.category !== 'pdf' && asset.category !== 'audio' && <AltText key={`${asset.id}:${asset.altText ?? ''}`} clientId={clientId} asset={asset} canOperate={canOperate} />}
  </div>;

  return <aside ref={panel} className="media-detail" aria-labelledby={titleId} tabIndex={-1}>
    <div className="media-detail__top">
      <IconButton label="Fechar detalhes" icon={<X />} size="sm" onClick={onClose} />
    </div>
    <div className="media-detail__preview"><MediaThumbnail assetId={asset.id} category={asset.category} /></div>
    <div>
      <h2 id={titleId} className="media-detail__name">{name}</h2>
      <p className="media-detail__sub">{TYPE_LABELS[asset.category]} · {sizeLabel(asset.sizeBytes)} · {sentLabel(asset.createdAt)}</p>
    </div>
    <Tabs
      label="Seções do arquivo"
      value={tab}
      onChange={setTab}
      className="media-detail__tabs"
      items={[
        { value: 'details', label: 'Detalhes', content: details },
        { value: 'activity', label: 'Atividade', disabled: true, content: null }
      ]}
    />
    <div className="media-detail__actions">
      {canOperate && holdsContent && <ButtonLink as={Link} variant="secondary" leadingIcon={<ImagePlus />} to={`/agencia/${agency.agencyId}/conteudos/${clientId}/novo?midia=${encodeURIComponent(asset.id)}`} state={location.state}>Usar em um conteúdo</ButtonLink>}
      <div className="media-detail__pair">
        <Button variant="ghost" leadingIcon={<Download />} loading={ops.downloadingId === asset.id} onClick={() => ops.download(asset)}>Baixar</Button>
        {canOperate && <Button variant="danger-quiet" leadingIcon={<Trash2 />} blockedReason={blocked} onClick={() => ops.remove(asset)}>Excluir</Button>}
      </div>
    </div>
  </aside>;
}

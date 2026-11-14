import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  AuthNoContentResponseSchema,
  MediaDownloadUrlResponseSchema,
  MediaFileNameSchema,
  MediaFolderNameSchema,
  MediaFolderSchema,
  MediaLibraryAssetSchema,
  MEDIA_FOLDER_NAME_MAX_LENGTH,
  RemoveMediaAssetResponseSchema,
  type MediaFolderSummary,
  type MediaLibraryAsset
} from '@ageniza/contracts';
import { Button, ConfirmDialog, FieldMessage, Modal, Select, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';
import { isHttpUrl } from './media-thumbnail.js';
import { apiReason, assetName, foldersBase, foldersQueryKey, isForbidden, libraryQueryKey, mediaBase } from './media-library-model.js';

const NO_PERMISSION = 'Você não tem permissão para fazer isso.';

/** Whatever a write changes in the library: the rows, the counts of the folders and where each file is used. */
const useRefreshLibrary = (clientId: string) => {
  const queryClient = useQueryClient();
  const agency = useAgencyContext();
  return (): void => {
    void queryClient.invalidateQueries({ queryKey: libraryQueryKey(agency.agencyId, clientId) });
    void queryClient.invalidateQueries({ queryKey: foldersQueryKey(agency.agencyId, clientId) });
  };
};

const writeFailure = (error: unknown, fallback: string): string => {
  if (isForbidden(error)) return NO_PERMISSION;
  if (error instanceof HttpClientError && error.status === 404) return 'Este item não existe mais.';
  return apiReason(error) ?? fallback;
};

/** A form in a dialog: it closes on success, and on a refusal it stays open with what was typed and says why. */
function TextDialog({ title, label, initial, maxLength, submitLabel, pending, error, onSubmit, onClose, validate }: {
  title: string;
  label: string;
  initial: string;
  maxLength: number;
  submitLabel: string;
  pending: boolean;
  error: string | undefined;
  onSubmit: (value: string) => void;
  onClose: () => void;
  validate: (value: string) => string | undefined;
}) {
  const [value, setValue] = useState(initial);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const inputId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = value.trim();
    const problem = validate(trimmed);
    if (problem !== undefined) { setFieldError(problem); return; }
    onSubmit(trimmed);
  };

  return <Modal title={title} closeLabel={`Fechar ${title.toLowerCase()}`} onClose={onClose}>
    <form className="form-stack" onSubmit={submit} noValidate>
      <div className="form-field">
        <label htmlFor={inputId}>{label}</label>
        <TextInput
          ref={input}
          id={inputId}
          name="name"
          value={value}
          maxLength={maxLength * 2}
          onChange={(event) => { setValue(event.target.value); setFieldError(undefined); }}
          aria-invalid={fieldError !== undefined}
          aria-describedby={fieldError === undefined ? undefined : errorId}
        />
        {fieldError !== undefined && <FieldMessage id={errorId} role="alert">{fieldError}</FieldMessage>}
      </div>
      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" loading={pending}>{submitLabel}</Button>
      </div>
    </form>
  </Modal>;
}

export function RenameAssetDialog({ clientId, asset, onClose }: { clientId: string; asset: MediaLibraryAsset; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const refresh = useRefreshLibrary(clientId);
  const [error, setError] = useState<string | undefined>();
  const rename = useMutation({
    mutationFn: (name: string) => httpClient.request({
      path: `${mediaBase(agency.agencyId, clientId)}/${encodeURIComponent(asset.id)}`,
      method: 'PATCH',
      body: { name },
      response: MediaLibraryAssetSchema
    }),
    onSuccess: () => { refresh(); onClose(); },
    onError: (failure: unknown) => { setError(writeFailure(failure, 'Não foi possível renomear o arquivo. Tente de novo.')); }
  });
  return <TextDialog
    title="Renomear arquivo"
    label="Nome do arquivo"
    initial={asset.name ?? ''}
    maxLength={255}
    submitLabel="Salvar nome"
    pending={rename.isPending}
    error={error}
    onClose={onClose}
    validate={(value) => {
      if (value === '') return 'Informe o nome do arquivo.';
      return MediaFileNameSchema.safeParse(value).success ? undefined : 'Use um nome de até 255 caracteres, sem barras nem caracteres invisíveis.';
    }}
    onSubmit={(value) => { setError(undefined); rename.mutate(value); }}
  />;
}

export function RenameFolderDialog({ clientId, folder, onClose }: { clientId: string; folder: MediaFolderSummary; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const refresh = useRefreshLibrary(clientId);
  const [error, setError] = useState<string | undefined>();
  const rename = useMutation({
    mutationFn: (name: string) => httpClient.request({
      path: `${foldersBase(agency.agencyId, clientId)}/${encodeURIComponent(folder.id)}`,
      method: 'PATCH',
      body: { name },
      response: MediaFolderSchema
    }),
    onSuccess: () => { refresh(); onClose(); },
    onError: (failure: unknown) => { setError(writeFailure(failure, 'Não foi possível renomear a pasta. Tente de novo.')); }
  });
  return <TextDialog
    title="Renomear pasta"
    label="Nome da pasta"
    initial={folder.name}
    maxLength={MEDIA_FOLDER_NAME_MAX_LENGTH}
    submitLabel="Salvar nome"
    pending={rename.isPending}
    error={error}
    onClose={onClose}
    validate={(value) => {
      if (value === '') return 'Informe o nome da pasta.';
      if (value.length > MEDIA_FOLDER_NAME_MAX_LENGTH) return `O nome pode ter até ${MEDIA_FOLDER_NAME_MAX_LENGTH} caracteres.`;
      return MediaFolderNameSchema.safeParse(value).success ? undefined : 'Use um nome sem caracteres invisíveis ou de controle.';
    }}
    onSubmit={(value) => { setError(undefined); rename.mutate(value); }}
  />;
}

export function MoveAssetDialog({ clientId, asset, folders, onClose }: { clientId: string; asset: MediaLibraryAsset; folders: readonly MediaFolderSummary[]; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const refresh = useRefreshLibrary(clientId);
  const options = folders.map((folder) => {
    const parent = folder.parentId === null ? undefined : folders.find((candidate) => candidate.id === folder.parentId);
    return { value: folder.id, label: parent === undefined ? folder.name : `${parent.name} / ${folder.name}` };
  });
  const [target, setTarget] = useState(asset.folderId);
  const [error, setError] = useState<string | undefined>();
  const move = useMutation({
    mutationFn: (folderId: string) => httpClient.request({
      path: `${mediaBase(agency.agencyId, clientId)}/${encodeURIComponent(asset.id)}/move`,
      method: 'POST',
      body: { folderId },
      response: MediaLibraryAssetSchema
    }),
    onSuccess: () => { refresh(); onClose(); },
    onError: (failure: unknown) => { setError(writeFailure(failure, 'Não foi possível mover o arquivo. Tente de novo.')); }
  });
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (target === asset.folderId) { setError('Escolha outra pasta.'); return; }
    setError(undefined);
    move.mutate(target);
  };
  return <Modal title="Mover para" closeLabel="Fechar mover para" onClose={onClose}>
    <form className="form-stack" onSubmit={submit} noValidate>
      <Select label="Pasta de destino" value={target} options={options} onChange={(value) => { setTarget(value); setError(undefined); }} />
      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" loading={move.isPending}>Mover arquivo</Button>
      </div>
    </form>
  </Modal>;
}

export interface AssetOps {
  readonly download: (asset: MediaLibraryAsset) => void;
  readonly downloadingId: string | null;
  readonly rename: (asset: MediaLibraryAsset) => void;
  readonly move: (asset: MediaLibraryAsset) => void;
  readonly remove: (asset: MediaLibraryAsset) => void;
}

type Pending =
  | { readonly kind: 'rename-asset' | 'move-asset' | 'delete-asset'; readonly asset: MediaLibraryAsset }
  | { readonly kind: 'rename-folder' | 'delete-folder'; readonly folder: MediaFolderSummary };

export interface FolderOps {
  readonly rename: (folder: MediaFolderSummary) => void;
  readonly remove: (folder: MediaFolderSummary) => void;
}

/**
 * The writes of the library behind one host: the menu of a row, the panel and the menu of a folder only ask ("rename this"), and the
 * dialog opens once, outside the table. `notify` is where a failure with no dialog of its own (a download, a delete) is told.
 */
export function useLibraryOps({ clientId, folders, notify, onAssetRemoved, onFolderRemoved }: {
  clientId: string;
  folders: readonly MediaFolderSummary[];
  notify: (message: string | undefined) => void;
  onAssetRemoved: (assetId: string) => void;
  onFolderRemoved: (folderId: string) => void;
}): { assetOps: AssetOps; folderOps: FolderOps; dialogs: ReactNode } {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const refresh = useRefreshLibrary(clientId);
  const [pending, setPending] = useState<Pending | null>(null);
  const close = (): void => setPending(null);

  const download = useMutation({
    mutationFn: (asset: MediaLibraryAsset) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId: asset.id })}?variant=original`,
      response: MediaDownloadUrlResponseSchema
    }),
    onSuccess: ({ url }) => {
      if (!isHttpUrl(url)) { notify('Não foi possível preparar o download. Tente de novo.'); return; }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    onError: () => { notify('Não foi possível preparar o download. Tente de novo.'); }
  });

  const removeAsset = useMutation({
    mutationFn: (asset: MediaLibraryAsset) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove', {
        agencyId: agency.agencyId, clientId, folderId: asset.folderId, assetId: asset.id
      }),
      method: 'POST',
      response: RemoveMediaAssetResponseSchema
    }),
    onSuccess: (_answer, asset) => { close(); onAssetRemoved(asset.id); refresh(); },
    onError: (failure: unknown) => {
      close();
      notify(writeFailure(failure, 'Não foi possível excluir o arquivo. Tente de novo.'));
      refresh();
    }
  });

  const removeFolder = useMutation({
    mutationFn: (folder: MediaFolderSummary) => httpClient.request({
      path: `${foldersBase(agency.agencyId, clientId)}/${encodeURIComponent(folder.id)}`,
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: (_answer, folder) => { close(); onFolderRemoved(folder.id); refresh(); },
    onError: (failure: unknown) => {
      close();
      notify(writeFailure(failure, 'Não foi possível excluir a pasta. Tente de novo.'));
      refresh();
    }
  });

  const assetOps: AssetOps = {
    download: (asset) => { notify(undefined); download.mutate(asset); },
    downloadingId: download.isPending ? download.variables?.id ?? null : null,
    rename: (asset) => { notify(undefined); setPending({ kind: 'rename-asset', asset }); },
    move: (asset) => { notify(undefined); setPending({ kind: 'move-asset', asset }); },
    remove: (asset) => { notify(undefined); setPending({ kind: 'delete-asset', asset }); }
  };
  const folderOps: FolderOps = {
    rename: (folder) => { notify(undefined); setPending({ kind: 'rename-folder', folder }); },
    remove: (folder) => { notify(undefined); setPending({ kind: 'delete-folder', folder }); }
  };

  const dialogs = <>
    {pending?.kind === 'rename-asset' && <RenameAssetDialog clientId={clientId} asset={pending.asset} onClose={close} />}
    {pending?.kind === 'move-asset' && <MoveAssetDialog clientId={clientId} asset={pending.asset} folders={folders} onClose={close} />}
    {pending?.kind === 'rename-folder' && <RenameFolderDialog clientId={clientId} folder={pending.folder} onClose={close} />}
    <ConfirmDialog
      open={pending?.kind === 'delete-asset'}
      title="Excluir arquivo?"
      description={pending?.kind === 'delete-asset' ? `Excluir "${assetName(pending.asset)}"? Ele deixa a biblioteca e não poderá mais ser baixado.` : ''}
      confirmLabel="Excluir"
      cancelLabel="Cancelar"
      busy={removeAsset.isPending}
      onConfirm={() => { if (pending?.kind === 'delete-asset') removeAsset.mutate(pending.asset); }}
      onCancel={close}
    />
    <ConfirmDialog
      open={pending?.kind === 'delete-folder'}
      title="Excluir pasta?"
      description={pending?.kind === 'delete-folder' ? `Excluir a pasta "${pending.folder.name}"? Só uma pasta vazia pode ser excluída.` : ''}
      confirmLabel="Excluir"
      cancelLabel="Cancelar"
      busy={removeFolder.isPending}
      onConfirm={() => { if (pending?.kind === 'delete-folder') removeFolder.mutate(pending.folder); }}
      onCancel={close}
    />
  </>;

  return { assetOps, folderOps, dialogs };
}

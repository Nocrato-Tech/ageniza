import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { Image as ImageIcon, Play } from './icons';
import type { Asset, Post, Repository } from './types';
import { Action, Card, MediaDisplay, Txt, useColors } from './ui';

export function AssetThumbnail({ asset, repository, postId, large = false }: { asset: Asset; repository: Pick<Repository, 'assetUrl'>; postId?: string; large?: boolean }) {
  const colors = useColors();
  const [uri, setUri] = useState(asset.kind === 'image' ? asset.uri : undefined);
  useEffect(() => {
    let active = true;
    setUri(asset.kind === 'image' ? asset.uri : undefined);
    if (!asset.uri || asset.kind === 'video') void repository.assetUrl(asset.clientId, postId, asset.id, asset.kind === 'video' ? 'thumbnail' : 'original').then((url) => { if (active) setUri(url); }).catch(() => {});
    return () => { active = false; };
  }, [asset.id, asset.kind, asset.uri, asset.clientId, postId, repository]);
  const Icon = asset.kind === 'video' ? Play : ImageIcon;
  return <View style={{ width: large ? '100%' : 64, height: large ? 120 : 80, borderRadius: 8, backgroundColor: colors.soft, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>{uri ? <Image source={{ uri }} accessibilityLabel={`Miniatura de ${asset.name}`} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setUri(undefined)} /> : <Icon size={24} color={colors.indigo} />}</View>;
}

export function EditorMedia({ asset, post, repository, index, count, isCover, onMove, onRemove }: { asset: Asset; post: Post; repository: Pick<Repository, 'assetUrl'>; index: number; count: number; isCover: boolean; onMove(offset: number): void; onRemove(): void }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  return <Card>
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <AssetThumbnail asset={asset} repository={repository} postId={post.id === 'preview' ? undefined : post.id} />
      <View style={{ flex: 1, gap: 4 }}><Txt kind="strong">{index + 1}. {asset.name}</Txt><Txt kind="small" color={colors.muted}>{asset.kind === 'video' ? 'Vídeo' : 'Imagem'}{isCover ? ' · Também usada como capa' : ''}</Txt>{asset.kind === 'video' && (asset.processing === 'pending' || asset.processing === 'processing') && <Txt kind="small" color={colors.muted}>Preparando a miniatura do vídeo. O arquivo já foi recebido.</Txt>}{asset.processing === 'failed' && <Txt kind="small" color={colors.danger}>A prévia do vídeo falhou. O original continua disponível para visualizar.</Txt>}</View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action plain disabled={index === 0} label={`Mover ${asset.name} antes`} onPress={() => onMove(-1)} /><Action plain disabled={index === count - 1} label={`Mover ${asset.name} depois`} onPress={() => onMove(1)} /></View>
    <Action soft label={`${expanded ? 'Ocultar' : 'Visualizar'} ${asset.name}`} onPress={() => setExpanded((value) => !value)} />
    {expanded && <MediaDisplay asset={asset} repository={repository} post={post} />}
    <Action plain label={`Remover ${asset.name} da publicação`} onPress={onRemove} />
  </Card>;
}

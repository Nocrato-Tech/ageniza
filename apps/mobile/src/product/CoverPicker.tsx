import { View } from 'react-native';
import { Check, Image as ImageIcon } from 'lucide-react-native';
import type { Asset, PostInput, Repository } from './types';
import { Action, Card, ErrorText, Txt, useColors } from './ui';
import { Touch } from './motion';
import { AssetThumbnail } from './EditorMedia';
import { coverFileHint, coverIssue } from './media-rules';

export function CoverPicker({ assets, input, repository, onChange, onUpload, busy, error }: { assets: Asset[]; input: PostInput; repository: Pick<Repository, 'assetUrl'>; onChange(id: string | null): void; onUpload(): void; busy: boolean; error?: string }) {
  const colors = useColors();
  const candidates = assets.filter((asset) => !coverIssue(asset, input));
  const selected = assets.find((asset) => asset.id === input.coverId);
  const issue = input.coverId ? coverIssue(selected, input) : undefined;
  const video = !['image', 'carousel'].includes(input.format);
  return <Card>
    <Txt kind="section">Capa</Txt>
    <Txt kind="small" color={colors.muted}>A capa é a imagem de apresentação. Escolher uma capa não adiciona um arquivo à sequência da publicação.</Txt>
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      {selected && !issue ? <AssetThumbnail asset={selected} repository={repository} /> : <View style={{ width: 64, height: 80, backgroundColor: colors.soft, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}><ImageIcon size={24} color={colors.indigo} /></View>}
      <View style={{ flex: 1, gap: 4 }}><Txt kind="strong">{input.coverId ? selected?.name ?? 'Capa indisponível' : video ? 'Quadro automático do vídeo' : 'Primeira mídia da publicação'}</Txt><Txt kind="small" color={colors.muted}>{input.coverId ? 'Capa personalizada' : video ? 'A miniatura aparece quando o vídeo termina de processar.' : 'A ordem das mídias define a imagem de apresentação.'}</Txt></View>
    </View>
    {!!(error || issue) && <ErrorText text={error || issue!} />}
    <Touch accessibilityRole="radio" accessibilityState={{ checked: !input.coverId, disabled: busy }} disabled={busy} accessibilityLabel={video ? 'Usar quadro automático do vídeo' : 'Usar primeira mídia da publicação'} onPress={() => onChange(null)} style={{ minHeight: 48, borderWidth: 1, borderColor: !input.coverId ? colors.indigo : colors.border, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      {!input.coverId && <Check size={18} color={colors.indigo} />}<View style={{ flex: 1 }}><Txt kind="strong">{video ? 'Usar quadro automático do vídeo' : 'Usar primeira mídia da publicação'}</Txt></View>
    </Touch>
    <Txt kind="label">Escolher imagem desta pasta</Txt>
    <Txt kind="small" color={colors.muted}>{coverFileHint}</Txt>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {candidates.map((asset) => <Touch key={asset.id} accessibilityRole="radio" accessibilityState={{ checked: asset.id === input.coverId, disabled: busy }} disabled={busy} accessibilityLabel={`Usar ${asset.name} como capa`} onPress={() => onChange(asset.id)} style={{ width: '46%', minWidth: 112, flexGrow: 1, maxWidth: 240, padding: 8, gap: 8, borderRadius: 12, borderWidth: 1, borderColor: input.coverId === asset.id ? colors.indigo : colors.border, backgroundColor: input.coverId === asset.id ? colors.soft : colors.surface }}>
        <AssetThumbnail asset={asset} repository={repository} large /><Txt kind="small" lines={2}>{asset.name}</Txt>{asset.id === input.coverId && <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}><Check size={16} color={colors.indigo} /><Txt kind="label" color={colors.indigo}>Capa selecionada</Txt></View>}
      </Touch>)}
    </View>
    {!candidates.length && <Txt kind="small" color={colors.muted}>Esta pasta ainda não tem imagens para capa. Envie uma imagem abaixo; vídeos usam o quadro automático.</Txt>}
    <Action soft busy={busy} label="Enviar imagem de capa" onPress={onUpload} />
  </Card>;
}

import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { CheckCircle2, Circle } from '../product/icons';
import { Txt, useColors } from '../product/ui';
import { useReducedMotion } from '../product/motion';
import { assessPassword } from './password-assessment';

const strengthLabels = ['Ainda não informada', 'Fraca', 'Razoável', 'Boa', 'Forte'];

function Requirement({ met, label }: { met: boolean; label: string }) {
  const colors = useColors();
  const Icon = met ? CheckCircle2 : Circle;
  return <View accessible accessibilityLabel={`${met ? 'Atendido' : 'Pendente'}: ${label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    <Icon size={16} color={met ? colors.teal : colors.muted} aria-hidden />
    <View style={{ flex: 1 }}><Txt kind="small" color={met ? colors.teal : colors.muted}>{label}</Txt></View>
  </View>;
}

export function PasswordGuidance({ password, nativeID }: { password: string; nativeID: string }) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const assessment = assessPassword(password);
  const progress = useRef(new Animated.Value(assessment.score / 4)).current;
  useEffect(() => {
    progress.stopAnimation();
    if (reduced) { progress.setValue(assessment.score / 4); return; }
    const animation = Animated.timing(progress, { toValue: assessment.score / 4, duration: 180, easing: Easing.bezier(0.16, 1, 0.3, 1), useNativeDriver: Platform.OS !== 'web' });
    animation.start();
    return () => animation.stop();
  }, [assessment.score, progress, reduced]);
  const { missing, excess, score } = assessment;
  const color = score === 0 ? colors.muted : score === 1 ? colors.amber : score < 4 ? colors.indigo : colors.teal;
  const remaining = !password ? 'Use de 10 a 128 caracteres.' : excess ? `Remova ${excess} ${excess === 1 ? 'caractere' : 'caracteres'} para ficar dentro do limite.` : missing ? `${missing === 1 ? 'Falta' : 'Faltam'} ${missing} ${missing === 1 ? 'caractere' : 'caracteres'} para o mínimo.` : 'Tamanho aceito.';
  return <View nativeID={nativeID} style={{ gap: 12 }}>
    <View style={{ gap: 4 }}>
      <Requirement met={missing === 0} label={`Pelo menos ${assessment.minimum} caracteres`} />
      <Requirement met={!!password && excess === 0} label={`No máximo ${assessment.maximum} caracteres`} />
      <View accessibilityLiveRegion="polite"><Txt kind="small" color={excess ? colors.danger : assessment.valid ? colors.teal : colors.muted}>{remaining}</Txt></View>
    </View>
    <View style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4 }}><Txt kind="label">Força estimada</Txt><View accessibilityLiveRegion="polite"><Txt kind="label" color={color}>{strengthLabels[score]}</Txt></View></View>
      <View accessibilityRole="progressbar" accessibilityLabel="Força estimada da senha" accessibilityValue={{ min: 0, max: 4, now: score, text: strengthLabels[score] }} aria-valuemin={0} aria-valuemax={4} aria-valuenow={score} aria-valuetext={strengthLabels[score]} style={{ height: 6, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.border }}>
        <Animated.View style={{ height: '100%', backgroundColor: color, borderRadius: 12, transformOrigin: 'left center', transform: [{ scaleX: progress }] }} />
      </View>
      <Txt kind="small" color={colors.muted}>{score === 0 ? 'Dica: combine palavras pouco previsíveis para criar uma senha longa.' : assessment.predictable ? 'Para fortalecer: evite sequências comuns e trechos repetidos.' : score < 4 ? 'Para fortalecer: acrescente palavras pouco previsíveis.' : 'Use uma senha exclusiva para esta conta.'}</Txt>
      <Txt kind="small" color={colors.muted}>Estimativa local; não verifica senhas vazadas.</Txt>
    </View>
  </View>;
}

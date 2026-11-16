import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { SubscriptionPlansResponse } from '@ageniza/contracts';
import { HugeIcon } from '../product/HugeIcon';
import { useReducedMotion } from '../product/motion';
import { motionTokens } from '../product/motion/tokens';
import { Txt, useColors } from '../product/ui';

export const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function PlanComparison({ plans, value, current, disabled, onChange }: {
  plans: SubscriptionPlansResponse['plans']; value: string; current?: string;
  disabled: boolean; onChange(value: string): void;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [keyboard, setKeyboard] = useState(false);
  return <View style={{ gap: 12 }}>
    <View style={{ gap: 4 }}><Txt kind="section">Escolha seu plano</Txt><Txt color={c.muted}>Compare os limites e selecione uma opção.</Txt></View>
    <View accessibilityRole="radiogroup" accessibilityLabel="Plano desejado" style={{ borderWidth: 1, borderColor: c.border, borderRadius: 14, overflow: 'hidden', backgroundColor: c.surface }}>
      {plans.map((plan, index) => {
        const selected = value === plan.key;
        return <Pressable key={plan.key} accessibilityRole="radio" accessibilityLabel={`Selecionar ${plan.name}`} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled}
          tabIndex={selected || !value && index === 0 ? 0 : -1}
          {...(Platform.OS === 'web' ? { onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            setKeyboard(true);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? plans.length - 1
              : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % plans.length
                : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index - 1 + plans.length) % plans.length : -1;
            if (next < 0 || disabled) return;
            event.preventDefault();
            onChange(plans[next].key);
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
          }, onPointerDown: () => setKeyboard(false) } : {})}
          onPress={() => onChange(plan.key)} style={{ minHeight: 80, padding: 16, borderTopWidth: index ? 1 : 0, borderColor: c.border, justifyContent: 'center' }}>
          <View pointerEvents="none" style={[{ position: 'absolute', inset: 0, backgroundColor: c.soft, opacity: selected ? 1 : 0 }, Platform.OS === 'web' ? { transitionProperty: 'opacity', transitionDuration: reduced || keyboard ? '0ms' : `${motionTokens.base}ms`, transitionTimingFunction: motionTokens.easing } as ViewStyle : undefined]} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 24, height: 24, borderWidth: 1, borderRadius: 12, borderColor: selected ? c.indigo : c.muted, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? c.indigo : c.surface }}>
              {selected && <HugeIcon name="tick-02" size={16} color={c.surface} />}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8 }}><Txt kind="strong">{plan.name}</Txt>{current === plan.key && <Txt kind="small" color={c.teal}>Plano atual</Txt>}</View>
              <Txt kind="small" color={c.muted}>{plan.clientLimit} clientes · {Math.round(plan.storageBytes / 1024 ** 3)} GB</Txt>
            </View>
            <View style={{ alignItems: 'flex-end' }}><Txt kind="strong">{money(plan.monthlyCents)}</Txt><Txt kind="small" color={c.muted}>por mês</Txt></View>
          </View>
        </Pressable>;
      })}
    </View>
    {!plans.length && <Txt color={c.muted}>Nenhum plano disponível neste ambiente. Atualize a assinatura para tentar novamente.</Txt>}
    <Txt kind="small" color={c.muted}>Todos os planos pagos incluem colaboradores e acessos ao portal ilimitados.</Txt>
  </View>;
}

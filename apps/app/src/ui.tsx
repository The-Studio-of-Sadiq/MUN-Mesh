import type { ReactNode } from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { useTheme } from './theme';

/**
 * primary: filled (white in dark mode, black in light) for the main action.
 * accent: blue, for actions the EB takes on someone (approve).
 * default: a grey surface. outline: transparent with a border (destructive or secondary).
 */
export type BtnVariant = 'primary' | 'accent' | 'default' | 'outline';

export function Btn(props: {
  title: string;
  onPress: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  big?: boolean;
  style?: ViewStyle;
  hint?: string;
}) {
  const { colors, styles } = useTheme();
  const variant = props.variant ?? 'default';
  const fill =
    variant === 'primary' ? colors.primary : variant === 'accent' ? colors.accent : variant === 'default' ? colors.surfaceHi : 'transparent';
  const ink = variant === 'primary' ? colors.onPrimary : variant === 'accent' ? colors.onAccent : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={props.hint}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.btn,
        props.big && styles.big,
        { backgroundColor: fill },
        variant === 'outline' && { borderWidth: 1.5, borderColor: colors.text },
        { opacity: props.disabled ? 0.35 : pressed ? 0.7 : 1 },
        props.style,
      ]}
    >
      <Text style={[styles.btnText, props.big && styles.bigText, { color: ink }]}>{props.title}</Text>
    </Pressable>
  );
}

export function Chip(props: { label: string; active?: boolean; onPress: () => void }) {
  const { colors, styles } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!props.active }}
      onPress={props.onPress}
      style={[styles.chip, { borderColor: props.active ? colors.text : colors.border }, props.active && { backgroundColor: colors.text }]}
    >
      <Text style={[styles.chipText, { color: props.active ? colors.bg : colors.text }]}>{props.label}</Text>
    </Pressable>
  );
}

/** Small label, e.g. a role or "MUTED". `tone: 'accent'` draws attention. */
export function Badge({ label, tone }: { label: string; tone?: 'accent' | 'muted' }) {
  const { colors, styles } = useTheme();
  const color = tone === 'accent' ? colors.accent : tone === 'muted' ? colors.muted : colors.text;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { styles } = useTheme();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { styles } = useTheme();
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Field(props: TextInputProps & { label?: string }) {
  const { colors, styles } = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={styles.muted}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} style={[styles.input, style]} {...rest} />
    </View>
  );
}

/** A dot plus a word: connection health shown without relying on colour alone. */
export function Status({ ok, label }: { ok: boolean; label: string }) {
  const { colors, styles } = useTheme();
  return (
    <Row style={{ gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? colors.accent : colors.muted }} />
      <Text style={styles.muted}>{label}</Text>
    </Row>
  );
}

export function Empty({ text }: { text: string }) {
  const { styles } = useTheme();
  return <Text style={[styles.muted, { padding: 16, textAlign: 'center' }]}>{text}</Text>;
}

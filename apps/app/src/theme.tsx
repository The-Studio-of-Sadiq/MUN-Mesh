import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { useFonts } from 'expo-font';
// Each weight from its own subpath: the main entry pulls in every weight and italic.
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif/400Regular';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';

/**
 * Monochrome, like the Studio's other apps, with one accent (UN blue) for
 * the primary action and for things that need the EB's attention.
 */
export type ThemeName = 'dark' | 'light';

export interface Palette {
  bg: string;
  surface: string;
  surfaceHi: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  /** Announcements and other things the EB says to everyone. */
  highlight: string;
}

const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    bg: '#000000',
    surface: '#0f0f0f',
    surfaceHi: '#1d1d1d',
    border: '#333333',
    text: '#ffffff',
    muted: '#a3a3a3',
    primary: '#ffffff',
    onPrimary: '#000000',
    accent: '#5b9fe0',
    onAccent: '#000000',
    highlight: '#0d1f33',
  },
  light: {
    bg: '#ffffff',
    surface: '#f5f5f5',
    surfaceHi: '#e8e8e8',
    border: '#cfcfcf',
    text: '#000000',
    muted: '#5a5a5a',
    primary: '#000000',
    onPrimary: '#ffffff',
    accent: '#1f6fbf',
    onAccent: '#ffffff',
    highlight: '#e6f0fa',
  },
};

/** Android treats each weight as its own family, so weights are chosen by family name, never fontWeight. */
export const FONTS = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  serif: 'InstrumentSerif_400Regular',
} as const;

export function useBrandFonts(): boolean {
  const [loaded, error] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, InstrumentSerif_400Regular });
  return loaded || !!error;
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    container: { width: '100%', maxWidth: 640, alignSelf: 'center', padding: 16, gap: 16 },
    h1: { color: c.text, fontSize: 34, lineHeight: 38, fontFamily: FONTS.serif },
    title: { color: c.text, fontSize: 22, lineHeight: 27, fontFamily: FONTS.serif },
    h2: { color: c.text, fontSize: 16, fontFamily: FONTS.semibold },
    text: { color: c.text, fontSize: 15, lineHeight: 21, fontFamily: FONTS.regular },
    small: { color: c.text, fontSize: 13, lineHeight: 18, fontFamily: FONTS.regular },
    muted: { color: c.muted, fontSize: 13, lineHeight: 18, fontFamily: FONTS.medium },
    eyebrow: { color: c.muted, fontSize: 11, letterSpacing: 2.5, fontFamily: FONTS.bold, textTransform: 'uppercase' },
    alert: { color: c.text, fontSize: 14, fontFamily: FONTS.bold },
    code: { color: c.text, fontSize: 26, letterSpacing: 2, fontFamily: FONTS.bold, fontVariant: ['tabular-nums'] },
    input: {
      color: c.text,
      backgroundColor: c.surfaceHi,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      fontFamily: FONTS.regular,
      borderWidth: 1,
      borderColor: c.border,
    },
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 14, gap: 10, borderWidth: 1, borderColor: c.border },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    big: { paddingVertical: 15, paddingHorizontal: 22, borderRadius: 14 },
    btnText: { color: c.text, fontSize: 14, fontFamily: FONTS.semibold },
    bigText: { fontSize: 17 },
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
    chipText: { fontSize: 13, fontFamily: FONTS.semibold },
    badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
    badgeText: { fontSize: 11, fontFamily: FONTS.bold, letterSpacing: 0.5 },
  });
}

export interface Theme {
  name: ThemeName;
  colors: Palette;
  styles: ReturnType<typeof makeStyles>;
}

const THEMES: Record<ThemeName, Theme> = {
  dark: { name: 'dark', colors: PALETTES.dark, styles: makeStyles(PALETTES.dark) },
  light: { name: 'light', colors: PALETTES.light, styles: makeStyles(PALETTES.light) },
};

const ThemeContext = createContext<Theme>(THEMES.dark);

/** Follows the device (Android dark mode, Windows app mode) and switches live. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const theme = useMemo(() => THEMES[system === 'light' ? 'light' : 'dark'], [system]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

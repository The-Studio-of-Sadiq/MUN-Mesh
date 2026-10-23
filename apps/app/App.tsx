import { useEffect, useState } from 'react';
import { Platform, SafeAreaView, StatusBar as RNStatusBar, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import type { Invite } from '@mun/core';
import { SessionContext, useSession } from './src/hooks';
import { ConsoleScreen } from './src/screens/ConsoleScreen';
import { CreateConferenceScreen } from './src/screens/CreateConferenceScreen';
import { DelegateScreen } from './src/screens/DelegateScreen';
import { JoinScreen } from './src/screens/JoinScreen';
import { RemovedScreen, WaitingScreen } from './src/screens/WaitingScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { AppSession } from './src/session';
import { ThemeProvider, useBrandFonts, useTheme } from './src/theme';

type Setup = { name: 'welcome' } | { name: 'create' } | { name: 'join'; invite: Invite };

// Keep the splash up until fonts are ready, so text never flashes in a fallback font.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const fontsReady = useBrandFonts();
  useEffect(() => {
    if (fontsReady) SplashScreen.hide();
  }, [fontsReady]);
  if (!fontsReady) return null;
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}

function Root() {
  const { name, styles } = useTheme();
  const [session, setSession] = useState<AppSession | null | undefined>(undefined);
  const [setup, setSetup] = useState<Setup>({ name: 'welcome' });

  useEffect(() => {
    AppSession.resume().then(setSession, (e) => {
      console.error('Could not resume', e);
      setSession(null);
    });
  }, []);

  const leave = async () => {
    await session?.leave();
    setSession(null);
    setSetup({ name: 'welcome' });
  };

  let body;
  if (session === undefined) body = <Text style={[styles.muted, { padding: 24 }]}>Loading…</Text>;
  else if (session) {
    body = (
      <SessionContext.Provider value={session}>
        <Main onLeave={() => void leave()} />
      </SessionContext.Provider>
    );
  } else if (setup.name === 'create') body = <CreateConferenceScreen onCreated={setSession} onBack={() => setSetup({ name: 'welcome' })} />;
  else if (setup.name === 'join') body = <JoinScreen invite={setup.invite} onJoined={setSession} onBack={() => setSetup({ name: 'welcome' })} />;
  else body = <WelcomeScreen onInvite={(invite) => setSetup({ name: 'join', invite })} onCreate={() => setSetup({ name: 'create' })} />;

  return (
    <SafeAreaView style={[styles.screen, { paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 }]}>
      <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
      {body}
    </SafeAreaView>
  );
}

/** Waiting until approved, then the console for staff or the delegate app. */
function Main({ onLeave }: { onLeave: () => void }) {
  const session = useSession();
  const me = session.me();
  if (!me) return <WaitingScreen onLeave={onLeave} />;
  if (session.node.replica.auth.isRemoved(me.key)) return <RemovedScreen onLeave={onLeave} />;
  if (me.role === 'eb' || me.role === 'secretariat') return <ConsoleScreen onLeave={onLeave} />;
  return <DelegateScreen onLeave={onLeave} />;
}

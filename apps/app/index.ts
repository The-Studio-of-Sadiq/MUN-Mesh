// Phones need a secure random source before the crypto library loads.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);

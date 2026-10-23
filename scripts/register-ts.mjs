// `node --import ./scripts/register-ts.mjs file.ts` runs TypeScript sources
// directly: Node strips the types, and resolve-ts.mjs maps extensionless imports.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);

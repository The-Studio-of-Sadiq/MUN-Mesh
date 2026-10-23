// Node module hook: resolve extensionless relative imports between TypeScript
// files ("./define" → "./define.ts" or "./define/index.ts"), as bundlers do.
// Lets build scripts import the app's TypeScript sources with Node alone.
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        // Try the next candidate.
      }
    }
  }
  return next(specifier, context);
}

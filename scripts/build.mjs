import {build} from 'esbuild';

await build({
  entryPoints: {
    cli: 'src/cli.tsx',
    'setup-asterisk': 'scripts/setup-asterisk.ts',
    'check-gateway': 'scripts/check-gateway.ts',
  },
  outdir: 'dist',
  bundle: true,
  // Ink's Yoga WASM and other runtime dependencies stay in node_modules.
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
});

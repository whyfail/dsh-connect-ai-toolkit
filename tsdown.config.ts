import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'node24',
    fixedExtension: false, dts: true, clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//, /^@napi-rs\//] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib', format: ['cjs'], platform: 'browser', dts: false, clean: false,
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', /^@deepseek-ai\//] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-connect-ai-toolkit", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
] satisfies UserConfig[]

/* Mechanical enforcement of docs/ARCHITECTURE.md. A violation fails the build. */
module.exports = {
  forbidden: [
    {
      name: 'core-imports-nothing',
      comment: 'ARCHITECTURE.md: core imports nothing but core',
      severity: 'error',
      from: { path: '^src/core' },
      to: { pathNot: '^src/core' },
    },
    {
      name: 'core-no-node-builtins',
      comment: 'ARCHITECTURE.md: the core is pure — no platform IO',
      severity: 'error',
      from: { path: '^src/core' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'app-only-core',
      comment: 'ARCHITECTURE.md: app → core only',
      severity: 'error',
      from: { path: '^src/app' },
      to: { pathNot: '^src/(app|core)' },
    },
    {
      name: 'adapters-no-apps',
      comment: 'ARCHITECTURE.md: adapters may not import composition roots',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/apps' },
    },
    {
      name: 'no-adapter-to-adapter',
      comment: 'ARCHITECTURE.md: no adapter imports another adapter',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/' },
      to: { path: '^src/adapters/(?!$1/)[^/]+/' },
    },
    {
      name: 'no-cycles',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(d|test|spec)\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};

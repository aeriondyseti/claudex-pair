import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // Underscore-prefixed destructure bindings are the idiom for REMOVING an
    // optional property under exactOptionalPropertyTypes (assigning
    // `undefined` is a type error) — allow them everywhere.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', '@app/*', '@adapters/*', 'bun', 'bun:*'], message: 'core is pure: it imports nothing but core (ARCHITECTURE.md)' }] }],
      'no-restricted-globals': ['error',
        { name: 'process', message: 'core is pure (ARCHITECTURE.md)' },
        { name: 'console', message: 'core is pure (ARCHITECTURE.md)' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'time enters via CommandEnvelope.meta (ARCHITECTURE.md)' },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'ids enter via CommandEnvelope.meta (ARCHITECTURE.md)' },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'time enters via CommandEnvelope.meta (ARCHITECTURE.md)' },
      ],
    },
  },
  {
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@adapters/*', 'node:*', 'bun', 'bun:*'], message: 'app imports core only (ARCHITECTURE.md)' }] }],
    },
  },
  {
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['../../apps/*', '@adapters/!(shared)*'], message: 'adapters: no apps, no adapter-to-adapter (ARCHITECTURE.md)' }] }],
    },
  },
);

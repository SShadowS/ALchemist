// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint 10 flat config.
 *
 * Type-aware linting is enabled (`recommendedTypeChecked`) rather than the
 * syntax-only preset, because the rules that earn their keep here need the
 * type checker: `no-floating-promises` above all. This extension is full of
 * deliberate fire-and-forget VS Code calls, and an accidentally dropped
 * promise looks exactly like an intentional one — no rejection, no log, just
 * behaviour that silently did not happen. The rule forces the difference to
 * be written down with `void`.
 *
 * Severity is split by what a finding means:
 *   - error: a defect, or an intent that must be made explicit.
 *   - warn:  a code-health signal worth seeing but not worth blocking on,
 *            chiefly the `no-unsafe-*` family, which fires wherever `any`
 *            propagates out of `JSON.parse` and untyped VS Code surfaces.
 *            Making those errors would gate the build on a typing project
 *            unrelated to whatever change is being linted.
 *
 * `src/` and `test/` are linted with different strictness: test code mocks
 * the VS Code API by design, so `any` and non-null assertions are the point
 * there rather than a smell.
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '.superpowers/**', 'eslint.config.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Resolves each file to the right tsconfig without listing them.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An underscore prefix marks a deliberately-unused binding — common in
      // VS Code callback signatures where the shape is fixed but the
      // argument is irrelevant.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // console.warn is this extension's diagnostic channel.
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      // The prize: a dropped promise in an extension host fails silently.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `any` bleeding out of JSON.parse and untyped VS Code surfaces.
      // Visible, not blocking — see the severity note above.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // Several methods are `async` to fix their signature for callers, not
      // because they await. Worth seeing, not worth a signature change.
      '@typescript-eslint/require-await': 'warn',
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      // Test doubles for the VS Code API are untyped by necessity, and
      // fixtures assert against values the mocks are known to provide.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // The mock's enums are structural stand-ins, not the real VS Code enum.
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      // Tests require() the mock registrar and fixtures dynamically.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Plain-JS mocks and helpers: no type information available.
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);

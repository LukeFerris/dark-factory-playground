// The golden path's complexity gate (cvc-golden-path README, "Complexity
// thresholds"), shared by every workspace. These are the baseline, so a
// workspace may tighten them but not loosen them.
import sonarjs from 'eslint-plugin-sonarjs'
import importPlugin from 'eslint-plugin-import'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'

export const gates = {
  plugins: { sonarjs, import: importPlugin },
  // Imports are written `./x.js` for files that are `./x.ts`, which only the
  // TypeScript resolver follows.
  settings: { 'import-x/resolver-next': [createTypeScriptImportResolver()] },
  rules: {
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': [
      'error',
      { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true },
    ],
    complexity: ['error', 12],
    'max-depth': ['error', 4],
    'max-nested-callbacks': ['error', 3],
    'max-params': ['error', 4],
    'max-statements': ['error', 25],
    'sonarjs/cognitive-complexity': ['error', 15],
    'sonarjs/no-duplicated-branches': 'error',
    'sonarjs/no-identical-functions': 'error',
    'import/max-dependencies': ['error', { max: 25, ignoreTypeImports: true }],
    'import/no-cycle': 'warn',
  },
}

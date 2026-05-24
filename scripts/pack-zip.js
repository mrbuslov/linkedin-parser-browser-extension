// Builds the Chrome Web Store upload zip from linkedin-tracker/.
// Run via `npm run pack:zip`. Output: dist-zip/linkedin-parser-<version>.zip
//
// We shell out to the system `zip` binary because it's present on both macOS
// and ubuntu-latest GH runners, and avoids adding a Node-side zip dependency
// just for this one script.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = resolve(root, 'linkedin-tracker');
const outDir = resolve(root, 'dist-zip');
const manifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipPath = resolve(outDir, `linkedin-parser-${version}.zip`);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);

// Exclude editor swap files, .DS_Store, anything we wouldn't want in the
// signed CWS upload.
execSync(
  `cd "${srcDir}" && zip -r "${zipPath}" . -x "*.DS_Store" "*.swp" "*~"`,
  { stdio: 'inherit' }
);
console.log(`\nBuilt ${zipPath}`);

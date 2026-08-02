#!/usr/bin/env node
/** Puts the self-contained build next to the Pages deployment. */
import { copyFileSync, writeFileSync } from 'node:fs';
copyFileSync('dist/previews/app.html', 'docs/demo.html');
writeFileSync('docs/.nojekyll', '');
console.error('docs/demo.html + docs/.nojekyll');

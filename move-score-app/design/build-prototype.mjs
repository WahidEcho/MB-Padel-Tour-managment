// Inlines the wordmark and flag images into the prototype so it can be published as one file.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
let html = fs.readFileSync(path.join(here, 'prototype.src.html'), 'utf8');
const logo = fs.readFileSync(path.join(here, '../assets/brand/movescore-wordmark.png')).toString('base64');
html = html.replaceAll('{{LOGO}}', `data:image/png;base64,${logo}`);
html = html.replace(/\{\{FLAG_([a-z]{2})\}\}/g, (_, c) => {
  const svg = fs.readFileSync(path.join(root, 'public/flags', `${c}.svg`), 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
});
const out = process.argv[2] || path.join(here, 'prototype.html');
fs.writeFileSync(out, html);
console.log(out, Math.round(html.length / 1024) + ' KB');

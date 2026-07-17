import fs from 'node:fs'
fs.chmodSync('dist/cli.js', 0o755)

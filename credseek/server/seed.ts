import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCredentialLine } from './store.js'
import { getRecordsCount, initRecordsDb, insertCredentials } from './db/recordsDb.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const samplePath = path.join(__dirname, 'data', 'sample.txt')

initRecordsDb()
const existing = getRecordsCount()
if (existing > 0) {
  console.log(`Skip seed: already have ${existing} records`)
  process.exit(0)
}

const text = fs.readFileSync(samplePath, 'utf8')
const records = []

for (const line of text.split(/\r?\n/)) {
  const parsed = parseCredentialLine(line)
  if (!parsed) continue
  records.push(parsed)
}

const saved = await insertCredentials(records)
console.log(`Seeded ${saved.added} sample records`)

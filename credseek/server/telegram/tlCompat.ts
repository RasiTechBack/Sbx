/**
 * Telegram occasionally returns constructors from a neighboring TL layer
 * (or a schema teleproto hasn't regenerated yet). Alias those IDs onto the
 * live classes so ResolveUsername / Message history don't throw TypeNotFoundError.
 */
import { createRequire } from 'node:module'
import { Api } from 'teleproto'

const require = createRequire(import.meta.url)

type TlRegistry = {
  byId: Map<number, number>
  classById: (constructorId: number) => unknown
}

let applied = false

function aliasConstructorIds(
  registry: TlRegistry,
  ctor: { CONSTRUCTOR_ID: number },
  legacyIds: number[],
) {
  const idx = registry.byId.get(ctor.CONSTRUCTOR_ID >>> 0)
  if (idx === undefined) return
  for (const id of legacyIds) {
    const key = id >>> 0
    if (!registry.classById(key)) {
      registry.byId.set(key, idx)
    }
  }
}

export function ensureTelegramTlCompat() {
  if (applied) return
  applied = true

  const { registry } = require('teleproto/tl/runtime/Registry.js') as { registry: TlRegistry }

  // channel history — layers 200–231 predecessors of current #7ad15240
  aliasConstructorIds(registry, Api.Channel, [
    0xd49f34c6, // 228–231
    0x1c32b11c, // 217–227
    0xfe685355, // 204–216
    0x7482147e, // 200–203
  ])

  // Servers currently emit messageReplyHeader#1b97dd66 while teleproto 1.233
  // still registers #ddb5ab75 — field layout matches, only the id drifted.
  // Without this alias, Message.fromReader blows up mid-backfill.
  aliasConstructorIds(registry, Api.MessageReplyHeader, [0x1b97dd66])
}

ensureTelegramTlCompat()

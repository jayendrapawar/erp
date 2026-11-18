import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Services accept either; inside a transaction their own `transaction()` becomes a savepoint. */
export type DbOrTx = Db | Tx

export interface Actor {
  /** null only for imported history whose user could not be identified. */
  id: string | null
  name: string
}
